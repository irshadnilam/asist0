"""File storage operations backed by Firebase Cloud Storage + Firestore.

This module provides CRUD functions for managing user files. Each function
updates both:
  - Firestore (metadata index for fast listing/search)
  - Cloud Storage (actual file blobs)

Storage layout:
  gs://{bucket}/users/{uid}/{path...}

Firestore layout:
  users/{uid}/files/{auto_id}  →  { id, size, date, type }

The `id` field is the user-relative path (e.g. "/workspace-1/readme.md"),
matching the format expected by @svar-ui/react-filemanager.

All functions are synchronous (use firebase_admin's blocking clients).
Wrap in asyncio.to_thread() when calling from async FastAPI handlers.
"""

import datetime
import logging
import posixpath
from typing import Any

import firebase_admin
from firebase_admin import firestore, storage
from google.cloud.firestore_v1 import FieldFilter

logger = logging.getLogger(__name__)


def _ensure_app() -> None:
    """Ensure Firebase Admin is initialized."""
    if not firebase_admin._apps:
        firebase_admin.initialize_app()


def _db():
    """Get Firestore client."""
    _ensure_app()
    return firestore.client()


def _bucket(bucket_name: str | None = None):
    """Get Cloud Storage bucket."""
    _ensure_app()
    return storage.bucket(bucket_name)


def _files_col(user_id: str):
    """Get the files subcollection for a user."""
    return _db().collection("users").document(user_id).collection("files")


def _storage_path(user_id: str, file_id: str) -> str:
    """Convert a user-relative file id (e.g. '/ws/readme.md') to a storage path."""
    # Strip leading slash, prepend users/{uid}/
    clean = file_id.lstrip("/")
    return f"users/{user_id}/{clean}"


def _find_doc(user_id: str, file_id: str):
    """Find the Firestore doc for a given file id. Returns (doc_ref, doc_snapshot) or (None, None)."""
    col = _files_col(user_id)
    docs = col.where(filter=FieldFilter("id", "==", file_id)).limit(1).get()
    for doc in docs:
        return doc.reference, doc
    return None, None


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_files(
    user_id: str,
    parent_id: str | None = None,
    bucket_name: str | None = None,
) -> list[dict[str, Any]]:
    """List files/folders. If parent_id is None, returns root-level items.
    If parent_id is given (e.g. '/workspace-1'), returns direct children.

    Returns list of dicts matching SVAR Filemanager data format:
      { id, size, date, type, lazy? }
    """
    col = _files_col(user_id)

    if parent_id is None or parent_id in ("", "/"):
        # Root level: items whose id matches "/{name}" (single path segment)
        # We fetch all and filter client-side since Firestore can't do regex
        logger.info(f"list_files: user={user_id}, parent=root")
        all_docs = col.get()
        results = []
        for doc in all_docs:
            data = doc.to_dict()
            fid = data.get("id", "")
            # Root items have exactly one segment: /something
            parts = fid.strip("/").split("/")
            if len(parts) == 1 and parts[0]:
                results.append(_format_file(data))
        logger.info(f"list_files: root returned {len(results)} items")
        return results
    else:
        # Children of parent_id: items whose id starts with parent_id + "/"
        # and have exactly one more segment
        logger.info(f"list_files: user={user_id}, parent={parent_id}")
        prefix = parent_id.rstrip("/") + "/"
        parent_depth = len(parent_id.strip("/").split("/"))
        all_docs = col.get()
        results = []
        for doc in all_docs:
            data = doc.to_dict()
            fid = data.get("id", "")
            if fid.startswith(prefix):
                parts = fid.strip("/").split("/")
                if len(parts) == parent_depth + 1:
                    results.append(_format_file(data))
        return results


def _format_file(data: dict) -> dict[str, Any]:
    """Format a Firestore doc into SVAR file format."""
    result = {
        "id": data["id"],
        "size": data.get("size", 0),
        "date": data.get("date"),
        "type": data.get("type", "file"),
    }
    if data.get("type") == "folder":
        result["lazy"] = True
    # Convert Firestore timestamp to ISO string if needed
    if hasattr(result["date"], "isoformat"):
        result["date"] = result["date"].isoformat()
    elif result["date"] is None:
        result["date"] = _now().isoformat()
    return result


def create_file(
    user_id: str,
    file_id: str,
    file_type: str = "folder",
    bucket_name: str | None = None,
) -> dict[str, Any]:
    """Create a new file or folder.

    Args:
        user_id: Firebase UID
        file_id: Full path like '/workspace-1' or '/workspace-1/notes.md'
        file_type: 'file' or 'folder'
        bucket_name: Optional storage bucket name

    Returns:
        The created file metadata dict.
    """
    now = _now()
    doc_data = {
        "id": file_id,
        "size": 0,
        "date": now,
        "type": file_type,
    }

    logger.info(f"create_file: user={user_id}, id={file_id}, type={file_type}")

    # Add to Firestore
    _files_col(user_id).add(doc_data)

    # Create blob in Storage
    bucket = _bucket(bucket_name)
    if file_type == "folder":
        path = _storage_path(user_id, file_id) + "/.keep"
        logger.info(f"create_file: uploading placeholder to {path}")
        blob = bucket.blob(path)
        blob.upload_from_string(b"", content_type="application/x-empty")
    else:
        path = _storage_path(user_id, file_id)
        logger.info(f"create_file: uploading empty file to {path}")
        blob = bucket.blob(path)
        blob.upload_from_string(b"", content_type="application/octet-stream")

    logger.info(f"create_file: done")
    return _format_file(doc_data)


def rename_file(
    user_id: str,
    file_id: str,
    new_name: str,
    bucket_name: str | None = None,
) -> dict[str, Any]:
    """Rename a file or folder.

    Args:
        file_id: Current path like '/workspace-1/old-name.md'
        new_name: Just the new name, e.g. 'new-name.md'

    Returns:
        Updated file metadata with new id.
    """
    parent = posixpath.dirname(file_id)
    new_id = posixpath.join(parent, new_name) if parent != "/" else f"/{new_name}"

    doc_ref, doc_snap = _find_doc(user_id, file_id)
    if not doc_ref:
        raise FileNotFoundError(f"File not found: {file_id}")

    data = doc_snap.to_dict()
    is_folder = data.get("type") == "folder"

    # Rename in Storage
    bucket = _bucket(bucket_name)
    old_prefix = _storage_path(user_id, file_id)
    new_prefix = _storage_path(user_id, new_id)

    if is_folder:
        # Rename all blobs under the folder prefix
        blobs = list(bucket.list_blobs(prefix=old_prefix + "/"))
        for blob in blobs:
            new_blob_name = new_prefix + blob.name[len(old_prefix) :]
            bucket.rename_blob(blob, new_blob_name)

        # Also rename all child Firestore docs
        _rename_children(user_id, file_id, new_id)
    else:
        # Single file
        old_blob = bucket.blob(old_prefix)
        if old_blob.exists():
            bucket.rename_blob(old_blob, new_prefix)

    # Update this doc
    now = _now()
    doc_ref.update({"id": new_id, "date": now})

    data["id"] = new_id
    data["date"] = now
    return _format_file(data)


def _rename_children(user_id: str, old_prefix: str, new_prefix: str) -> None:
    """Update all Firestore docs whose id starts with old_prefix."""
    col = _files_col(user_id)
    all_docs = col.get()
    for doc in all_docs:
        data = doc.to_dict()
        fid = data.get("id", "")
        if fid.startswith(old_prefix + "/"):
            new_fid = new_prefix + fid[len(old_prefix) :]
            doc.reference.update({"id": new_fid, "date": _now()})


def delete_files(
    user_id: str,
    file_ids: list[str],
    bucket_name: str | None = None,
) -> None:
    """Delete one or more files/folders.

    Deletes both Firestore metadata and Storage blobs.
    For folders, recursively deletes all children.
    """
    bucket = _bucket(bucket_name)
    col = _files_col(user_id)

    for file_id in file_ids:
        doc_ref, doc_snap = _find_doc(user_id, file_id)
        if not doc_ref:
            continue

        data = doc_snap.to_dict()
        is_folder = data.get("type") == "folder"

        if is_folder:
            # Delete all Storage blobs under this prefix
            prefix = _storage_path(user_id, file_id) + "/"
            blobs = list(bucket.list_blobs(prefix=prefix))
            for blob in blobs:
                blob.delete()

            # Delete all child Firestore docs
            all_docs = col.get()
            for doc in all_docs:
                d = doc.to_dict()
                if d.get("id", "").startswith(file_id + "/"):
                    doc.reference.delete()
        else:
            # Delete single blob
            blob = bucket.blob(_storage_path(user_id, file_id))
            if blob.exists():
                blob.delete()

        # Delete the doc itself
        doc_ref.delete()

    # Also delete the .keep placeholder if it exists
    for file_id in file_ids:
        keep_blob = bucket.blob(_storage_path(user_id, file_id) + "/.keep")
        if keep_blob.exists():
            keep_blob.delete()


def move_files(
    user_id: str,
    file_ids: list[str],
    target: str,
    copy: bool = False,
    bucket_name: str | None = None,
) -> list[dict[str, Any]]:
    """Move or copy files to a target folder.

    Args:
        file_ids: List of source paths
        target: Destination folder path (e.g. '/workspace-2')
        copy: If True, copy instead of move

    Returns:
        List of new file metadata dicts.
    """
    bucket = _bucket(bucket_name)
    results = []

    for file_id in file_ids:
        doc_ref, doc_snap = _find_doc(user_id, file_id)
        if not doc_ref:
            continue

        data = doc_snap.to_dict()
        name = posixpath.basename(file_id)
        new_id = posixpath.join(target, name) if target != "/" else f"/{name}"
        is_folder = data.get("type") == "folder"

        # Copy/move Storage blobs
        if is_folder:
            old_prefix = _storage_path(user_id, file_id)
            new_prefix = _storage_path(user_id, new_id)
            blobs = list(bucket.list_blobs(prefix=old_prefix + "/"))
            for blob in blobs:
                new_blob_name = new_prefix + blob.name[len(old_prefix) :]
                bucket.copy_blob(blob, bucket, new_blob_name)
                if not copy:
                    blob.delete()
        else:
            old_blob = bucket.blob(_storage_path(user_id, file_id))
            if old_blob.exists():
                new_blob_name = _storage_path(user_id, new_id)
                bucket.copy_blob(old_blob, bucket, new_blob_name)
                if not copy:
                    old_blob.delete()

        # Update Firestore
        now = _now()
        new_data = {
            "id": new_id,
            "size": data.get("size", 0),
            "date": now,
            "type": data.get("type", "file"),
        }

        if copy:
            _files_col(user_id).add(new_data)
        else:
            doc_ref.update({"id": new_id, "date": now})

        # Handle children for folders
        if is_folder:
            if copy:
                _copy_children(user_id, file_id, new_id)
            else:
                _rename_children(user_id, file_id, new_id)

        results.append(_format_file(new_data))

    return results


def _copy_children(user_id: str, old_prefix: str, new_prefix: str) -> None:
    """Copy all Firestore child docs from old_prefix to new_prefix."""
    col = _files_col(user_id)
    all_docs = col.get()
    for doc in all_docs:
        data = doc.to_dict()
        fid = data.get("id", "")
        if fid.startswith(old_prefix + "/"):
            new_fid = new_prefix + fid[len(old_prefix) :]
            new_data = dict(data)
            new_data["id"] = new_fid
            new_data["date"] = _now()
            col.add(new_data)


def upload_file(
    user_id: str,
    parent_id: str,
    filename: str,
    content: bytes,
    content_type: str = "application/octet-stream",
    bucket_name: str | None = None,
) -> dict[str, Any]:
    """Upload a file.

    Args:
        parent_id: Parent folder path (e.g. '/workspace-1')
        filename: File name (e.g. 'document.pdf')
        content: File content as bytes
        content_type: MIME type

    Returns:
        Created file metadata dict.
    """
    file_id = (
        posixpath.join(parent_id, filename) if parent_id != "/" else f"/{filename}"
    )
    now = _now()

    # Upload to Storage
    blob = _bucket(bucket_name).blob(_storage_path(user_id, file_id))
    blob.upload_from_string(content, content_type=content_type)

    # Check if metadata doc already exists (overwrite)
    doc_ref, doc_snap = _find_doc(user_id, file_id)
    doc_data = {
        "id": file_id,
        "size": len(content),
        "date": now,
        "type": "file",
    }

    if doc_ref:
        doc_ref.update(doc_data)
    else:
        _files_col(user_id).add(doc_data)

    return _format_file(doc_data)


def download_file_content(
    user_id: str,
    file_id: str,
    bucket_name: str | None = None,
) -> tuple[bytes, str]:
    """Download file content from Storage.

    Returns:
        Tuple of (content_bytes, content_type).
    """
    blob = _bucket(bucket_name).blob(_storage_path(user_id, file_id))
    if not blob.exists():
        raise FileNotFoundError(f"File not found in storage: {file_id}")

    blob.reload()
    content = blob.download_as_bytes()
    content_type = blob.content_type or "application/octet-stream"
    return content, content_type


def get_drive_info(user_id: str) -> dict[str, Any]:
    """Get storage usage info for a user.

    Returns:
        { used: int, total: int } in bytes.
    """
    col = _files_col(user_id)
    all_docs = col.get()
    used = sum(doc.to_dict().get("size", 0) for doc in all_docs)

    # 1 GB quota per user (configurable)
    total = 1_073_741_824  # 1 GB

    return {"used": used, "total": total}


def read_file(
    user_id: str,
    file_id: str,
    bucket_name: str | None = None,
) -> bytes:
    """Read file content from Storage.

    Returns:
        File content as bytes.
    """
    blob = _bucket(bucket_name).blob(_storage_path(user_id, file_id))
    if not blob.exists():
        raise FileNotFoundError(f"File not found in storage: {file_id}")
    return blob.download_as_bytes()


def write_file(
    user_id: str,
    file_id: str,
    content: bytes,
    content_type: str = "application/octet-stream",
    bucket_name: str | None = None,
) -> dict[str, Any]:
    """Write/overwrite file content in Storage and update metadata.

    Returns:
        Updated file metadata dict.
    """
    now = _now()

    # Upload to Storage
    blob = _bucket(bucket_name).blob(_storage_path(user_id, file_id))
    blob.upload_from_string(content, content_type=content_type)

    # Update or create Firestore doc
    doc_ref, _ = _find_doc(user_id, file_id)
    doc_data = {
        "id": file_id,
        "size": len(content),
        "date": now,
        "type": "file",
    }

    if doc_ref:
        doc_ref.update(doc_data)
    else:
        _files_col(user_id).add(doc_data)

    return _format_file(doc_data)


# ---------------------------------------------------------------------------
# Default skills — seeded for every new user
# ---------------------------------------------------------------------------

_DEFAULT_SKILLS: dict[str, dict[str, str]] = {
    "prompt-helper": {
        "SKILL.md": (
            "---\n"
            "name: prompt-helper\n"
            "description: Helps craft better prompts for AI models."
            " Use when the user asks for help writing, improving,"
            " or structuring a prompt.\n"
            "---\n"
            "You are a prompt engineering expert."
            " When the user asks for help with a prompt:\n\n"
            "Step 1: Understand what the user wants the prompt to achieve.\n"
            "Step 2: Apply these principles:\n"
            "  - Be specific and explicit about the desired output format\n"
            "  - Provide context and constraints\n"
            "  - Use examples when helpful (few-shot)\n"
            "  - Break complex tasks into steps\n"
            "  - Specify the role/persona for the AI\n"
            "Step 3: Present the improved prompt clearly.\n"
            "Step 4: Explain what you changed and why.\n"
        ),
    },
    "code-review": {
        "SKILL.md": (
            "---\n"
            "name: code-review\n"
            "description: Reviews code for bugs, security issues, and best"
            " practices. Use when the user asks for a code review or wants"
            " feedback on code.\n"
            "---\n"
            "You are a senior software engineer performing a code review.\n\n"
            "Step 1: Read the code carefully.\n"
            "Step 2: Check the 'references/checklist.md' for the review criteria.\n"
            "Step 3: Analyze the code against each criterion.\n"
            "Step 4: Provide feedback organized by severity:\n"
            "  - **Critical**: Bugs, security vulnerabilities, data loss risks\n"
            "  - **Warning**: Performance issues, potential edge cases, maintainability\n"
            "  - **Suggestion**: Style improvements, readability, best practices\n"
            "Step 5: For each issue, provide the specific line/section and a suggested fix.\n"
        ),
        "references/checklist.md": (
            "# Code Review Checklist\n\n"
            "## Correctness\n"
            "- Does the code do what it's supposed to?\n"
            "- Are edge cases handled (null, empty, boundary values)?\n"
            "- Are error conditions handled properly?\n\n"
            "## Security\n"
            "- Is user input validated/sanitized?\n"
            "- Are secrets hardcoded?\n"
            "- Is authentication/authorization checked?\n\n"
            "## Performance\n"
            "- Are there unnecessary loops or redundant operations?\n"
            "- Could any operations be batched?\n"
            "- Are there potential memory leaks?\n\n"
            "## Readability\n"
            "- Are variable/function names descriptive?\n"
            "- Is the code self-documenting or well-commented?\n"
            "- Is the structure logical and easy to follow?\n\n"
            "## Best Practices\n"
            "- DRY (Don't Repeat Yourself)\n"
            "- Single Responsibility Principle\n"
            "- Proper error handling (not swallowing exceptions)\n"
            "- Consistent formatting\n"
        ),
    },
    "summarize": {
        "SKILL.md": (
            "---\n"
            "name: summarize\n"
            "description: Summarizes text, documents, or conversations into"
            " concise overviews. Use when the user asks for a summary or wants"
            " to condense information.\n"
            "---\n"
            "You are an expert at distilling information into clear, concise summaries.\n\n"
            "Step 1: Read the full content provided by the user.\n"
            "Step 2: Identify the key themes, arguments, and conclusions.\n"
            "Step 3: Produce a summary following this structure:\n"
            "  - **One-line summary**: A single sentence capturing the essence\n"
            "  - **Key points**: 3-5 bullet points with the most important takeaways\n"
            "  - **Details**: A short paragraph expanding on nuances (if needed)\n"
            "Step 4: Adjust length based on the user's request (brief, detailed, etc.).\n"
        ),
    },
}


def seed_default_files(
    user_id: str,
    bucket_name: str | None = None,
) -> list[dict[str, Any]]:
    """Seed a new user's storage with default skills folder and sample skills.

    Only runs if the user has zero files. Returns the list of created items.
    """
    col = _files_col(user_id)
    existing = col.limit(1).get()
    if list(existing):
        return []

    logger.info(f"seed_default_files: seeding defaults for user {user_id}")
    bucket = _bucket(bucket_name)
    now = _now()
    created: list[dict[str, Any]] = []

    def _mk_folder(file_id: str) -> None:
        doc_data = {"id": file_id, "size": 0, "date": now, "type": "folder"}
        col.add(doc_data)
        blob = bucket.blob(_storage_path(user_id, file_id) + "/.keep")
        blob.upload_from_string(b"", content_type="application/x-empty")
        created.append(_format_file(doc_data))

    def _mk_file(file_id: str, content: str, ct: str = "text/markdown") -> None:
        content_bytes = content.encode("utf-8")
        doc_data = {
            "id": file_id,
            "size": len(content_bytes),
            "date": now,
            "type": "file",
        }
        col.add(doc_data)
        blob = bucket.blob(_storage_path(user_id, file_id))
        blob.upload_from_string(content_bytes, content_type=ct)
        created.append(_format_file(doc_data))

    _mk_folder("/skills")

    for skill_name, files in _DEFAULT_SKILLS.items():
        skill_dir = f"/skills/{skill_name}"
        _mk_folder(skill_dir)

        for file_path, content in files.items():
            full_path = f"{skill_dir}/{file_path}"
            parts = file_path.split("/")
            if len(parts) > 1:
                subdir = f"{skill_dir}/{parts[0]}"
                if not any(c.get("id") == subdir for c in created):
                    _mk_folder(subdir)
            _mk_file(full_path, content)

    logger.info(f"seed_default_files: created {len(created)} items for user {user_id}")
    return created
