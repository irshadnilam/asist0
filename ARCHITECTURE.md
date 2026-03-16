# Architecture

Asisto is a voice-first AI assistant built on the [Google Agent Development Kit (ADK)](https://google.github.io/adk-docs/). This document details the system design, covering the agent architecture, memory system, file management, skills system, frontend windowing, and deployment infrastructure.

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
|  ├─ Image Viewer              |           |  ├─ PreloadMemoryTool (long-term)    |
|  └─ PDF Viewer (react-pdf)    |           |  ├─ SkillToolset (user skills)       |
|                               |           |  ├─ File Tools (13 functions)        |
|  WebGL Orb (72px, bottom-     |           |  └─ AgentEngineSandboxCodeExecutor   |
|  center, shows after connect) |           |                                      |
|  ├─ Audio Capture (16kHz)     |--WS------>|  Session: VertexAiSessionService     |
|  └─ Audio Playback (24kHz)    |<-WS-------|  Memory:  VertexAiMemoryBankService  |
|                               |           +--------------------------------------+
|  TanStack Start Server Fns    |           |  File REST API                       |
|  (REST proxy, no CORS)        |--REST---->|  └─ storage_ops.py                   |
+-------------------------------+           |  Workspace REST API                  |
        |                                   |  └─ GET/PUT /workspace               |
        | Firestore onSnapshot              +-------------|------------------------+
        v                                                 |
+-------------------------------+           +-------------------------------+
| Firestore                     |           | Firebase Storage              |
| users/{uid}/files/{id}        |           | gs://bucket/users/{uid}/...   |
| users/{uid}/workspace/layout  |           | (file blobs + skill files)    |
| (metadata: path, type, size)  |           +-------------------------------+
+-------------------------------+
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
1. **PreloadMemoryTool** -- retrieves relevant memories from past sessions at the start of each turn
2. **SkillToolset** -- user's skills loaded from `/skills/*/SKILL.md` in Firebase Storage
3. **File tools** -- 13 closure-based functions (list, read, write, create, delete, rename, move, search, copy, get info, generate image, edit image)
4. **AgentEngineSandboxCodeExecutor** -- for running skill scripts in a sandbox
5. **Dynamic instruction** -- base instruction + memory section + skill summary + file tool list + image generation guidance

### Voice Streaming (Gemini Live API)

The voice agent uses `gemini-live-2.5-flash-native-audio` via ADK's `runner.run_live()`:

```python
run_config = RunConfig(
    streaming_mode=StreamingMode.BIDI,
    response_modalities=["AUDIO"],
    input_audio_transcription=types.AudioTranscriptionConfig(),
    output_audio_transcription=types.AudioTranscriptionConfig(),
    session_resumption=types.SessionResumptionConfig(),
    context_window_compression=types.ContextWindowCompressionConfig(
        trigger_tokens=100000,
        sliding_window=types.SlidingWindow(target_tokens=80000),
    ),
)
```

- **BIDI streaming** -- full-duplex audio, user and agent can speak simultaneously
- **Native audio output** -- agent responds with natural speech (not TTS)
- **Transcription** -- both input and output audio are transcribed for display
- **Session resumption** -- ADK automatically handles ~10min Live API connection timeouts by caching resumption handles and reconnecting transparently (no application code needed)
- **Context window compression** -- enables unlimited session duration by summarizing older context when token count reaches ~78% of the 128k window, compressing down to ~62%

### Session Management

Each WebSocket connection creates a **fresh ADK session** via `VertexAiSessionService`. Sessions are not reused across connections — this avoids stale history replay. Session resumption handles mid-connection Live API disconnects (network blips, ~10min timeouts) transparently within a single connection's lifetime.

### Long-Term Memory (Vertex AI Memory Bank)

Memory persists across sessions via `VertexAiMemoryBankService`:

**Loading:** `PreloadMemoryTool` is included in every agent's tool list. At the start of each turn, it queries the Memory Bank for relevant memories based on the user's input and injects them into the agent's context.

**Saving:** When a WebSocket disconnects, the backend:
1. Retrieves the completed session via `session_service.get_session()`
2. Calls `memory_service.add_session_to_memory(session)` to ingest the conversation
3. Memory Bank uses an LLM internally to extract and consolidate meaningful information (not raw conversation dumps)

This means the agent remembers user preferences, project details, and past decisions across sessions without explicit configuration.

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
    def copy_file(source: str, destination: str) -> str: ...
    def search_files(query: str) -> list[dict]: ...
    def get_file_info(path: str) -> dict: ...
    def list_all_files() -> list[dict]: ...
    def generate_image(prompt: str, save_path: str = "", aspect_ratio: str = "") -> str: ...
    def edit_image(source_path: str, prompt: str, save_path: str = "", aspect_ratio: str = "") -> str: ...
    return [list_files, read_file, write_file, ...]
```

ADK auto-wraps each function as a `FunctionTool`, inspects its signature and docstring for the LLM function declaration, and injects `ToolContext` if type-annotated.

### Image Generation & Editing

Two tools use `gemini-2.5-flash-image` (the only image generation model available on Vertex AI `us-central1`):

- **`generate_image`** -- creates images from text prompts, saves to workspace (default: `/images/{slug}.png`)
- **`edit_image`** -- reads an existing image, applies edits via prompt, saves result

Supports aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Output is 1024px resolution.

### Event Filtering

The backend filters ADK events before forwarding to the frontend:

```python
_FORWARD_KEYS = {"content", "turnComplete", "interrupted",
                 "inputTranscription", "outputTranscription",
                 "errorCode", "errorMessage", "partial"}
```

Content parts containing `functionCall` or `functionResponse` are stripped. Audio inline data is re-encoded from URL-safe base64 to standard base64 for browser compatibility. The frontend only sees user-facing audio, text, and transcription data.

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
2. Each `SKILL.md` is parsed: YAML frontmatter -> name/description, body -> instructions
3. Scripts in `scripts/` are loaded as `Script(src=...)` objects
4. Skills become ADK `Skill` objects passed to `SkillToolset`
5. Agent instruction is augmented with a summary of available skills
6. Progressive disclosure: L1 metadata at startup, L2 instructions when triggered, L3 resources on demand

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

New users get 4 sample skills auto-created on first access:
- **workspace-helper** -- workspace organization and project scaffolding
- **code-review** -- structured code review with `references/checklist.md`
- **note-taker** -- note and knowledge management
- **learn-skill** -- meta-skill that teaches the agent to create new skills for itself, with `references/skill-spec.md` and `scripts/scaffold_skill.py`

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

Collection: users/{uid}/workspace
Document: layout — { version, savedAt, windows[], fileManagerPath, viewport }
```

### storage_ops.py

Standalone module with pure functions (no FastAPI dependency) so both the REST API and the agent can call them:

- `list_files`, `create_file`, `rename_file`, `delete_files`, `move_files`
- `upload_file`, `download_file_content`, `read_file`, `write_file`
- `get_drive_info`, `seed_default_files`, `list_all_files`, `get_file_info`
- `get_workspace_layout`, `save_workspace_layout`

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
| `GET /workspace` | Get saved workspace layout |
| `PUT /workspace` | Save workspace layout |

## Frontend Architecture

### File Manager

Built with `@svar-ui/react-filemanager` + WillowDark theme:
- **Firestore realtime** (`onSnapshot`) -- no polling, instant updates across tabs
- All files provided upfront as `data` prop (SVAR builds tree from path-based IDs)
- Event-based actions: `create-file`, `rename-file`, `delete-files`, `copy-files`, `move-files`, `download-file`
- `open-file` intercepted (`api.intercept()`) to open floating windows instead of SVAR's default
- "Back to parent folder" link handled via `set-path` navigation (works alongside breadcrumb)

### Floating Editor Windows (WinBox.js)

Files open as independent floating windows powered by WinBox.js:
- **React wrapper** (`Window.tsx`) -- dynamic import to avoid SSR crash, `createPortal` for React children
- Drag, resize, minimize, maximize, close
- Z-index stacking (click brings to front)
- Cascade positioning (30px offset per new window, wraps every 10)
- IDE dark theme: `#161b22` header, `#0d1117` body, themed control buttons (red close, blue maximize, gray minimize), blue-tinted scrollbars
- `onStateChange` callback emits geometry on every move/resize/focus/minimize/maximize for workspace persistence

### File Editor/Viewer

Each window contains a `FileViewer` component that routes by file extension:

| Extension | Viewer |
|-----------|--------|
| `.md`, `.mdx`, `.markdown` | CodeMirror + live markdown preview (side-by-side, 150ms debounced) |
| `.js`, `.ts`, `.py`, `.json`, `.html`, `.css`, `.yaml`, `.xml` + ~60 more | CodeMirror with syntax highlighting |
| `.png`, `.jpg`, `.gif`, `.svg`, `.webp`, `.ico`, `.bmp`, `.avif` | Image viewer |
| `.pdf` | react-pdf viewer with page navigation |
| Unsupported (`.zip`, `.mp3`, `.docx`, etc.) | "Not supported" message, no content fetch |

Features: Cmd+S / Ctrl+S save, modified indicator, refresh button, oneDark theme, JetBrains Mono font.

### Workspace Save/Restore

Window positions, sizes, and the file manager's current path are persisted via backend REST API:

```typescript
interface WorkspaceSnapshot {
  version: 1
  savedAt: string
  windows: { fileId, x, y, width, height, minimized, maximized, zIndex }[]
  fileManagerPath: string | null
  viewport: { width: number; height: number }
}
```

- **Auto-save**: debounced (2s) on every window move/resize/focus/minimize/maximize/close and file manager path change
- **Restore on load**: reads snapshot from backend, reopens windows at saved positions, navigates file manager to last folder
- Saves go through TanStack Start server functions -> FastAPI -> Firestore (not direct browser-to-Firestore)

### Voice Interface

- **WebGL Orb** -- 72px, fixed bottom-center, always visible (z-50)
- **Only appears after WebSocket connects** -- hidden during auth/connection establishment
- Click to toggle mic only (WebSocket stays always-on independently)
- **Audio capture** -- AudioWorklet at 16kHz, float32 -> int16 conversion
- **Audio playback** -- `pcm-player` at 24kHz, PCM int16 from Gemini
- WebSocket connects **directly from browser to FastAPI** (not proxied through Nitro)
- Token passed as `?token=` query param, workspace ID is `"default"` per user
- **Auto-reconnect** with exponential backoff (up to 5 retries, 1s-15s delay)
- Status bar shows connection state, streaming indicator ("thinking..."), last transcript, and errors

### Server Functions (No CORS)

Frontend REST calls use TanStack Start server functions (`createServerFn`). These run on the Nitro server and proxy to FastAPI server-to-server, eliminating CORS entirely. Includes functions for file CRUD, download, content read/write, drive info, workspace save/restore, and backend endpoint discovery.

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
- **Firestore rules** -- `users/{userId}/files/{fileId}` and `users/{userId}/workspace/{docId}`: only `auth.uid == userId` can read/write
- **Storage rules** -- `users/{userId}/{allPaths=**}`: only `auth.uid == userId`
- **No CORS needed** -- frontend REST calls use server functions (same-origin)
- **WebSocket direct** -- browser connects directly to backend (token-authenticated)

## Key Design Decisions

1. **Per-session agents** -- Each user gets a custom agent with their skills, file tools, and memory loaded. No shared global agent state.

2. **Fresh sessions per connection** -- Each WebSocket creates a new ADK session. Session resumption handles mid-connection Live API disconnects transparently, but history is not replayed across page reloads. Long-term continuity comes from Memory Bank instead.

3. **Closure-based tools** -- File tools capture `user_id` and `bucket_name` at creation time. ADK auto-wraps them as FunctionTools. No ToolContext needed for auth.

4. **Dual storage** -- Firebase Storage for blobs, Firestore for metadata. Firestore's realtime `onSnapshot` gives instant UI updates without polling.

5. **WinBox.js over split-view** -- Multiple concurrent floating windows with full window management (drag, resize, minimize, maximize) instead of a single split-view editor.

6. **Dynamic import for SSR** -- WinBox.js accesses `document` at import time. Dynamic `import()` inside `useEffect` avoids SSR crashes in TanStack Start.

7. **SVAR intercept** -- `api.intercept('open-file')` stops SVAR's internal pipeline before it can cause state inconsistencies, then opens our WinBox window or navigates to parent folder.

8. **All files in data prop** -- Instead of lazy loading via `request-data`, all files from Firestore are passed as SVAR's `data` prop. SVAR builds the tree from path-based IDs. This avoids `byId()` returning undefined for selected items.

9. **Forceful tool instructions** -- Native audio models are unreliable at function calling. The agent instruction is very explicit about when to call file tools and skill tools.

10. **Memory over session reuse** -- Instead of reusing sessions (which causes stale history replay), fresh sessions + Memory Bank provides cross-session continuity without the replayed-audio problem.

11. **Workspace persistence via backend** -- Window positions save through server functions -> FastAPI -> Firestore, not direct browser-to-Firestore, ensuring consistent auth and avoiding client-side Firebase SDK issues.
