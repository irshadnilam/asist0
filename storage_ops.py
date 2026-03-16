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


def list_all_files(
    user_id: str,
    bucket_name: str | None = None,
) -> list[dict[str, Any]]:
    """List ALL files for a user (flat list, all depths).

    Used by search and info tools. Returns every file/folder.
    """
    col = _files_col(user_id)
    all_docs = col.get()
    return [_format_file(doc.to_dict()) for doc in all_docs]


def get_file_info(
    user_id: str,
    file_id: str,
    bucket_name: str | None = None,
) -> dict[str, Any] | None:
    """Get metadata for a specific file by path.

    Returns formatted file dict or None if not found.
    """
    _, doc = _find_doc(user_id, file_id)
    if doc and doc.exists:
        return _format_file(doc.to_dict())
    return None


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
    "workspace-helper": {
        "SKILL.md": (
            "---\n"
            "name: workspace-helper\n"
            "description: Helps organize the workspace — scaffolds projects,"
            " cleans up files, creates folder structures, and manages the file tree."
            " Use when the user asks to organize, set up, clean, or restructure"
            " their workspace.\n"
            "---\n"
            "You help the user organize their workspace.\n\n"
            "When the user asks to organize or set up a project:\n"
            "1. Use list_files to understand the current state.\n"
            "2. Propose a folder structure before creating anything.\n"
            "3. Create folders and files only after the user confirms.\n"
            "4. When scaffolding, create real content — not empty placeholder files.\n\n"
            "When the user asks to clean up:\n"
            "1. List all files and identify candidates (empty files, duplicates, temp files).\n"
            "2. Present the list and ask which to delete.\n"
            "3. Never delete without confirmation.\n\n"
            "Common structures to suggest:\n"
            "- `/docs/` — documentation and notes\n"
            "- `/projects/{name}/` — project files\n"
            "- `/skills/` — agent skills (already exists)\n"
            "- `/archive/` — old or completed work\n"
        ),
    },
    "code-review": {
        "SKILL.md": (
            "---\n"
            "name: code-review\n"
            "description: Reviews code for bugs, security issues, and best"
            " practices. Use when the user asks for a code review, wants"
            " feedback on code, or asks you to check a file.\n"
            "---\n"
            "You are a senior software engineer performing a code review.\n\n"
            "Step 1: Use read_file to read the code the user wants reviewed.\n"
            "Step 2: Check 'references/checklist.md' for the review criteria.\n"
            "Step 3: Analyze the code against each criterion.\n"
            "Step 4: Provide feedback organized by severity:\n"
            "  - **Critical**: Bugs, security vulnerabilities, data loss risks\n"
            "  - **Warning**: Performance issues, potential edge cases\n"
            "  - **Suggestion**: Style, readability, best practices\n"
            "Step 5: For each issue, state the specific location and a suggested fix.\n"
            "Step 6: Offer to write the fixes directly using write_file.\n"
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
    "note-taker": {
        "SKILL.md": (
            "---\n"
            "name: note-taker\n"
            "description: Takes notes, writes documentation, and captures"
            " ideas. Use when the user asks you to write down something,"
            " take notes, create a document, summarize something into a file,"
            " or draft text.\n"
            "---\n"
            "You help the user capture and organize information as files.\n\n"
            "When taking notes:\n"
            "1. Ask where to save (suggest /docs/ or /notes/ if no preference).\n"
            "2. Use clear markdown formatting: headings, bullet points, code blocks.\n"
            "3. Write the note immediately using write_file — don't just read it back.\n"
            "4. Confirm: 'Written to /docs/filename.md'\n\n"
            "When summarizing to a file:\n"
            "1. First produce the summary in conversation.\n"
            "2. Then offer to save it: 'Want me to save this to a file?'\n"
            "3. If yes, write it immediately.\n\n"
            "When drafting longer documents:\n"
            "1. Write a first draft and save it.\n"
            "2. Read it back and discuss changes.\n"
            "3. Use write_file to apply revisions.\n"
            "4. The user can also edit the file directly in their editor"
            " — offer to read and review their changes.\n"
        ),
    },
    "learn-skill": {
        "SKILL.md": (
            "---\n"
            "name: learn-skill\n"
            "description: >-\n"
            "  Creates new skills or improves existing ones. Use when the user says\n"
            "  'learn this', 'remember how to', 'teach you', 'add a skill',\n"
            "  'create a skill', 'you should know how to', or when you identify a\n"
            "  repeated workflow worth capturing.\n"
            "---\n"
            "You are building a new skill for yourself. Skills persist across sessions\n"
            "and make you better at helping the user over time.\n\n"
            "## Creating a New Skill\n\n"
            "Step 1: Clarify the skill with the user.\n"
            "  - What should the skill do? (the WHAT)\n"
            "  - When should you use it? (the WHEN — trigger phrases/contexts)\n"
            "  - How should it work? (the HOW — step-by-step process)\n"
            "  - Does it need reference materials, templates, or scripts?\n\n"
            "Step 2: Choose a short, lowercase, hyphenated name (e.g. 'api-tester').\n\n"
            "Step 3: Create the skill directory structure:\n"
            "  a. create_folder '/skills/{name}'\n"
            "  b. write_file '/skills/{name}/SKILL.md' with proper frontmatter + instructions\n"
            "  c. If references needed: create_folder '/skills/{name}/references'\n"
            "     then write_file each reference document\n"
            "  d. If scripts needed: create_folder '/skills/{name}/scripts'\n"
            "     then write_file each .py or .sh script\n"
            "  e. If templates/assets needed: create_folder '/skills/{name}/assets'\n"
            "     then write_file each asset\n\n"
            "Step 4: Read back the SKILL.md to verify it's well-formed.\n\n"
            "Step 5: Tell the user: 'Skill created. It will be active next session,\n"
            "  or you can reconnect to load it now.'\n\n"
            "## SKILL.md Template\n\n"
            "Use this exact format:\n\n"
            "```\n"
            "---\n"
            "name: {skill-name}\n"
            "description: >-\n"
            "  Clear description of WHEN to use this skill. Include trigger phrases\n"
            "  like 'Use when the user asks to...' or 'Use when...'.\n"
            "---\n"
            "Context about the skill's purpose.\n\n"
            "Step 1: ...\n"
            "Step 2: ...\n"
            "(Use actual tool names: read_file, write_file, list_files, search_files, etc.)\n"
            "```\n\n"
            "## Writing Skill Scripts\n\n"
            "Scripts in `/scripts/` run in a sandbox (Python or shell).\n"
            "Use scripts for:\n"
            "- Data processing or transformation\n"
            "- Calculations or analysis\n"
            "- Text formatting or conversion\n"
            "- Any logic easier in code than natural language\n\n"
            "Script requirements:\n"
            "- Python scripts must be self-contained (stdlib only)\n"
            "- Use print() for output the agent will read\n"
            "- Keep scripts focused — one task per script\n"
            "- Add a docstring explaining what the script does\n\n"
            "## Improving an Existing Skill\n\n"
            "Step 1: read_file '/skills/{name}/SKILL.md'\n"
            "Step 2: Discuss what needs improvement with the user.\n"
            "Step 3: write_file the updated SKILL.md (or references/scripts).\n"
            "Step 4: Confirm the changes.\n\n"
            "## Listing Skills\n\n"
            "If the user asks 'what skills do you have' or 'what can you do':\n"
            "1. list_files '/skills' to see all skill folders.\n"
            "2. For each, read_file the SKILL.md to get the name and description.\n"
            "3. Summarize: 'You have N skills: ...' with a one-liner per skill.\n"
        ),
        "references/skill-spec.md": (
            "# Agent Skills Specification Reference\n\n"
            "Based on https://agentskills.io/specification\n\n"
            "## Directory Structure\n\n"
            "```\n"
            "/skills/{skill-name}/\n"
            "  SKILL.md              <- Required: YAML frontmatter + markdown body\n"
            "  references/           <- Optional: detailed docs, checklists\n"
            "  assets/               <- Optional: templates, data files\n"
            "  scripts/              <- Optional: .py or .sh scripts\n"
            "```\n\n"
            "## SKILL.md Frontmatter Fields\n\n"
            "Required:\n"
            "- `name`: Short identifier (lowercase, hyphenated)\n"
            "- `description`: When to use this skill (be specific about triggers)\n\n"
            "Optional:\n"
            "- `metadata`: Key-value pairs for additional config\n\n"
            "## Best Practices\n\n"
            "1. **Trigger-first descriptions** — Start with 'Use when...'\n"
            "2. **Tool-aware instructions** — Reference actual tool names\n"
            "3. **Progressive detail** — Keep SKILL.md focused, put depth in references/\n"
            "4. **Testable steps** — Each step should produce a verifiable result\n"
            "5. **Error paths** — Include what to do when things go wrong\n"
            "6. **Confirmation gates** — Destructive actions need user approval\n"
        ),
        "scripts/scaffold_skill.py": (
            '"""Scaffold a new skill directory structure.\n\n'
            "Prints the list of files that need to be created for a new skill.\n"
            "The agent reads this output and uses write_file/create_folder to create them.\n"
            '"""\n\n'
            "import sys\n"
            "import json\n\n"
            "def scaffold(skill_name: str, has_references: bool = False,\n"
            "             has_scripts: bool = False, has_assets: bool = False) -> dict:\n"
            '    """Generate the file structure for a new skill."""\n'
            '    base = f"/skills/{skill_name}"\n'
            "    structure = {\n"
            '        "folders": [base],\n'
            '        "files": {\n'
            '            f"{base}/SKILL.md": (\n'
            '                f"---\\n"\n'
            '                f"name: {skill_name}\\n"\n'
            '                f"description: >-\\n"\n'
            '                f"  TODO: Describe when to use this skill.\\n"\n'
            '                f"---\\n"\n'
            '                f"TODO: Step-by-step instructions.\\n"\n'
            "            ),\n"
            "        },\n"
            "    }\n"
            "    if has_references:\n"
            '        structure["folders"].append(f"{base}/references")\n'
            "    if has_scripts:\n"
            '        structure["folders"].append(f"{base}/scripts")\n'
            "    if has_assets:\n"
            '        structure["folders"].append(f"{base}/assets")\n'
            "    return structure\n\n"
            'if __name__ == "__main__":\n'
            '    name = sys.argv[1] if len(sys.argv) > 1 else "new-skill"\n'
            "    result = scaffold(name,\n"
            '        has_references="--references" in sys.argv,\n'
            '        has_scripts="--scripts" in sys.argv,\n'
            '        has_assets="--assets" in sys.argv)\n'
            "    print(json.dumps(result, indent=2))\n"
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
