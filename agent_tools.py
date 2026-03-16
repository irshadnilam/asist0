"""Agent file-operation and image-generation tools backed by storage_ops.

These tools let the Asisto agent create, read, write, list, search, copy,
and delete files in the user's Firebase Storage workspace via voice commands.
Image tools use Gemini's native image generation (Nano Banana 2) to generate
and edit images, saving results directly to the user's workspace.

Each tool is a plain Python function (closure) that captures the user_id
and bucket_name from the session context. ADK auto-wraps them as FunctionTools.

Usage:
    tools = create_file_tools(user_id="abc123", bucket_name="my-bucket")
    agent = Agent(tools=tools + [...])
"""

import logging
import posixpath
import re
from typing import Any

from google import genai
from google.genai import types

import storage_ops

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Image generation constants
# ---------------------------------------------------------------------------

IMAGE_MODEL = "gemini-2.5-flash-image"

VALID_ASPECT_RATIOS = {
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9",
}

# Module-level genai client — reused across all tool calls.
# Picks up GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_CLOUD_PROJECT,
# and GOOGLE_CLOUD_LOCATION from environment automatically.
_genai_client: genai.Client | None = None


def _get_genai_client() -> genai.Client:
    """Get or create the module-level genai client."""
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client()
        logger.info("Created genai.Client for image generation")
    return _genai_client


def _slugify(text: str, max_len: int = 60) -> str:
    """Convert a prompt string to a filesystem-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"[\s-]+", "-", slug)
    return slug[:max_len].rstrip("-") or "image"


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

    # -------------------------------------------------------------------
    # Image generation & editing tools
    # -------------------------------------------------------------------

    def generate_image(
        prompt: str,
        save_path: str = "",
        aspect_ratio: str = "1:1",
    ) -> str:
        """Generate an image from a text description and save it to the workspace.

        Use this when the user asks you to create, generate, draw, design, or
        make an image, picture, photo, illustration, logo, icon, sticker, etc.

        The model (Nano Banana) excels at photorealistic scenes, illustrations,
        logos with text, product mockups, infographics, and style-specific art.
        Output is 1024px resolution.

        Tips for better results:
        - Describe the scene narratively, don't just list keywords.
        - Include style, lighting, camera angle, and mood details.
        - For text in images, specify font style and placement.
        - Use aspect_ratio to match the intended use (16:9 for banners, 1:1 for icons, 9:16 for phone wallpapers).

        Args:
            prompt: Detailed description of the image to generate.
            save_path: Where to save in the workspace. Defaults to "/images/{slugified-prompt}.png".
                Must end in .png or .jpg.
            aspect_ratio: Output aspect ratio. One of: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Default "1:1".

        Returns:
            Confirmation message with the saved file path, or an error message.
        """
        logger.info(f"[tool] generate_image: user={user_id}, prompt={prompt[:80]}...")

        # Validate and default save_path
        if not save_path:
            slug = _slugify(prompt)
            save_path = f"/images/{slug}.png"
        if not save_path.startswith("/"):
            save_path = "/" + save_path

        # Validate aspect_ratio
        if aspect_ratio not in VALID_ASPECT_RATIOS:
            return f"Error: Invalid aspect_ratio '{aspect_ratio}'. Must be one of: {', '.join(sorted(VALID_ASPECT_RATIOS))}"

        try:
            client = _get_genai_client()

            response = client.models.generate_content(
                model=IMAGE_MODEL,
                contents=[prompt],
                config=types.GenerateContentConfig(
                    response_modalities=["TEXT", "IMAGE"],
                    image_config=types.ImageConfig(
                        aspect_ratio=aspect_ratio,
                    ),
                ),
            )

            # Extract the generated image from response parts
            image_bytes = None
            text_response = ""
            for part in response.parts or []:
                if part.text is not None:
                    text_response = part.text
                elif part.inline_data is not None:
                    # Get raw image bytes from inline_data
                    image_bytes = part.inline_data.data

            if image_bytes is None:
                logger.warning(f"[tool] generate_image: no image in response")
                return f"Error: The model did not return an image. It said: {text_response or '(no response)'}"

            # Ensure /images folder exists
            parent_dir = posixpath.dirname(save_path)
            if parent_dir and parent_dir != "/":
                info = storage_ops.get_file_info(user_id, parent_dir, bucket_name)
                if not info:
                    storage_ops.create_file(user_id, parent_dir, "folder", bucket_name)

            # Save to workspace
            result = storage_ops.upload_file(
                user_id=user_id,
                parent_id=posixpath.dirname(save_path),
                filename=posixpath.basename(save_path),
                content=image_bytes,
                content_type="image/png",
                bucket_name=bucket_name,
            )

            size_kb = round(result.get("size", len(image_bytes)) / 1024, 1)
            msg = f"Image generated and saved to {result['id']} ({size_kb} KB, {aspect_ratio})"
            if text_response:
                msg += f". Model note: {text_response[:200]}"
            logger.info(f"[tool] generate_image: saved {result['id']}")
            return msg

        except Exception as e:
            logger.error(f"[tool] generate_image failed: {e}")
            return f"Error generating image: {e}"

    def edit_image(
        source_path: str,
        prompt: str,
        save_path: str = "",
        aspect_ratio: str = "",
    ) -> str:
        """Edit an existing image using text instructions and save the result.

        Use this when the user asks you to modify, edit, change, update, transform,
        add to, remove from, or restyle an existing image in their workspace.

        The model can: add/remove elements, change styles, transfer artistic styles,
        do inpainting (change specific parts), adjust colors/lighting, combine
        elements from the image with new ones, and more.

        Tips for better edits:
        - Be specific about what to change and what to keep unchanged.
        - Reference specific elements: "change the blue sofa to brown leather"
        - For inpainting: "change only the X to Y, keep everything else the same"
        - For style transfer: "transform this into the style of [artist/style]"

        Args:
            source_path: Full path of the source image in the workspace, e.g. "/images/logo.png".
            prompt: Detailed edit instructions describing what to change.
            save_path: Where to save the edited image. Defaults to same as source_path (overwrites).
                Set a different path to keep the original.
            aspect_ratio: Output aspect ratio. Leave empty to match the source image.
                One of: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.

        Returns:
            Confirmation message with the saved file path, or an error message.
        """
        logger.info(
            f"[tool] edit_image: user={user_id}, source={source_path}, prompt={prompt[:80]}..."
        )

        # Default save_path to source_path (overwrite)
        if not save_path:
            save_path = source_path
        if not save_path.startswith("/"):
            save_path = "/" + save_path

        # Validate aspect_ratio if provided
        if aspect_ratio and aspect_ratio not in VALID_ASPECT_RATIOS:
            return f"Error: Invalid aspect_ratio '{aspect_ratio}'. Must be one of: {', '.join(sorted(VALID_ASPECT_RATIOS))}"

        try:
            # Read source image from workspace
            try:
                source_bytes = storage_ops.read_file(user_id, source_path, bucket_name)
            except FileNotFoundError:
                return f"Error: Source image not found: {source_path}"

            # Determine MIME type from extension
            ext = (
                source_path.rsplit(".", 1)[-1].lower() if "." in source_path else "png"
            )
            mime_map = {
                "png": "image/png",
                "jpg": "image/jpeg",
                "jpeg": "image/jpeg",
                "gif": "image/gif",
                "webp": "image/webp",
            }
            mime_type = mime_map.get(ext, "image/png")

            # Build content parts: image + text prompt
            image_part = types.Part(
                inline_data=types.Blob(
                    mime_type=mime_type,
                    data=source_bytes,
                )
            )
            text_part = types.Part(text=prompt)

            # Build image config
            if aspect_ratio:
                image_config = types.ImageConfig(
                    aspect_ratio=aspect_ratio,
                )
            else:
                image_config = types.ImageConfig()

            client = _get_genai_client()

            response = client.models.generate_content(
                model=IMAGE_MODEL,
                contents=[image_part, text_part],
                config=types.GenerateContentConfig(
                    response_modalities=["TEXT", "IMAGE"],
                    image_config=image_config,
                ),
            )

            # Extract the edited image from response parts
            image_bytes = None
            text_response = ""
            for part in response.parts or []:
                if part.text is not None:
                    text_response = part.text
                elif part.inline_data is not None:
                    image_bytes = part.inline_data.data

            if image_bytes is None:
                logger.warning(f"[tool] edit_image: no image in response")
                return f"Error: The model did not return an edited image. It said: {text_response or '(no response)'}"

            # Ensure parent folder exists
            parent_dir = posixpath.dirname(save_path)
            if parent_dir and parent_dir != "/":
                info = storage_ops.get_file_info(user_id, parent_dir, bucket_name)
                if not info:
                    storage_ops.create_file(user_id, parent_dir, "folder", bucket_name)

            # Save to workspace
            result = storage_ops.upload_file(
                user_id=user_id,
                parent_id=posixpath.dirname(save_path),
                filename=posixpath.basename(save_path),
                content=image_bytes,
                content_type="image/png",
                bucket_name=bucket_name,
            )

            size_kb = round(result.get("size", len(image_bytes)) / 1024, 1)
            overwrite_note = (
                " (original overwritten)" if save_path == source_path else ""
            )
            ar_note = f", {aspect_ratio}" if aspect_ratio else ""
            msg = f"Image edited and saved to {result['id']} ({size_kb} KB{ar_note}){overwrite_note}"
            if text_response:
                msg += f". Model note: {text_response[:200]}"
            logger.info(f"[tool] edit_image: saved {result['id']}")
            return msg

        except Exception as e:
            logger.error(f"[tool] edit_image failed: {e}")
            return f"Error editing image: {e}"

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
        generate_image,
        edit_image,
    ]
