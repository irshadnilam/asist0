"""Agent file-operation tools backed by storage_ops.

These tools let the Asisto agent create, read, write, list, search, copy,
and delete files in the user's Firebase Storage workspace via voice commands.

Each tool is a plain Python function (closure) that captures the user_id
and bucket_name from the session context. ADK auto-wraps them as FunctionTools.

Usage:
    tools = create_file_tools(user_id="abc123", bucket_name="my-bucket")
    agent = Agent(tools=tools + [...])
"""

import logging
import posixpath
from typing import Any

import storage_ops

logger = logging.getLogger(__name__)


def create_file_tools(
    user_id: str,
    bucket_name: str | None = None,
) -> list:
    """Create file-operation tool functions for a specific user session.

    Args:
        user_id: Firebase UID of the authenticated user.
        bucket_name: Optional storage bucket name.

    Returns:
        List of callable tool functions ready to pass to Agent(tools=[...]).
    """

    def list_files(path: str = "/") -> list[dict[str, Any]]:
        """List files and folders at the given path.

        Use this to see what files exist in a directory.
        Pass "/" for root level, or a folder path like "/skills" to list its contents.

        Args:
            path: Directory path to list. Defaults to "/" (root).

        Returns:
            List of file/folder entries with id, size, date, and type fields.
        """
        logger.info(f"[tool] list_files: user={user_id}, path={path}")
        parent = path if path != "/" else None
        return storage_ops.list_files(user_id, parent, bucket_name)

    def read_file(path: str) -> str:
        """Read the text content of a file.

        Use this to read the contents of text files like .md, .txt, .py, .json, etc.
        Do NOT use this for binary files like images.

        Args:
            path: Full file path, e.g. "/skills/prompt-helper/SKILL.md"

        Returns:
            The file content as a string.
        """
        logger.info(f"[tool] read_file: user={user_id}, path={path}")
        try:
            content_bytes = storage_ops.read_file(user_id, path, bucket_name)
            return content_bytes.decode("utf-8")
        except FileNotFoundError:
            return f"Error: File not found: {path}"
        except UnicodeDecodeError:
            return f"Error: File is binary and cannot be read as text: {path}"

    def write_file(path: str, content: str) -> str:
        """Create or overwrite a text file with the given content.

        Use this to create new files or update existing ones.
        The file and any parent folders in the path will be created if needed.

        Args:
            path: Full file path, e.g. "/notes/todo.md"
            content: The text content to write to the file.

        Returns:
            Confirmation message with the file path.
        """
        logger.info(f"[tool] write_file: user={user_id}, path={path}")
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        ct_map = {
            "md": "text/markdown",
            "txt": "text/plain",
            "py": "text/x-python",
            "js": "text/javascript",
            "ts": "text/typescript",
            "json": "application/json",
            "html": "text/html",
            "css": "text/css",
            "yaml": "text/yaml",
            "yml": "text/yaml",
            "xml": "text/xml",
            "sh": "text/x-shellscript",
        }
        content_type = ct_map.get(ext, "text/plain")

        result = storage_ops.write_file(
            user_id, path, content.encode("utf-8"), content_type, bucket_name
        )
        return f"File written: {result['id']} ({result['size']} bytes)"

    def create_folder(path: str) -> str:
        """Create a new folder.

        Args:
            path: Full folder path, e.g. "/projects" or "/skills/my-skill"

        Returns:
            Confirmation message with the folder path.
        """
        logger.info(f"[tool] create_folder: user={user_id}, path={path}")
        result = storage_ops.create_file(user_id, path, "folder", bucket_name)
        return f"Folder created: {result['id']}"

    def delete_file(path: str) -> str:
        """Delete a file or folder (and all its contents).

        WARNING: Deletion is permanent. Always confirm with the user first.

        Args:
            path: Full path of the file or folder to delete, e.g. "/notes/old.md"

        Returns:
            Confirmation message.
        """
        logger.info(f"[tool] delete_file: user={user_id}, path={path}")
        storage_ops.delete_files(user_id, [path], bucket_name)
        return f"Deleted: {path}"

    def rename_file(path: str, new_name: str) -> str:
        """Rename a file or folder.

        Only changes the name, not the location. To move a file, use move_file.

        Args:
            path: Current full path, e.g. "/notes/old-name.md"
            new_name: New name (just the filename, not a path), e.g. "new-name.md"

        Returns:
            Confirmation message with old and new paths.
        """
        logger.info(
            f"[tool] rename_file: user={user_id}, path={path}, new_name={new_name}"
        )
        try:
            result = storage_ops.rename_file(user_id, path, new_name, bucket_name)
            return f"Renamed: {path} -> {result['id']}"
        except FileNotFoundError:
            return f"Error: File not found: {path}"

    def move_file(path: str, destination: str) -> str:
        """Move a file or folder to a different directory.

        Args:
            path: Current full path of the file/folder to move.
            destination: Target folder path to move into, e.g. "/" or "/archive"

        Returns:
            Confirmation message with new location.
        """
        logger.info(
            f"[tool] move_file: user={user_id}, path={path}, dest={destination}"
        )
        results = storage_ops.move_files(
            user_id, [path], destination, copy=False, bucket_name=bucket_name
        )
        if results:
            return f"Moved: {path} -> {results[0]['id']}"
        return f"Error: Could not move {path}"

    def copy_file(path: str, destination: str) -> str:
        """Copy a file or folder to a different directory.

        The original stays in place. A copy is created in the destination.

        Args:
            path: Full path of the file/folder to copy, e.g. "/skills/prompt-helper"
            destination: Target folder path, e.g. "/" or "/backups"

        Returns:
            Confirmation message with the new copy's location.
        """
        logger.info(
            f"[tool] copy_file: user={user_id}, path={path}, dest={destination}"
        )
        results = storage_ops.move_files(
            user_id, [path], destination, copy=True, bucket_name=bucket_name
        )
        if results:
            return f"Copied: {path} -> {results[0]['id']}"
        return f"Error: Could not copy {path}"

    def search_files(query: str) -> list[dict[str, Any]]:
        """Search for files by name across the entire workspace.

        Searches all files and folders, matching against the filename or path.
        Case-insensitive partial match.

        Use this when the user asks "find", "search", "where is", "do I have",
        or refers to a file by partial name.

        Args:
            query: Search term to match against file paths/names, e.g. "readme" or ".py"

        Returns:
            List of matching file entries with id, size, date, and type.
        """
        logger.info(f"[tool] search_files: user={user_id}, query={query}")
        all_files = storage_ops.list_all_files(user_id, bucket_name)
        q = query.lower()
        matches = [
            f
            for f in all_files
            if q in f["id"].lower() or q in posixpath.basename(f["id"]).lower()
        ]
        return matches

    def get_file_info(path: str) -> dict[str, Any]:
        """Get metadata about a specific file or folder.

        Returns size, date, type, and full path. Useful when the user asks
        "how big is this file" or "when was this created".

        Args:
            path: Full file path, e.g. "/readme.md"

        Returns:
            Dict with id, size, date, and type — or error message.
        """
        logger.info(f"[tool] get_file_info: user={user_id}, path={path}")
        info = storage_ops.get_file_info(user_id, path, bucket_name)
        if info:
            return info
        return {"error": f"File not found: {path}"}

    def get_storage_usage() -> dict[str, Any]:
        """Get the user's storage usage.

        Returns used and total storage in bytes. Useful when the user asks
        "how much space do I have" or "am I running out of storage".

        Returns:
            Dict with used (bytes), total (bytes), and used_pct (percentage).
        """
        logger.info(f"[tool] get_storage_usage: user={user_id}")
        info = storage_ops.get_drive_info(user_id)
        used = info.get("used", 0)
        total = info.get("total", 1_073_741_824)
        pct = round(used / total * 100, 1) if total > 0 else 0
        return {"used": used, "total": total, "used_pct": pct}

    return [
        list_files,
        read_file,
        write_file,
        create_folder,
        delete_file,
        rename_file,
        move_file,
        copy_file,
        search_files,
        get_file_info,
        get_storage_usage,
    ]
