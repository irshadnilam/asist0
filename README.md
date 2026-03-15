# Asisto

A voice-first AI assistant built with [Google ADK](https://google.github.io/adk-docs/) (Agent Development Kit) and the Gemini Live API. Features real-time bidirectional voice streaming, a multi-agent architecture for visual UI rendering, persistent sessions, and long-term memory -- all deployed to Google Cloud.

## Highlights

- **Multi-agent system** -- Voice agent (Gemini Live native audio) delegates to a UI agent (Gemini 2.5 Flash) via ADK's `AgentTool` for reliable structured output
- **Bidirectional voice streaming** -- Real-time audio via WebSocket and Gemini Live API (`run_live` with `BIDI` streaming mode)
- **A2UI protocol** -- Agent renders rich interactive UIs (cards, lists, layouts) in the user's workspace through session state
- **Session state as source of truth** -- UI state lives in ADK session state, persists via Vertex AI Session Service, and syncs to the frontend in real time
- **Long-term memory** -- Agent recalls past conversations via Vertex AI Memory Bank
- **Firebase Auth** -- Google Sign-In with token verification on every request
- **IDE-like dark UI** -- WebGL orb interface, animated transitions, JetBrains Mono, GitHub-dark palette

## Architecture

```
Browser                              Cloud Run (FastAPI + ADK)
+-------------------+               +----------------------------------+
| WebGL Orb         |               |  Voice Agent (Live API)          |
| Audio I/O         |--WebSocket--->|  gemini-live-2.5-flash-native-   |
| A2UI Renderer     |<--WebSocket---|  audio                           |
| (Zustand + React) |               |     |                            |
+-------------------+               |     | AgentTool                  |
                                    |     v                            |
                                    |  UI Agent (run_async)            |
                                    |  gemini-2.5-flash                |
                                    |     |                            |
                                    |     | update_ui tool             |
                                    |     v                            |
                                    |  Session State ["a2ui"]          |
                                    |     |                            |
                                    |     | state_delta                |
                                    |     v                            |
                                    |  WebSocket -> Frontend           |
                                    +----------------------------------+
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for a deep dive on ADK usage, multi-agent patterns, state management, and the A2UI protocol.

## ADK Features Used

| Feature | How It's Used |
|---------|---------------|
| **Multi-Agent (AgentTool)** | Voice agent wraps UI agent as a tool for explicit invocation |
| **Gemini Live API (run_live)** | Bidirectional audio streaming with native voice model |
| **Session State** | `a2ui` key holds full UI state, triggers `state_delta` for real-time sync |
| **InstructionProvider** | Dynamic system prompts inject current UI state each turn |
| **FunctionTool** | `update_ui` tool applies A2UI messages to session state |
| **VertexAiSessionService** | Persistent sessions backed by Agent Engine |
| **VertexAiMemoryBankService** | Long-term memory across sessions |
| **RunConfig** | Configures BIDI streaming, audio modality, transcription, session resumption |
| **Event filtering** | Backend strips tool internals, forwards only user-facing data |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Agent Framework | Google ADK (Python) |
| Voice Model | `gemini-live-2.5-flash-native-audio` (Vertex AI) |
| UI Model | `gemini-2.5-flash` (Vertex AI) |
| Backend | FastAPI + Uvicorn |
| Frontend | TanStack Start (React 19) + Bun + Tailwind v4 |
| UI State | Zustand with A2UI protocol |
| Auth | Firebase Authentication (Google Sign-In) |
| Sessions | Vertex AI Agent Engine (Session Service + Memory Bank) |
| Infrastructure | Pulumi (Python), Docker, Cloud Run |
| Domains | `asisto.agents.sh`, `asisto-api.agents.sh` |

## Project Structure

```
asisto/
├── asisto_agent/                    # ADK agent package
│   ├── agent.py                     # Voice agent -- Live API, AgentTool(ui_renderer)
│   ├── ui_agent.py                  # UI agent -- gemini-2.5-flash, InstructionProvider, update_ui
│   ├── tools.py                     # update_ui FunctionTool -- applies A2UI to session state
│   └── __init__.py
├── app/                             # Frontend (TanStack Start + Bun)
│   ├── src/
│   │   ├── a2ui/                    # A2UI v0.9 renderer
│   │   │   ├── store.ts             # Zustand store -- surfaces, syncFromState
│   │   │   ├── types.ts             # Full A2UI protocol TypeScript types
│   │   │   ├── tree.ts              # Flat adjacency list -> renderable tree
│   │   │   ├── registry.ts          # Component type -> React renderer map
│   │   │   ├── SurfaceRenderer.tsx   # Top-level renderer with useShallow
│   │   │   └── components/          # Text, Row, Column, Card, Button, Image, Divider, Icon
│   │   ├── lib/
│   │   │   ├── useAgentSocket.ts    # WebSocket client (handles a2ui_state messages)
│   │   │   ├── useAudioCapture.ts   # Mic capture (AudioWorklet, 16kHz PCM)
│   │   │   ├── useAudioPlayback.ts  # Speaker playback (pcm-player, 24kHz)
│   │   │   ├── useAuth.tsx          # Firebase Auth provider + hook
│   │   │   ├── api.ts               # TanStack Start server functions
│   │   │   └── firebase.ts          # Firebase init
│   │   ├── components/
│   │   │   └── Orb.tsx              # WebGL orb (ogl) with center<->corner animation
│   │   └── routes/
│   │       └── app/
│   │           ├── index.tsx        # Workspace list with delete
│   │           └── $workspaceId.tsx  # Workspace view -- orb, audio, A2UI
│   └── public/
│       └── capture-processor.js     # AudioWorklet (float32 -> int16)
├── infra/                           # Pulumi IaC (Python)
│   └── __main__.py                  # Cloud Run, Artifact Registry, domain mappings
├── main.py                          # FastAPI -- WebSocket streaming, REST, event filtering
├── config.yaml                      # Central config (project, region, engine ID)
├── Dockerfile                       # Backend container
├── Makefile                         # Build, deploy, dev commands
├── pyproject.toml                   # Python dependencies (uv)
├── ARCHITECTURE.md                  # Deep dive on ADK usage and system design
├── DEPLOYMENT.md                    # Full deployment guide
└── LICENSE                          # MIT
```

## API

### REST (Workspace Management)

All endpoints require `Authorization: Bearer <firebase-id-token>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workspaces` | Create a new workspace |
| `GET` | `/workspaces` | List workspace IDs |
| `GET` | `/workspaces/{id}` | Get workspace |
| `DELETE` | `/workspaces/{id}` | Delete workspace |

### WebSocket (Live Streaming)

`WS /ws/{workspace_id}?token=<firebase-id-token>`

| Direction | Format | Description |
|-----------|--------|-------------|
| Client -> Server | JSON `{"type": "text", "text": "..."}` | Text message |
| Client -> Server | Binary (PCM 16kHz 16-bit) | Audio |
| Server -> Client | JSON with `content`, `turnComplete`, `interrupted` | Agent response |
| Server -> Client | JSON with `inputTranscription` / `outputTranscription` | Transcriptions |
| Server -> Client | JSON `{"type": "a2ui_state", "state": {...}}` | UI state sync |

## Quick Start

### Prerequisites

- Python 3.13+ with [uv](https://docs.astral.sh/uv/)
- [Bun](https://bun.sh/)
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) (authenticated)
- Google Cloud project with Vertex AI API enabled

### Local Development

```bash
# Install dependencies
uv sync
cd app && bun install && cd ..

# Configure
cp config.yaml.example config.yaml
# Edit config.yaml: set project_id and agent_engine resource_id

cp app/.env.example app/.env

# Run backend (8080) + frontend (3000)
make dev
```

### Make Commands

```
make dev             Run backend + frontend concurrently
make dev-api         Backend only
make dev-app         Frontend only
make deploy-agent    Deploy agent to Agent Engine
make deploy-infra    Deploy to Cloud Run via Pulumi
make deploy-all      Deploy agent + infrastructure
make logs            View backend logs
make status          Check deployment status
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full guide.

## License

[MIT](LICENSE) -- Copyright 2026 Irshad Nilam
