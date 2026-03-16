"""Asisto Agent — voice-first AI assistant.

The root agent handles voice via Gemini Live API (native audio model).
"""

import os

from google.adk.agents import Agent


LIVE_MODEL = os.getenv("ASISTO_AGENT_MODEL", "gemini-live-2.5-flash-native-audio")

VOICE_INSTRUCTION = """\
You are Asisto, a helpful and friendly AI assistant with voice capabilities.
You speak naturally and conversationally.
"""

root_agent = Agent(
    name="asisto_agent",
    model=LIVE_MODEL,
    description="A voice-first AI assistant.",
    instruction=VOICE_INSTRUCTION,
)
