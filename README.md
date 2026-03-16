# Asisto

A voice-first AI assistant built with [Google ADK](https://google.github.io/adk-docs/) (Agent Development Kit) and the Gemini Live API. Features real-time bidirectional voice streaming, a file manager with floating editor windows, user-extensible agent skills, and Firebase-backed storage -- all deployed to Google Cloud.

## Highlights

- **Voice streaming** -- Real-time bidirectional audio via WebSocket and Gemini Live API (`gemini-live-2.5-flash-native-audio`)
- **File manager** -- SVAR Filemanager with Firestore realtime sync, drag-and-drop, context menus
- **Floating editor windows** -- WinBox.js-powered windows with CodeMirror 6 editor, live markdown preview, image viewer
- **User-extensible skills** -- Create custom agent capabilities as files in your `/skills/` directory following the [Agent Skills spec](https://agentskills.io/specification)
- **Sandbox code execution** -- Skill scripts run in `AgentEngineSandboxCodeExecutor` for safe execution
- **Agent file tools** -- Voice agent can list, read, write, create, delete, rename, and move files
- **Firebase Auth** -- Google Sign-In with token verification on every request
- **IDE-like dark UI** -- WebGL orb, floating windows, JetBrains Mono, GitHub-dark palette

## Architecture

```
Browser (React)                        Cloud Run (FastAPI + ADK)
+---------------------------+          +------------------------------------+
| File Manager (SVAR)       |          |  WebSocket Handler                 |
| Floating Windows (WinBox) |          |  ADK Runner (run_live)             |
| CodeMirror 6 Editor       |          |                                    |
| WebGL Orb                 |--WS----->|  Voice Agent                       |
| Audio I/O (16kHz/24kHz)   |<-WS------|  gemini-live-2.5-flash-native-audio|
| Firestore Realtime Sync   |          |  + SkillToolset (user skills)      |
+---------------------------+          |  + File Tools (storage_ops)        |
        |                              |  + AgentEngineSandboxCodeExecutor  |
        | REST (server fns)            +-------------|----------------------+
        v                                            |
+---------------------------+          +-------------|----------------------+
| TanStack Start (Nitro)    |          | Firebase Storage    | Firestore   |
| Server Functions (proxy)  |--REST--->| gs://bucket/users/  | users/{uid} |
+---------------------------+          | {uid}/{path...}     | /files/{id} |
                                       +------------------------------------+
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

## ADK Features Used

| Feature | How It's Used |
|---------|---------------|
| **Gemini Live API (run_live)** | Bidirectional audio streaming with native voice model |
| **SkillToolset** | User-defined skills loaded from Firebase Storage at session start |
| **AgentEngineSandboxCodeExecutor** | Sandboxed execution of skill scripts (.py, .sh) |
| **FunctionTool (closures)** | 7 file-operation tools (list, read, write, create, delete, rename, move) |
| **VertexAiSessionService** | Persistent sessions backed by Agent Engine |
| **VertexAiMemoryBankService** | Long-term memory across sessions |
| **RunConfig** | BIDI streaming, audio modality, transcription, session resumption |
| **Event filtering** | Backend strips tool internals, forwards only user-facing data |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Agent Framework | Google ADK 1.27+ (Python) |
| Voice Model | `gemini-live-2.5-flash-native-audio` (Vertex AI, `us-central1` only) |
| Backend | FastAPI + Uvicorn |
| Frontend | TanStack Start (React 19) + Bun + Tailwind v4 |
| File Manager | `@svar-ui/react-filemanager` + WillowDark theme |
| Editor Windows | WinBox.js (custom React wrapper) |
| Code Editor | CodeMirror 6 + oneDark theme |
| Auth | Firebase Authentication (Google Sign-In) |
| Storage | Firebase Storage (blobs) + Firestore (metadata, realtime) |
| Sessions | Vertex AI Agent Engine (Session Service + Memory Bank) |
| Infrastructure | Pulumi (Python, local state), Docker, Cloud Run |
| Domains | `asisto.agents.sh`, `asisto-api.agents.sh` |

## Project Structure

```
asisto/
├── asisto_agent/                    # ADK agent package
│   ├── agent.py                     # Voice agent + create_agent() factory
│   └── __init__.py                  #   with SkillToolset + SandboxCodeExecutor
├── app/                             # Frontend (TanStack Start + Bun)
│   ├── src/
│   │   ├── lib/
│   │   │   ├── api.ts              # Server functions (file CRUD, download, save)
│   │   │   ├── firebase.ts         # Firebase init + Firestore export
│   │   │   ├── useAuth.tsx         # AuthProvider + useAuth hook
│   │   │   ├── useFiles.ts         # Firestore realtime subscription (onSnapshot)
│   │   │   ├── useAgentSocket.ts   # WebSocket client (direct browser-to-backend)
│   │   │   ├── useAudioCapture.ts  # Mic capture (AudioWorklet, 16kHz PCM)
│   │   │   └── useAudioPlayback.ts # Speaker playback (pcm-player, 24kHz)
│   │   ├── components/
│   │   │   ├── Window.tsx          # WinBox.js React wrapper (dynamic import for SSR)
│   │   │   ├── FileViewer.tsx      # CodeMirror editor + markdown preview + image viewer
│   │   │   └── Orb.tsx            # WebGL orb (ogl)
│   │   ├── routes/
│   │   │   ├── index.tsx          # Landing / sign-in
│   │   │   └── app/
│   │   │       └── index.tsx      # Main workspace: file manager + floating windows
│   │   └── styles.css             # SVAR vars, Tailwind fixes, WinBox dark theme
│   └── public/
│       └── capture-processor.js   # AudioWorklet (float32 → int16)
├── infra/                          # Pulumi IaC (Python)
│   └── __main__.py                # Cloud Run, Artifact Registry, IAM, domain mappings
├── main.py                         # FastAPI — WebSocket, file REST endpoints, auth
├── storage_ops.py                  # Firebase Storage + Firestore CRUD + seed_default_files
├── skill_loader.py                 # Reads user skills from Storage, parses SKILL.md
├── agent_tools.py                  # File-operation tool closures for the agent
├── config.yaml                     # Central config (project, region, bucket, engine ID)
├── firebase.json                   # Points to firestore.rules + storage.rules
├── firestore.rules                 # users/{userId}/files/{fileId} — auth.uid == userId
├── storage.rules                   # users/{userId}/{allPaths=**} — auth.uid == userId
├── Dockerfile                      # Backend container
├── Makefile                        # Build, deploy, dev commands
├── pyproject.toml                  # Python dependencies (uv)
├── ARCHITECTURE.md                 # System design deep dive
├── DEPLOYMENT.md                   # Full deployment guide
└── LICENSE                         # MIT
```

## API

### REST (File Management)

All endpoints require `Authorization: Bearer <firebase-id-token>`. User ID is extracted from the token server-side.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/files` | List root-level files |
| `GET` | `/files/{id}` | List folder contents (lazy loading) |
| `POST` | `/files` | Create file/folder at root |
| `POST` | `/files/{id}` | Create file/folder in subfolder |
| `POST` | `/upload` | Upload file at root |
| `POST` | `/upload/{id}` | Upload file to subfolder |
| `PUT` | `/files/{id}` | Rename file/folder |
| `PUT` | `/files` | Move or copy files |
| `DELETE` | `/files` | Delete files/folders |
| `GET` | `/download/{id}` | Download file (streams content) |
| `GET` | `/info` | Drive info + seed default files for new users |

### WebSocket (Voice Streaming)

`WS /ws/{workspace_id}?token=<firebase-id-token>`

| Direction | Format | Description |
|-----------|--------|-------------|
| Client → Server | JSON `{"type": "text", "text": "..."}` | Text message |
| Client → Server | Binary (PCM 16kHz 16-bit) | Audio |
| Server → Client | JSON with `content` | Agent audio/text response |
| Server → Client | JSON with `turnComplete` | Agent finished speaking |
| Server → Client | JSON with `interrupted` | User interrupted |
| Server → Client | JSON with `inputTranscription` | User speech transcript |
| Server → Client | JSON with `outputTranscription` | Agent speech transcript |

## Quick Start

### Prerequisites

- Python 3.13+ with [uv](https://docs.astral.sh/uv/)
- [Bun](https://bun.sh/)
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) (authenticated)
- Google Cloud project with Vertex AI + Firebase enabled

### Local Development

```bash
# Install dependencies
uv sync
cd app && bun install && cd ..

# Configure
cp config.yaml.example config.yaml  # Edit with your project details
cp app/.env.example app/.env

# Deploy Firebase security rules
make deploy-rules

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
make deploy-rules    Deploy Firebase security rules
make deploy-all      Deploy agent + infrastructure
make logs            View backend logs
make status          Check deployment status
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full guide.

## License

[MIT](LICENSE) -- Copyright 2026 Irshad Nilam
