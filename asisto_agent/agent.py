"""Asisto Agent — voice-first AI assistant with visual UI rendering.

The root agent handles voice via Gemini Live API (native audio model).
When the user asks to see something visual, it delegates to the ui_renderer
agent via AgentTool. The ui_renderer uses gemini-3-flash-preview for reliable
structured tool calls to build A2UI surfaces.

State flow:
  voice agent -> AgentTool(ui_renderer) -> update_ui tool -> state["a2ui"]
  -> state_delta propagated back -> backend forwards to frontend via WebSocket
"""

import os

from google.adk.agents import Agent
from google.adk.tools.agent_tool import AgentTool

from .ui_agent import ui_agent


# Live API compatible model for Vertex AI
# Override with ASISTO_AGENT_MODEL env var if needed
LIVE_MODEL = os.getenv("ASISTO_AGENT_MODEL", "gemini-live-2.5-flash-native-audio")


VOICE_INSTRUCTION = """\
You are Asisto, a helpful and friendly AI assistant with voice and visual capabilities.
You speak naturally and conversationally.

# CRITICAL RULE: Using ui_renderer

You MUST call the ui_renderer tool whenever the user asks to show, display, list,
compare, or visualize ANY information. Do NOT pretend you displayed something —
you MUST actually invoke the tool. The user can see whether the UI appeared or not.

If the user says "show me", "list", "display", "compare", or anything visual,
you MUST call ui_renderer. No exceptions.

## How to call ui_renderer
Call it with a detailed request describing what to display. Include ALL the data.

Examples:
- ui_renderer(request="Show a numbered list of the top 10 countries by GDP: 1. United States - $25.5T, 2. China - $18T, ...")
- ui_renderer(request="Display a card showing Tokyo weather: sunny, 25°C, humidity 60%, wind 10km/h")
- ui_renderer(request="Show a comparison of Python vs JavaScript vs Go with columns for typing, speed, and use cases")

Be specific — include the actual data in your request, not just the topic.

## When NOT to use ui_renderer
- Simple conversational replies — just speak
- Quick yes/no answers, greetings, small talk
"""


root_agent = Agent(
    name="asisto_agent",
    model=LIVE_MODEL,
    description="A voice-first AI assistant that can render rich interactive UIs.",
    instruction=VOICE_INSTRUCTION,
    tools=[
        AgentTool(agent=ui_agent, skip_summarization=True),
    ],
)
