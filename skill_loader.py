"""Load user-defined skills from Firebase Storage.

Reads a user's /skills/ directory from Cloud Storage and parses each
skill subdirectory (following the Agent Skills specification) into
ADK Skill objects that can be used with SkillToolset.

Storage layout:
  gs://{bucket}/users/{uid}/skills/{skill-name}/SKILL.md
  gs://{bucket}/users/{uid}/skills/{skill-name}/references/*.md
  gs://{bucket}/users/{uid}/skills/{skill-name}/assets/*
  gs://{bucket}/users/{uid}/skills/{skill-name}/scripts/*.py

The SKILL.md format follows https://agentskills.io/specification:
  ---
  name: skill-name
  description: What this skill does and when to use it.
  ---
  Step-by-step instructions for the agent...
"""

import logging
import re
from typing import Any

import yaml
from firebase_admin import storage as fb_storage

from google.adk.skills import models as skill_models

logger = logging.getLogger(__name__)


def _bucket(bucket_name: str | None = None):
    """Get Cloud Storage bucket."""
    return fb_storage.bucket(bucket_name)


def _parse_skill_md(content: str) -> tuple[dict[str, Any], str]:
    """Parse a SKILL.md file into frontmatter dict and body instructions.

    Returns:
        Tuple of (frontmatter_dict, instructions_body).
    """
    # Match YAML frontmatter between --- delimiters
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", content, re.DOTALL)
    if not match:
        # No frontmatter — treat entire content as instructions
        return {}, content.strip()

    frontmatter_str = match.group(1)
    body = match.group(2).strip()

    try:
        frontmatter = yaml.safe_load(frontmatter_str) or {}
    except yaml.YAMLError as e:
        logger.warning(f"Failed to parse SKILL.md frontmatter: {e}")
        frontmatter = {}

    return frontmatter, body


def load_user_skills(
    user_id: str,
    bucket_name: str | None = None,
) -> list[skill_models.Skill]:
    """Load all skills from a user's /skills/ directory in Cloud Storage.

    Scans gs://{bucket}/users/{uid}/skills/ for subdirectories containing
    SKILL.md files, and parses them into ADK Skill objects.

    Args:
        user_id: Firebase UID.
        bucket_name: Optional storage bucket name.

    Returns:
        List of ADK Skill objects ready for SkillToolset.
    """
    bucket = _bucket(bucket_name)
    prefix = f"users/{user_id}/skills/"

    # List all blobs under the skills prefix
    blobs = list(bucket.list_blobs(prefix=prefix))
    if not blobs:
        logger.info(f"No skills found for user {user_id}")
        return []

    # Group blobs by skill directory name
    # e.g. "users/{uid}/skills/my-skill/SKILL.md" -> skill_name = "my-skill"
    skill_dirs: dict[str, dict[str, bytes]] = {}
    for blob in blobs:
        # Remove the prefix to get relative path: "my-skill/SKILL.md"
        rel_path = blob.name[len(prefix) :]
        parts = rel_path.split("/", 1)
        if len(parts) < 2 or not parts[0]:
            continue
        skill_name = parts[0]
        file_path = parts[1]
        if skill_name not in skill_dirs:
            skill_dirs[skill_name] = {}
        # Download the blob content
        try:
            skill_dirs[skill_name][file_path] = blob.download_as_bytes()
        except Exception as e:
            logger.warning(f"Failed to download {blob.name}: {e}")

    # Parse each skill directory
    skills: list[skill_models.Skill] = []
    for skill_name, files in skill_dirs.items():
        skill = _parse_skill_dir(skill_name, files)
        if skill:
            skills.append(skill)
            logger.info(f"Loaded skill: {skill_name}")

    logger.info(f"Loaded {len(skills)} skills for user {user_id}")
    return skills


def _parse_skill_dir(
    skill_name: str,
    files: dict[str, bytes],
) -> skill_models.Skill | None:
    """Parse a skill directory's files into an ADK Skill object.

    Args:
        skill_name: Directory name (e.g. "my-skill").
        files: Dict of relative_path -> content_bytes.

    Returns:
        ADK Skill object, or None if SKILL.md is missing/invalid.
    """
    # SKILL.md is required
    skill_md_bytes = files.get("SKILL.md")
    if not skill_md_bytes:
        logger.warning(f"Skill '{skill_name}' missing SKILL.md, skipping")
        return None

    try:
        skill_md_content = skill_md_bytes.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning(f"Skill '{skill_name}' SKILL.md is not valid UTF-8")
        return None

    frontmatter, instructions = _parse_skill_md(skill_md_content)

    if not instructions:
        logger.warning(f"Skill '{skill_name}' has empty instructions")
        return None

    # Build frontmatter
    fm_name = frontmatter.get("name", skill_name)
    fm_description = frontmatter.get(
        "description",
        f"User-defined skill: {skill_name}",
    )
    fm_metadata = frontmatter.get("metadata", {})

    # Build resources: references/, assets/, and scripts/
    references: dict[str, str] = {}
    assets: dict[str, str] = {}
    scripts: dict[str, skill_models.Script] = {}

    for file_path, content_bytes in files.items():
        if file_path == "SKILL.md":
            continue

        try:
            text = content_bytes.decode("utf-8")
        except UnicodeDecodeError:
            # Skip binary files
            continue

        if file_path.startswith("references/"):
            ref_name = file_path[len("references/") :]
            references[ref_name] = text
        elif file_path.startswith("assets/"):
            asset_name = file_path[len("assets/") :]
            assets[asset_name] = text
        elif file_path.startswith("scripts/"):
            script_name = file_path[len("scripts/") :]
            scripts[script_name] = skill_models.Script(src=text)

    # Build the Resources object (only if there's something to include)
    resources = None
    if references or assets or scripts:
        resources_kwargs = {}
        if references:
            resources_kwargs["references"] = references
        if assets:
            resources_kwargs["assets"] = assets
        if scripts:
            resources_kwargs["scripts"] = scripts
        resources = skill_models.Resources(**resources_kwargs)

    frontmatter_kwargs = {
        "name": fm_name,
        "description": fm_description,
    }
    if fm_metadata:
        frontmatter_kwargs["metadata"] = fm_metadata

    skill_kwargs = {
        "frontmatter": skill_models.Frontmatter(**frontmatter_kwargs),
        "instructions": instructions,
    }
    if resources:
        skill_kwargs["resources"] = resources

    return skill_models.Skill(**skill_kwargs)
