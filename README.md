# Asisto

A real-time AI voice and text assistant built with [Google ADK](https://google.github.io/adk-docs/) and the Gemini Live API. Features bidirectional WebSocket streaming, persistent sessions via Vertex AI Agent Engine, and long-term memory.

## Features

- **Bidirectional streaming** -- real-time voice and text via WebSocket (Gemini Live API)
- **Persistent sessions** -- conversations survive restarts via Vertex AI Session Service
- **Long-term memory** -- agent recalls past conversations via Vertex AI Memory Bank
- **Firebase Auth** -- Google Sign-In, backend verifies Firebase ID tokens
- **Built-in tools** -- current time (any timezone) and math calculations
- **Cloud Run deployment** -- containerized FastAPI service with Pulumi IaC

## Tech Stack

- **Agent framework**: Google ADK (Agent Development Kit)
- **Model**: `gemini-live-2.5-flash-native-audio` (Vertex AI)
- **Backend**: FastAPI + Uvicorn
- **Frontend**: TanStack Start (React 19) + Bun + Tailwind v4
- **Infrastructure**: Pulumi (Python), Docker, Cloud Run
- **Services**: Vertex AI Agent Engine (sessions + memory), Firebase Auth

## Authentication

All API endpoints require a Firebase ID token in the `Authorization: Bearer <token>` header.
The frontend handles Google Sign-In via Firebase Auth and passes the token through server functions.
WebSocket connections pass the token as a `?token=` query parameter.

## Project Structure

```
asisto/
├── app/                            # Frontend (TanStack Start + Bun)
│   ├── src/
│   │   ├── routes/                 # File-based routing
│   │   │   ├── __root.tsx          # Root layout with status bar
│   │   │   ├── index.tsx           # / — redirects to /app or /sign-in
│   │   │   ├── sign-in/            # Google Sign-In page
│   │   │   └── app/
│   │   │       ├── index.tsx       # Workspace list
│   │   │       └── $workspaceId.tsx # Workspace view (orb + audio streaming)
│   │   ├── lib/                    # Hooks and utilities
│   │   │   ├── api.ts              # Server functions (REST proxy to backend)
│   │   │   ├── firebase.ts         # Firebase init + Google auth provider
│   │   │   ├── useAuth.tsx         # Auth context provider + hook
│   │   │   ├── useAgentSocket.ts   # WebSocket client (direct to backend)
│   │   │   ├── useAudioCapture.ts  # Mic capture (AudioWorklet, 16kHz PCM)
│   │   │   └── useAudioPlayback.ts # Speaker playback (pcm-player, 24kHz PCM)
│   │   ├── components/
│   │   │   └── Orb.tsx             # WebGL orb (ogl) — tap to toggle voice
│   │   ├── router.tsx              # TanStack Router setup
│   │   └── styles.css              # Tailwind + IDE dark theme
│   ├── public/
│   │   └── capture-processor.js    # Mic AudioWorklet (float32 → int16)
│   ├── package.json                # Bun dependencies
│   ├── vite.config.ts              # Vite + TanStack Start + Nitro (bun preset)
│   ├── Dockerfile                  # Container image for Cloud Run (oven/bun)
│   ├── .env                        # API_ENDPOINT config (gitignored)
│   └── .env.example                # Env template (committed)
├── asisto_agent/                   # Agent package
│   ├── __init__.py                 # Package init
│   ├── agent.py                    # Agent definition, tools, model config
│   └── .env                        # Vertex AI runtime config (gitignored)
├── infra/                          # Pulumi infrastructure (Python)
│   ├── Pulumi.yaml                 # Pulumi project config
│   ├── __main__.py                 # GCP APIs, Artifact Registry, Cloud Run (backend + frontend)
│   └── requirements.txt            # Pulumi Python dependencies
├── main.py                         # FastAPI server with WebSocket + REST endpoints
├── config.yaml                     # Deployment config: project, region, engine ID (gitignored)
├── config.yaml.example             # Config template (committed)
├── Dockerfile                      # Backend container image for Cloud Run
├── .dockerignore                   # Docker build exclusions
├── Makefile                        # Build, deploy, and dev commands
├── pyproject.toml                  # Python dependencies (managed by uv)
├── DEPLOYMENT.md                   # Full deployment guide
└── LICENSE                         # MIT License
```

## API Endpoints

### REST (Workspace Management)

All endpoints require `Authorization: Bearer <firebase-id-token>` header.
The user ID is extracted from the token server-side.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workspaces` | Create a new workspace |
| `GET` | `/workspaces` | List all workspace IDs for the authenticated user |
| `GET` | `/workspaces/{workspace_id}` | Get a workspace by ID |
| `DELETE` | `/workspaces/{workspace_id}` | Delete a workspace |

### WebSocket (Live Streaming)

| Protocol | Endpoint | Description |
|----------|----------|-------------|
| `WS` | `/ws/{workspace_id}?token=<firebase-id-token>` | Bidirectional streaming (voice + text) |

#### WebSocket Message Format

**Text (client -> server):**
```json
{"type": "text", "text": "What time is it in Colombo?"}
```

**Image (client -> server):**
```json
{"type": "image", "data": "base64_encoded_data", "mimeType": "image/jpeg"}
```

**Audio (client -> server):**
Raw binary frames -- PCM audio, 16kHz, 16-bit.

**Events (server -> client):**
Filtered JSON-encoded ADK Event objects. Only the following event types are sent:

| Event | Description |
|-------|-------------|
| Text response | Agent's text reply (`content.parts[].text`) |
| Audio response | Raw audio chunks (`content.parts[].inlineData`, base64 URL-safe encoded PCM int16) |
| Input transcription | User's speech-to-text (`inputTranscription`) |
| Output transcription | Agent's audio-to-text (`outputTranscription`) |
| Turn complete | Agent finished responding (`turnComplete: true`) |
| Interrupted | User interrupted agent (`interrupted: true`) |

Internal events (function calls, tool results, usage metadata, state changes) are filtered out.

## Quick Start

### Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/)
- [Bun](https://bun.sh/) (frontend runtime)
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) (authenticated)
- A Google Cloud project with Vertex AI API enabled

### Local Development

```bash
# Install Python dependencies
uv sync

# Install frontend dependencies
cd app && bun install && cd ..

# Configure environment
cp config.yaml.example config.yaml
# Edit config.yaml with your GCP project ID and Agent Engine resource ID

cp app/.env.example app/.env
# Edit app/.env if needed (defaults to API_ENDPOINT=http://localhost:8080)

# Run both backend (port 8080) and frontend (port 3000) concurrently
make dev
```

The backend starts at `http://localhost:8080`. Swagger docs at `http://localhost:8080/docs`.
The frontend starts at `http://localhost:3000`.

### Available Make Commands

```
make help            Show all commands
make dev             Run backend + frontend concurrently
make dev-api         Run FastAPI backend only
make dev-adk         Run ADK web UI locally
make dev-app         Run frontend dev server only
make deploy-agent    Deploy agent to Agent Engine
make setup           First-time Pulumi setup
make preview         Preview infrastructure changes
make deploy-infra    Deploy backend + frontend to Cloud Run
make deploy-frontend Deploy frontend only to Cloud Run
make deploy-all      Deploy agent + infrastructure
make logs            View backend Cloud Run logs
make logs-app        View frontend Cloud Run logs
make status          Check deployment status
make destroy         Tear down infrastructure
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full deployment guide covering:

- Google Cloud authentication
- Agent Engine deployment
- Backend + Frontend Cloud Run deployment with Pulumi
- Configuration management
- Updating and tearing down

## License

[MIT](LICENSE)
