# Architecture

Asisto is a voice-first AI assistant that demonstrates advanced usage of the [Google Agent Development Kit (ADK)](https://google.github.io/adk-docs/). This document details how the system leverages ADK's multi-agent architecture, session state management, tool framework, and Gemini Live API streaming to deliver a real-time voice + visual UI experience.

## System Overview

```
Browser (React)                          Cloud Run (FastAPI)
+-----------------------+                +-----------------------------------+
|  WebGL Orb            |                |  WebSocket Handler                |
|  Audio Capture (16kHz)|---WebSocket--->|  ADK Runner (run_live)            |
|  Audio Playback (24k) |<--WebSocket----|                                   |
|  A2UI Renderer        |                |  +-----------------------------+  |
|  (Zustand Store)      |                |  |  Voice Agent (root)         |  |
+-----------------------+                |  |  gemini-live-2.5-flash-     |  |
                                         |  |  native-audio               |  |
                                         |  |                             |  |
                                         |  |  tools:                     |  |
                                         |  |    AgentTool(ui_renderer)   |  |
                                         |  +------------|---------------+  |
                                         |               | run_async        |
                                         |  +------------|---------------+  |
                                         |  |  UI Agent (ui_renderer)    |  |
                                         |  |  gemini-2.5-flash          |  |
                                         |  |                            |  |
                                         |  |  tools:                    |  |
                                         |  |    update_ui (FunctionTool)|  |
                                         |  +----------------------------+  |
                                         |                                   |
                                         |  Vertex AI Session Service        |
                                         |  Vertex AI Memory Bank            |
                                         +-----------------------------------+
```

## ADK Features Used

### 1. Multi-Agent Architecture (AgentTool)

Asisto uses a **two-agent system** where a voice agent delegates visual rendering to a specialized UI agent:

- **Voice Agent** (`asisto_agent`) -- the root agent running on `gemini-live-2.5-flash-native-audio` via the Live API. Handles all voice interaction, conversation flow, and decides when visual UI is needed.

- **UI Agent** (`ui_renderer`) -- a sub-agent running on `gemini-2.5-flash` via standard `run_async`. Specializes in generating structured A2UI component trees.

The UI agent is wrapped in `AgentTool` and added to the voice agent's `tools` list:

```python
from google.adk.tools.agent_tool import AgentTool

root_agent = Agent(
    model="gemini-live-2.5-flash-native-audio",
    tools=[AgentTool(agent=ui_agent, skip_summarization=True)],
)
```

**Why two agents?** The native audio model excels at real-time voice conversation but is unreliable at structured tool calls with complex JSON payloads. By delegating UI generation to `gemini-2.5-flash` (a non-streaming model), we get reliable, structured tool invocations every time. `AgentTool` bridges the two -- the voice agent calls `ui_renderer(request="...")` with a simple text description, and the UI agent translates that into precise A2UI protocol messages.

**`skip_summarization=True`** prevents the voice agent from making a follow-up LLM call to rephrase the UI agent's response. The voice agent continues speaking naturally while the UI renders in the background.

### 2. Gemini Live API Streaming (run_live)

The voice agent uses ADK's `runner.run_live()` for bidirectional streaming with the Gemini Live API:

```python
run_config = RunConfig(
    streaming_mode=StreamingMode.BIDI,
    response_modalities=["AUDIO"],
    input_audio_transcription=types.AudioTranscriptionConfig(),
    output_audio_transcription=types.AudioTranscriptionConfig(),
    session_resumption=types.SessionResumptionConfig(),
)

async for event in runner.run_live(
    user_id=user_id,
    session_id=workspace_id,
    live_request_queue=live_request_queue,
    run_config=run_config,
):
    # Process events...
```

Key streaming features used:
- **`StreamingMode.BIDI`** -- full-duplex audio: user and agent can speak simultaneously
- **`AUDIO` response modality** -- agent responds with native audio (not TTS), producing natural-sounding speech
- **Audio transcription** -- both input and output audio are transcribed for logging and display
- **Session resumption** -- reconnects gracefully if the Live API connection drops
- **`LiveRequestQueue`** -- sends audio chunks and text messages to the Live API in real time

### 3. Session State as Source of Truth

ADK's session state is the backbone of Asisto's UI system. The `a2ui` key in session state holds the complete UI state:

```python
# Initialized when a workspace is created
session = await session_service.create_session(
    app_name=APP_NAME,
    user_id=user_id,
    state={"a2ui": {"surfaces": {}}},
)
```

**State flow:**

1. The UI agent calls `update_ui` tool, which writes to `tool_context.state["a2ui"]`
2. ADK tracks this as a `state_delta` on the resulting event
3. `AgentTool` propagates the state_delta from the child agent back to the parent's `tool_context.state`
4. The parent's event carries `actions.stateDelta.a2ui`
5. The backend `downstream_task` intercepts this and forwards it to the frontend via WebSocket
6. The frontend's Zustand store syncs from the state snapshot

This means the UI state is:
- **Persisted** -- survives server restarts via Vertex AI Session Service
- **Consistent** -- single source of truth, no frontend/backend drift
- **Observable** -- any state change automatically propagates to the frontend

### 4. Vertex AI Session Service

All sessions are managed by `VertexAiSessionService`, backed by Vertex AI Agent Engine:

```python
session_service = VertexAiSessionService(
    project=PROJECT_ID,
    location=LOCATION,
    agent_engine_id=ENGINE_ID,
)
```

This provides:
- **Persistence** -- sessions survive backend restarts and redeployments
- **User isolation** -- sessions are scoped to user IDs (from Firebase Auth)
- **State management** -- session state (including `a2ui`) is stored and retrievable
- **Conversation history** -- full message history is maintained per session

### 5. Vertex AI Memory Bank

Long-term memory across sessions is provided by `VertexAiMemoryBankService`:

```python
memory_service = VertexAiMemoryBankService(
    project=PROJECT_ID,
    location=LOCATION,
    agent_engine_id=ENGINE_ID,
)
```

The agent can recall information from previous conversations with the same user, enabling continuity across workspace sessions.

### 6. InstructionProvider (Dynamic System Prompts)

The UI agent uses ADK's `InstructionProvider` pattern -- a callable that generates the system prompt dynamically each turn:

```python
def ui_instruction(context: ReadonlyContext) -> str:
    ui_state = context.state.get("a2ui", {"surfaces": {}})
    # ... serialize current UI state ...
    return f"""
    You are the UI rendering engine for Asisto.
    # Current UI State
    {ui_summary}
    # Component catalog...
    """
```

This ensures the UI agent always knows what's currently rendered, so it can make incremental updates (add components to existing surfaces, update data models) rather than rebuilding from scratch.

### 7. FunctionTool (update_ui)

The `update_ui` tool is a standard ADK `FunctionTool` that the UI agent calls to modify the UI state:

```python
def update_ui(messages: list, tool_context: ToolContext) -> dict:
    """Applies A2UI protocol messages to session state."""
    # Parse and validate messages
    # Apply createSurface, updateComponents, updateDataModel, deleteSurface
    # Write to tool_context.state["a2ui"]
    # Returns status + applied operations
```

ADK auto-generates the tool's function declaration from the Python signature and docstring, which the LLM uses to decide when and how to call it.

### 8. Event Filtering

The backend filters ADK events before forwarding to the frontend, keeping the WebSocket clean:

```python
_FORWARD_KEYS = {"content", "turnComplete", "interrupted",
                 "inputTranscription", "outputTranscription"}
```

Filtered out: function calls, function responses, agent delegation events, usage metadata, grounding metadata, invocation IDs. The frontend only sees user-facing data.

## A2UI Protocol

A2UI (Agent-to-User Interface) is a protocol for agents to render rich, interactive UIs. Asisto implements A2UI v0.9 with the following message types:

| Message | Description |
|---------|-------------|
| `createSurface` | Create a new UI canvas with a surface ID |
| `updateComponents` | Add or update components in a surface (flat array, referenced by ID) |
| `updateDataModel` | Patch data that components bind to (JSON Pointer paths) |
| `deleteSurface` | Remove a surface |

### Component Catalog

| Category | Components |
|----------|------------|
| Layout | `Column`, `Row`, `Card` |
| Content | `Text` (7 variants), `Icon` (30 Material icons), `Image` (6 sizes), `Divider` |
| Interactive | `Button` (3 variants) |

### Frontend Renderer

The A2UI renderer is built with:
- **Zustand store** -- manages all surface state, processes messages, syncs from backend snapshots
- **Tree builder** -- converts flat component adjacency lists into renderable trees
- **Component registry** -- maps component types to React renderers
- **`useShallow`** -- prevents unnecessary re-renders when surface IDs haven't changed

## Data Flow

### Voice Conversation

```
User speaks
  -> AudioWorklet captures PCM 16kHz
  -> WebSocket binary frame
  -> LiveRequestQueue.send_realtime()
  -> Gemini Live API processes audio
  -> Agent responds with audio (PCM 24kHz)
  -> Event with inlineData (base64)
  -> WebSocket JSON frame
  -> pcm-player decodes and plays at 24kHz
```

### UI Rendering

```
User: "Show me top 10 countries by GDP"
  -> Voice agent (Live API) receives audio
  -> Voice agent calls ui_renderer(request="Show a list of top 10 countries...")
  -> AgentTool creates ephemeral session, copies parent state
  -> UI agent (gemini-2.5-flash) runs via run_async
  -> UI agent reads current a2ui state from session via InstructionProvider
  -> UI agent calls update_ui([{createSurface...}, {updateComponents...}])
  -> update_ui writes to tool_context.state["a2ui"]
  -> state_delta propagated back to voice agent's session
  -> downstream_task sees "a2ui" in stateDelta
  -> WebSocket sends {"type": "a2ui_state", "state": {"surfaces": {...}}}
  -> Frontend Zustand store syncs via syncFromState()
  -> SurfaceRenderer builds tree and renders components
```

## Infrastructure

### Deployment Stack

| Component | Technology | Hosting |
|-----------|-----------|---------|
| Voice Agent | ADK + Gemini Live API | Cloud Run |
| UI Agent | ADK + Gemini 2.5 Flash | Cloud Run (same service) |
| Session Storage | Vertex AI Session Service | Agent Engine |
| Memory | Vertex AI Memory Bank | Agent Engine |
| Frontend | TanStack Start + Bun + Nitro | Cloud Run |
| Auth | Firebase Authentication | Google-managed |
| IaC | Pulumi (Python, local state) | N/A |

### Agent Engine

Vertex AI Agent Engine provides the session and memory backend. The agent code itself runs on Cloud Run (not inside Agent Engine):

```
Agent Engine (resource ID in config.yaml)
  ├── Session Service -- stores sessions, state, conversation history
  └── Memory Bank -- stores long-term memory across sessions
```

### Custom Domains

- `asisto.agents.sh` -- frontend (TanStack Start on Nitro/Bun)
- `asisto-api.agents.sh` -- backend (FastAPI on Uvicorn)

Both configured via `gcp.cloudrun.DomainMapping` in Pulumi.

## Security

- **Firebase Auth** -- all REST endpoints require Bearer token, WebSocket requires `?token=` query param
- **User isolation** -- user ID extracted from Firebase token on every request, never in URL path
- **No CORS needed** -- frontend REST calls use TanStack Start server functions (same-origin)
- **WebSocket direct** -- browser connects directly to backend (token-authenticated)

## Key Design Decisions

1. **Two models, one voice** -- Native audio model for natural speech, standard model for reliable tool calls. Best of both worlds.

2. **State as source of truth** -- UI state lives in ADK session state, not in frontend local state. This enables persistence, server-side validation, and consistent rendering across reconnections.

3. **AgentTool over sub_agents** -- Explicit tool invocation gives the voice agent clear control over when to render UI, rather than relying on LLM-driven agent transfer.

4. **skip_summarization** -- The voice agent doesn't waste a model call summarizing the UI agent's output. It continues its natural speech while UI renders silently.

5. **InstructionProvider** -- Dynamic prompts that inject current state ensure the UI agent makes incremental updates, not full rebuilds.

6. **Event filtering** -- Frontend never sees tool internals. Clean separation between agent mechanics and user-facing data.
