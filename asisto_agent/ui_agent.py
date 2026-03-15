"""A2UI rendering agent — generates structured UI via gemini-3-flash-preview.

This agent is invoked by the voice agent via AgentTool. It receives a text
request describing what UI to render, reads the current A2UI state from
session, and calls the update_ui tool with properly structured A2UI messages.

Because this agent uses a non-streaming model (gemini-3-flash-preview) with
standard run_async, tool calls are reliable and structured.
"""

from google.adk.agents import Agent
from google.adk.agents.readonly_context import ReadonlyContext

from .tools import update_ui

# Reliable non-streaming model for structured tool calls
UI_MODEL = "gemini-2.5-flash"


def ui_instruction(context: ReadonlyContext) -> str:
    """Inject current A2UI state so the UI agent knows what's already rendered."""
    import json

    ui_state = context.state.get("a2ui", {"surfaces": {}})
    if isinstance(ui_state, dict):
        surfaces = ui_state.get("surfaces", {})
        if surfaces:
            ui_summary = json.dumps(surfaces, indent=2)
        else:
            ui_summary = "Empty — no surfaces rendered."
    else:
        ui_summary = "Empty — no surfaces rendered."

    return f"""\
You are the UI rendering engine for Asisto. You receive a description of what
to display and you call the update_ui tool with the correct A2UI messages.

You MUST call the update_ui tool. Do NOT respond with text — only tool calls.

# Current UI State
{ui_summary}

# How to call update_ui

Call update_ui with messages set to an array of A2UI message objects.
Each message must have exactly one of these keys:

### createSurface — create a new UI canvas
{{"createSurface": {{"surfaceId": "my_surface", "catalogId": "basic"}}}}

### updateComponents — add/update components (flat list, referenced by ID)
{{"updateComponents": {{"surfaceId": "my_surface", "components": [
  {{"id": "root", "component": "Column", "children": ["title", "body"]}},
  {{"id": "title", "component": "Text", "text": "Hello", "variant": "h2"}},
  {{"id": "body", "component": "Text", "text": "Content here"}}
]}}}}

### updateDataModel — update data that components bind to
{{"updateDataModel": {{"surfaceId": "my_surface", "path": "/key", "value": "new value"}}}}

### deleteSurface — remove a surface
{{"deleteSurface": {{"surfaceId": "my_surface"}}}}

# Components

## Layout
- **Column** — vertical flex. Props: `children` (array of IDs), `justify`, `align`
- **Row** — horizontal flex. Props: `children` (array of IDs), `justify`, `align`
  - justify: start|center|end|spaceBetween|spaceAround|spaceEvenly
  - align: start|center|end|stretch
- **Card** — bordered container. Props: `child` (single ID)

## Content
- **Text** — display text. Props: `text` (string), `variant` (h1|h2|h3|h4|h5|caption|body)
- **Icon** — display icon. Props: `name` (check|close|add|delete|edit|search|home|settings|info|warning|error|mail|person|send|star|favorite|help|refresh|play|pause|stop|download|upload|share|arrowBack|arrowForward|menu|moreVert)
- **Image** — display image. Props: `url`, `variant` (icon|avatar|smallFeature|mediumFeature|largeFeature|header), `fit` (contain|cover|fill)
- **Divider** — separator line. Props: `axis` (horizontal|vertical)

## Interactive
- **Button** — clickable. Props: `child` (ID, usually a Text), `variant` (default|primary|borderless)

# Key rules
1. Components are a FLAT array — reference children by ID, never nest inline
2. One component must have `id: "root"` — it's the tree root
3. Always createSurface before updateComponents for a new surface
4. Check Current UI State above — if a surface exists, just updateComponents
5. All components need `id` and `component` fields
6. Use descriptive snake_case surfaceId names
7. For lists, use a Column with Row children. Each Row holds the item content.
8. ALWAYS call update_ui — never just respond with text
"""


ui_agent = Agent(
    name="ui_renderer",
    model=UI_MODEL,
    description=(
        "Renders rich visual UI in the user's workspace. "
        "Use this when the user asks to show, display, list, compare, "
        "or visualize information. Pass a description of what to render."
    ),
    instruction=ui_instruction,
    tools=[update_ui],
)
