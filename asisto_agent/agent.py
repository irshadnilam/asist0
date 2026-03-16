"""Asisto Agent — voice-first AI assistant with user-defined skills.

The root agent handles voice via Gemini Live API (native audio model).
Users can extend agent capabilities by creating skills in their
/skills/ directory following the Agent Skills specification.

Usage:
  - `root_agent`: The base agent (no user skills, used for module export).
  - `create_agent(skills, agent_engine_resource_name)`: Factory to create a
    per-session agent with the user's SkillToolset + sandbox code executor.
"""

import logging
import os

from google.adk.agents import Agent
from google.adk.code_executors import AgentEngineSandboxCodeExecutor
from google.adk.skills import models as skill_models
from google.adk.tools.skill_toolset import SkillToolset

logger = logging.getLogger(__name__)

LIVE_MODEL = os.getenv("ASISTO_AGENT_MODEL", "gemini-live-2.5-flash-native-audio")

BASE_INSTRUCTION = """\
You are Asisto, a helpful and friendly AI assistant with voice capabilities.
You speak naturally and conversationally.

IMPORTANT: You have access to user-defined skills. When the user asks you to
do something that matches a skill's description, you MUST use that skill.
Skills are custom capabilities the user has configured — always prefer using
a matching skill over generic responses.

When you use a skill:
1. Follow the skill's instructions exactly
2. If the skill references files (references/, assets/), read them as directed
3. If the skill has scripts/, you can execute them — they run in a sandboxed environment
4. Report the result clearly to the user
"""

# Base agent — exported for ADK module discovery (adk web, Agent Engine).
# This has no user skills. Per-session agents are created via create_agent().
root_agent = Agent(
    name="asisto_agent",
    model=LIVE_MODEL,
    description="A voice-first AI assistant with user-extensible skills.",
    instruction=BASE_INSTRUCTION,
)


def create_agent(
    user_skills: list[skill_models.Skill] | None = None,
    agent_engine_resource_name: str | None = None,
    file_tools: list | None = None,
) -> Agent:
    """Create a per-session agent with the user's skills loaded.

    Args:
        user_skills: List of ADK Skill objects loaded from the user's
            /skills/ directory in Firebase Storage. If None or empty,
            returns an agent with no SkillToolset.
        agent_engine_resource_name: Full Agent Engine resource name
            (e.g. projects/{id}/locations/{loc}/reasoningEngines/{id}).
            Required for sandbox code execution of skill scripts.
        file_tools: List of file-operation tool functions (closures from
            agent_tools.create_file_tools). These let the agent create,
            read, write, and manage files in the user's workspace.

    Returns:
        An Agent instance configured with the user's skills, file tools,
        and optional sandbox code executor.
    """
    tools: list = []
    code_executor = None

    # Create sandbox code executor if Agent Engine resource name is available.
    # This enables execution of skill scripts (scripts/ directory in skills).
    # The sandbox is created per-session and persists for the session duration.
    if agent_engine_resource_name:
        try:
            code_executor = AgentEngineSandboxCodeExecutor(
                agent_engine_resource_name=agent_engine_resource_name,
            )
            logger.info("Created AgentEngineSandboxCodeExecutor")
        except Exception as e:
            logger.warning(f"Failed to create sandbox code executor: {e}")

    if user_skills:
        # Pass code_executor to SkillToolset so skill scripts can be executed.
        # If code_executor is None, scripts won't be available but skill
        # instructions/references will still work.
        skill_toolset = SkillToolset(
            skills=user_skills,
            code_executor=code_executor,
        )
        tools.append(skill_toolset)

    # Add file-operation tools (list, read, write, create, delete, rename, move)
    if file_tools:
        tools.extend(file_tools)

    # Build instruction with skill summary and file tool guidance
    instruction = BASE_INSTRUCTION

    if file_tools:
        instruction += """
FILE OPERATIONS: You have tools to manage the user's files. When the user
asks to create, read, edit, delete, rename, move, or list files, you MUST
call the appropriate file tool. Available file tools: list_files, read_file,
write_file, create_folder, delete_file, rename_file, move_file.

CRITICAL: Do NOT guess file contents or pretend you performed file operations.
ALWAYS call the actual tool. If you are unsure which file the user means,
use list_files first to see what's available, then ask for clarification.
"""

    if user_skills:
        skill_summary = "\n".join(
            f"- **{s.frontmatter.name}**: {s.frontmatter.description}"
            for s in user_skills
        )
        instruction += f"""
You currently have the following skills available:
{skill_summary}

When the user's request matches any of these skills, ALWAYS use the
corresponding skill tool. Do NOT try to answer from general knowledge
if a skill exists for the task.
"""

    return Agent(
        name="asisto_agent",
        model=LIVE_MODEL,
        description="A voice-first AI assistant with user-extensible skills.",
        instruction=instruction,
        tools=tools,
        # Also set code_executor on the agent as fallback for model-generated
        # code blocks (in addition to skill script execution via SkillToolset).
        code_executor=code_executor,
    )
