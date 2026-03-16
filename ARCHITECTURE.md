# Architecture

Asisto is a voice-first AI assistant built on the [Google Agent Development Kit (ADK)](https://google.github.io/adk-docs/). This document details the system design, covering the agent architecture, file management, skills system, frontend windowing, and deployment infrastructure.

## System Overview

```
Browser (React 19)                          Cloud Run (FastAPI)
+-------------------------------+           +--------------------------------------+
|  SVAR File Manager            |           |  WebSocket Handler                   |
|  (Firestore realtime sync)    |           |  └─ ADK Runner (run_live, BIDI)      |
|                               |           |                                      |
|  WinBox Floating Windows      |           |  Per-Session Agent                   |
|  ├─ CodeMirror 6 Editor       |           |  ├─ gemini-live-2.5-flash-native-    |
|  ├─ Markdown Preview          |           |  │  audio (Live API)                 |
|  └─ Image Viewer              |           |  ├─ SkillToolset (user skills)       |
|                               |           |  ├─ File Tools (7 functions)         |
|  WebGL Orb (56px, bottom-left)|           |  └─ AgentEngineSandboxCodeExecutor   |
|  ├─ Audio Capture (16kHz)     |--WS------>|                                      |
|  └─ Audio Playback (24kHz)    |<-WS-------|  Session: VertexAiSessionService     |
|                               |           |  Memory:  VertexAiMemoryBankService  |
|  TanStack Start Server Fns    |           +--------------------------------------+
|  (REST proxy, no CORS)        |--REST---->|  File REST API                       |
+-------------------------------+           |  └─ storage_ops.py                   |
        |                                   +-------------|------------------------+
        | Firestore onSnapshot                            |
        v                                                 v
+-------------------------------+           +-------------------------------+
| Firestore                     |           | Firebase Storage              |
| users/{uid}/files/{id}        |           | gs://bucket/users/{uid}/...   |
| (metadata: path, type, size)  |           | (file blobs + skill files)    |
+-------------------------------+           +-------------------------------+
```

## Agent Architecture

### Per-Session Agent Factory

Unlike static agent configurations, Asisto creates a **per-session agent** for each WebSocket connection. The `create_agent()` factory in `asisto_agent/agent.py` builds a custom agent tailored to each user's skills and files:

```python
def create_agent(
    user_skills: list[Skill] | None = None,
    agent_engine_resource_name: str | None = None,
    file_tools: list | None = None,
) -> Agent:
```

Each session agent includes:
1. **SkillToolset** -- user's skills loaded from `/skills/*/SKILL.md` in Firebase Storage
2. **File tools** -- 7 closure-based functions (list, read, write, create, delete, rename, move)
3. **AgentEngineSandboxCodeExecutor** -- for running skill scripts in a sandbox
4. **Dynamic instruction** -- base instruction + skill summary + file tool guidance

### Voice Streaming (Gemini Live API)

The voice agent uses `gemini-live-2.5-flash-native-audio` via ADK's `runner.run_live()`:

```python
run_config = RunConfig(
    streaming_mode=StreamingMode.BIDI,
    response_modalities=["AUDIO"],
    input_audio_transcription=types.AudioTranscriptionConfig(),
    output_audio_transcription=types.AudioTranscriptionConfig(),
    session_resumption=types.SessionResumptionConfig(),
)
```

- **BIDI streaming** -- full-duplex audio, user and agent can speak simultaneously
- **Native audio output** -- agent responds with natural speech (not TTS)
- **Transcription** -- both input and output audio are transcribed for display
- **Session resumption** -- reconnects gracefully if the Live API connection drops

### Agent File Tools

The agent can manipulate files in the user's workspace via voice commands. Tools are created as closures that capture `user_id` and `bucket_name`:

```python
# agent_tools.py
def create_file_tools(user_id: str, bucket_name: str) -> list:
    def list_files(path: str = "/") -> list[dict]: ...
    def read_file(path: str) -> str: ...
    def write_file(path: str, content: str) -> str: ...
    def create_folder(path: str) -> str: ...
    def delete_file(path: str) -> str: ...
    def rename_file(path: str, new_name: str) -> str: ...
    def move_file(path: str, destination: str) -> str: ...
    return [list_files, read_file, write_file, ...]
```

ADK auto-wraps each function as a `FunctionTool`, inspects its signature and docstring for the LLM function declaration, and injects `ToolContext` if type-annotated.

### Event Filtering

The backend filters ADK events before forwarding to the frontend:

```python
_FORWARD_KEYS = {"content", "turnComplete", "interrupted",
                 "inputTranscription", "outputTranscription"}
```

Content parts containing `functionCall` or `functionResponse` are stripped. The frontend only sees user-facing audio, text, and transcription data.

## Skills System

### User-Extensible Agent Skills

Users create skills as files in their workspace following the [Agent Skills spec](https://agentskills.io/specification):

```
/skills/
  /skill-name/
    SKILL.md              ← Required: YAML frontmatter + markdown instructions
    references/           ← Optional: detailed docs loaded on demand
    assets/               ← Optional: templates, data files
    scripts/              ← Optional: executable .py/.sh scripts
```

### Skill Loading Flow

1. On WebSocket connect, `skill_loader.py` reads all `SKILL.md` files from `gs://bucket/users/{uid}/skills/*/SKILL.md`
2. Each `SKILL.md` is parsed: YAML frontmatter → name/description, body → instructions
3. Skills become ADK `Skill` objects passed to `SkillToolset`
4. Agent instruction is augmented with a summary of available skills
5. Progressive disclosure: L1 metadata at startup, L2 instructions when triggered, L3 resources on demand

### Sandbox Code Execution

Skill scripts execute in `AgentEngineSandboxCodeExecutor`:

```python
executor = AgentEngineSandboxCodeExecutor(
    agent_engine_resource_name="projects/.../reasoningEngines/..."
)
toolset = SkillToolset(skills=user_skills, code_executor=executor)
```

- Sandbox created per-session, persists for session duration (TTL: 1 year)
- Supports Python (via `runpy`) and shell scripts (via `subprocess`)
- State persists within a session across multiple script executions
- Falls back gracefully -- if executor creation fails, skill instructions still work

### Default Seed Skills

New users get 3 sample skills auto-created on first access:
- **prompt-helper** -- prompt engineering guidance
- **code-review** -- structured code review with `references/checklist.md`
- **summarize** -- text summarization

## Storage Architecture

### Dual Storage System

**Firebase Storage** holds file blobs:
```
gs://asista-hackathon.firebasestorage.app/
  users/{uid}/{path...}
```

**Firestore** holds file metadata with realtime sync:
```
Collection: users/{uid}/files
Document: { id: "/path/to/file", size, date, type: "file"|"folder" }
```

### storage_ops.py

Standalone module with pure functions (no FastAPI dependency) so both the REST API and the agent can call them:

- `list_files`, `create_item`, `rename_item`, `delete_items`, `move_items`
- `upload_file`, `download_url`, `read_file`, `write_file`
- `get_drive_info`, `seed_default_files`

### REST API (SVAR-Compatible)

The file REST endpoints match SVAR Filemanager's expected action-based API:

| Route | Method | Purpose |
|---|---|---|
| `GET /files` | List root items |
| `GET /files/{id}` | List folder contents |
| `POST /files` | Create file/folder at root |
| `POST /files/{id}` | Create in subfolder |
| `POST /upload` | Upload at root |
| `POST /upload/{id}` | Upload to subfolder |
| `PUT /files/{id}` | Rename |
| `PUT /files` | Move/copy |
| `DELETE /files` | Delete |
| `GET /download/{id}` | Stream file content |

## Frontend Architecture

### File Manager

Built with `@svar-ui/react-filemanager` + WillowDark theme:
- **Firestore realtime** (`onSnapshot`) -- no polling, instant updates across tabs
- All files provided upfront as `data` prop (SVAR builds tree from path-based IDs)
- Event-based actions: `create-file`, `rename-file`, `delete-files`, `copy-files`, `move-files`, `download-file`
- `open-file` intercepted (`api.intercept()`) to open floating windows instead of SVAR's default

### Floating Editor Windows (WinBox.js)

Files open as independent floating windows powered by WinBox.js:
- **React wrapper** (`Window.tsx`) -- dynamic import to avoid SSR crash, `createPortal` for React children
- Drag, resize, minimize, maximize, close
- Z-index stacking (click brings to front)
- Cascade positioning (30px offset per new window)
- IDE dark theme: `#161b22` header, `#0d1117` body, themed control buttons (red close, blue maximize, gray minimize), blue-tinted scrollbars

### File Editor/Viewer

Each window contains a `FileViewer` component that routes by file extension:

| Extension | Viewer |
|-----------|--------|
| `.md`, `.mdx` | CodeMirror + live markdown preview (side-by-side, 150ms debounced) |
| `.js`, `.ts`, `.py`, `.json`, `.html`, `.css`, `.yaml`, `.xml` | CodeMirror with syntax highlighting |
| `.png`, `.jpg`, `.gif`, `.svg`, `.webp` | Image viewer |
| Everything else | Plain text editor |

Features: Cmd+S / Ctrl+S save, modified indicator, oneDark theme, JetBrains Mono font.

### Voice Interface

- **WebGL Orb** -- 56px, fixed bottom-left corner, always visible (z-50)
- Click to toggle: connect WebSocket + start mic, or disconnect + stop
- **Audio capture** -- AudioWorklet at 16kHz, float32 → int16 conversion
- **Audio playback** -- `pcm-player` at 24kHz, PCM int16 from Gemini
- WebSocket connects **directly from browser to FastAPI** (not proxied through Nitro)
- Token passed as `?token=` query param, workspace ID is `"default"` per user

### Server Functions (No CORS)

Frontend REST calls use TanStack Start server functions (`createServerFn`). These run on the Nitro server and proxy to FastAPI server-to-server, eliminating CORS entirely.

## Infrastructure

### Deployment Stack

| Component | Technology | Hosting |
|-----------|-----------|---------|
| Voice Agent | ADK + Gemini Live API | Cloud Run |
| File API | FastAPI + storage_ops | Cloud Run (same service) |
| Session Storage | VertexAiSessionService | Agent Engine |
| Memory | VertexAiMemoryBankService | Agent Engine |
| File Storage | Firebase Storage + Firestore | Google-managed |
| Frontend | TanStack Start + Bun + Nitro | Cloud Run |
| Auth | Firebase Authentication | Google-managed |
| IaC | Pulumi (Python, local state) | N/A |

### Pulumi Resources

The `infra/__main__.py` provisions:
1. GCP APIs (Vertex AI, Cloud Run, Artifact Registry, Firebase, Firestore, Storage)
2. Artifact Registry repository
3. Service account with roles: Vertex AI User, Datastore User, Storage Object Admin, Token Creator
4. Backend Docker image + Cloud Run service
5. Frontend Docker image + Cloud Run service (gets `API_ENDPOINT` from backend URL)
6. Optional custom domain mappings

### Custom Domains

- `asisto.agents.sh` -- frontend
- `asisto-api.agents.sh` -- backend

Both configured via `gcp.cloudrun.DomainMapping` in Pulumi.

## Security

- **Firebase Auth** -- all REST endpoints require Bearer token, WebSocket requires `?token=` query param
- **User isolation** -- user ID extracted from Firebase token on every request, never in URL path
- **Firestore rules** -- `users/{userId}/files/{fileId}`: only `auth.uid == userId` can read/write
- **Storage rules** -- `users/{userId}/{allPaths=**}`: only `auth.uid == userId`
- **No CORS needed** -- frontend REST calls use server functions (same-origin)
- **WebSocket direct** -- browser connects directly to backend (token-authenticated)

## Key Design Decisions

1. **Per-session agents** -- Each user gets a custom agent with their skills and file tools loaded. No shared global agent state.

2. **Closure-based tools** -- File tools capture `user_id` and `bucket_name` at creation time. ADK auto-wraps them as FunctionTools. No ToolContext needed for auth.

3. **Dual storage** -- Firebase Storage for blobs, Firestore for metadata. Firestore's realtime `onSnapshot` gives instant UI updates without polling.

4. **WinBox.js over split-view** -- Multiple concurrent floating windows with full window management (drag, resize, minimize, maximize) instead of a single split-view editor.

5. **Dynamic import for SSR** -- WinBox.js accesses `document` at import time. Dynamic `import()` inside `useEffect` avoids SSR crashes in TanStack Start.

6. **SVAR intercept** -- `api.intercept('open-file')` stops SVAR's internal pipeline before it can cause state inconsistencies, then opens our WinBox window.

7. **All files in data prop** -- Instead of lazy loading via `request-data`, all files from Firestore are passed as SVAR's `data` prop. SVAR builds the tree from path-based IDs. This avoids `byId()` returning undefined for selected items.

8. **Forceful tool instructions** -- Native audio models are unreliable at function calling. The agent instruction is very explicit about when to call file tools and skill tools.
