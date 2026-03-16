"""Asist0 Agent API with Gemini Live bidirectional streaming over WebSocket."""

import asyncio
import base64
import json
import logging
import os
import posixpath
import warnings
from pathlib import Path
from urllib.parse import unquote

import yaml
import firebase_admin
from firebase_admin import auth as firebase_auth
from fastapi import (
    Depends,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import VertexAiSessionService
from google.adk.memory import VertexAiMemoryBankService
from google.genai import types

from asisto_agent.agent import create_agent
import agent_tools
import storage_ops
import skill_loader


# --- Load Configuration ---
def _load_config() -> dict:
    """Load config from config.yaml, with env var overrides."""
    config_path = Path(__file__).parent / "config.yaml"
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f)
    else:
        config = {}

    # Allow env var overrides
    gcp = config.get("gcp", {})
    engine = config.get("agent_engine", {})
    fb = config.get("firebase", {})

    return {
        "project_id": os.getenv("GOOGLE_CLOUD_PROJECT", gcp.get("project_id", "")),
        "region": os.getenv("GOOGLE_CLOUD_LOCATION", gcp.get("region", "us-central1")),
        "engine_id": os.getenv("AGENT_ENGINE_ID", engine.get("resource_id", "")),
        "storage_bucket": os.getenv("STORAGE_BUCKET", fb.get("storage_bucket", "")),
    }


cfg = _load_config()
PROJECT_ID = cfg["project_id"]
LOCATION = cfg["region"]
ENGINE_ID = cfg["engine_id"]
STORAGE_BUCKET = cfg["storage_bucket"] or None  # None = use default bucket

if not ENGINE_ID:
    raise RuntimeError(
        "Agent Engine resource_id not set. "
        "Set it in config.yaml under agent_engine.resource_id, "
        "or via AGENT_ENGINE_ID env var."
    )

# Ensure ADK/GenAI SDK uses Vertex AI backend (not Google AI / API-key mode).
# The agent's .env is only read by `adk web`; when running via uvicorn we must
# set these explicitly so GoogleLlm picks the correct backend.
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "TRUE")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", PROJECT_ID)
os.environ.setdefault("GOOGLE_CLOUD_LOCATION", LOCATION)

APP_NAME = f"projects/{PROJECT_ID}/locations/{LOCATION}/reasoningEngines/{ENGINE_ID}"

# Configure logging — root at WARNING to silence SDK noise,
# our logger at INFO to see transcripts and errors.
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Suppress Pydantic serialization warnings
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

# --- FastAPI App ---
app = FastAPI(title="Asist0 Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Firebase Auth ---
# Initialize Firebase Admin SDK (uses Application Default Credentials on Cloud Run)
if not firebase_admin._apps:
    firebase_admin.initialize_app()

security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> str:
    """Verify Firebase ID token and return user_id (uid)."""
    try:
        decoded = await asyncio.to_thread(
            firebase_auth.verify_id_token, credentials.credentials
        )
        return decoded["uid"]
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


# --- Vertex AI Services ---
session_service = VertexAiSessionService(
    project=PROJECT_ID, location=LOCATION, agent_engine_id=ENGINE_ID
)
memory_service = VertexAiMemoryBankService(
    project=PROJECT_ID,
    location=LOCATION,
    agent_engine_id=ENGINE_ID,
)


# --- REST Endpoints (File Management — SVAR RestDataProvider compatible) ---


@app.get("/files")
async def get_files(
    id: str = Query(None, description="Parent folder id to list children of"),
    user_id: str = Depends(get_current_user),
):
    """List files. Without id param: root-level items. With id: children of that folder.

    On first request for a new user (no files), seeds default skills.
    """
    logger.info(f"GET /files: user={user_id}, id={id}")
    try:
        files = await asyncio.to_thread(
            storage_ops.list_files, user_id, id, STORAGE_BUCKET
        )
        # Seed defaults for new users (root listing, no files)
        if not files and (id is None or id in ("", "/")):
            logger.info(f"New user {user_id}, seeding default files")
            await asyncio.to_thread(
                storage_ops.seed_default_files, user_id, STORAGE_BUCKET
            )
            files = await asyncio.to_thread(
                storage_ops.list_files, user_id, id, STORAGE_BUCKET
            )
        return files
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/files/{file_id:path}")
async def get_files_by_id(
    file_id: str,
    user_id: str = Depends(get_current_user),
):
    """List children of a specific folder (lazy loading)."""
    decoded_id = f"/{unquote(file_id)}"
    try:
        files = await asyncio.to_thread(
            storage_ops.list_files, user_id, decoded_id, STORAGE_BUCKET
        )
        return files
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/files")
async def create_file_root(
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Create a new file or folder at root level.

    Body: { "name": "new-name", "type": "folder" | "file" }
    """
    body = await request.json()
    name = body.get("name", "untitled")
    file_type = body.get("type", "folder")
    new_id = f"/{name}"
    logger.info(f"POST /files: user={user_id}, name={name}, type={file_type}")

    try:
        result = await asyncio.to_thread(
            storage_ops.create_file, user_id, new_id, file_type, STORAGE_BUCKET
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/files/{file_id:path}")
async def create_file(
    file_id: str,
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Create a new file or folder.

    Body: { "name": "new-name", "type": "folder" | "file" }
    file_id in path is the parent folder id.
    """
    body = await request.json()
    name = body.get("name", "untitled")
    file_type = body.get("type", "folder")
    parent_id = f"/{unquote(file_id)}" if file_id else "/"

    new_id = posixpath.join(parent_id, name) if parent_id != "/" else f"/{name}"

    try:
        result = await asyncio.to_thread(
            storage_ops.create_file, user_id, new_id, file_type, STORAGE_BUCKET
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/files/{file_id:path}")
async def rename_file(
    file_id: str,
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Rename a file or folder.

    Body: { "name": "new-name" }
    """
    body = await request.json()
    new_name = body.get("name")
    if not new_name:
        raise HTTPException(status_code=400, detail="Missing 'name' in body")

    decoded_id = f"/{unquote(file_id)}"

    try:
        result = await asyncio.to_thread(
            storage_ops.rename_file, user_id, decoded_id, new_name, STORAGE_BUCKET
        )
        return result
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/files")
async def move_files(
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Move or copy files.

    Body: { "ids": ["/path1", "/path2"], "target": "/dest-folder", "copy": false }
    """
    body = await request.json()
    ids = body.get("ids", [])
    target = body.get("target", "/")
    copy = body.get("copy", False)

    if not ids:
        raise HTTPException(status_code=400, detail="Missing 'ids' in body")

    try:
        results = await asyncio.to_thread(
            storage_ops.move_files, user_id, ids, target, copy, STORAGE_BUCKET
        )
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/files")
async def delete_files(
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Delete files/folders.

    Body: { "ids": ["/path1", "/path2"] }
    """
    body = await request.json()
    ids = body.get("ids", [])

    if not ids:
        raise HTTPException(status_code=400, detail="Missing 'ids' in body")

    try:
        await asyncio.to_thread(storage_ops.delete_files, user_id, ids, STORAGE_BUCKET)
        return {"status": "deleted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/upload")
async def upload_file_root(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user),
):
    """Upload a file to root level."""
    content = await file.read()
    filename = file.filename or "unnamed"

    try:
        result = await asyncio.to_thread(
            storage_ops.upload_file,
            user_id,
            "/",
            filename,
            content,
            file.content_type or "application/octet-stream",
            STORAGE_BUCKET,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/upload/{file_id:path}")
async def upload_file(
    file_id: str,
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user),
):
    """Upload a file to a folder.

    file_id in path is the parent folder id.
    File is sent as multipart form data.
    """
    parent_id = f"/{unquote(file_id)}" if file_id else "/"
    content = await file.read()
    filename = file.filename or "unnamed"

    try:
        result = await asyncio.to_thread(
            storage_ops.upload_file,
            user_id,
            parent_id,
            filename,
            content,
            file.content_type or "application/octet-stream",
            STORAGE_BUCKET,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/info")
async def get_info(user_id: str = Depends(get_current_user)):
    """Get drive storage info. Seeds defaults for new users."""
    try:
        info = await asyncio.to_thread(storage_ops.get_drive_info, user_id)
        # Seed defaults for new users (no files at all)
        if info.get("used", 0) == 0:
            seeded = await asyncio.to_thread(
                storage_ops.seed_default_files, user_id, STORAGE_BUCKET
            )
            if seeded:
                info = await asyncio.to_thread(storage_ops.get_drive_info, user_id)
        return {"stats": info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/download/{file_id:path}")
async def download_file(
    file_id: str,
    user_id: str = Depends(get_current_user),
):
    """Download a file. Returns the file content directly."""
    decoded_id = f"/{unquote(file_id)}"
    name = posixpath.basename(decoded_id)
    try:
        content, content_type = await asyncio.to_thread(
            storage_ops.download_file_content, user_id, decoded_id, STORAGE_BUCKET
        )
        return Response(
            content=content,
            media_type=content_type,
            headers={
                "Content-Disposition": f'attachment; filename="{name}"',
            },
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Workspace Layout Persistence ---


@app.get("/workspace")
async def get_workspace(user_id: str = Depends(get_current_user)):
    """Get the user's saved workspace layout snapshot."""
    try:
        snapshot = await asyncio.to_thread(storage_ops.get_workspace_layout, user_id)
        return snapshot or {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/workspace")
async def save_workspace(
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Save the user's workspace layout snapshot."""
    body = await request.json()
    try:
        await asyncio.to_thread(storage_ops.save_workspace_layout, user_id, body)
        return {"status": "saved"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Event Filtering ---

# Keys worth forwarding to the frontend client.
_FORWARD_KEYS = {
    "content",
    "turnComplete",
    "interrupted",
    "inputTranscription",
    "outputTranscription",
    "errorCode",
    "errorMessage",
    "partial",
}


# --- WebSocket Endpoint (Gemini Live Bidirectional Streaming) ---


@app.websocket("/ws/{workspace_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    workspace_id: str,
) -> None:
    """WebSocket endpoint for bidirectional streaming with ADK Gemini Live API.

    Authentication: Pass Firebase ID token as `token` query parameter.
    Example: ws://host/ws/{workspace_id}?token=FIREBASE_ID_TOKEN

    On connect, loads the user's skills from /skills/ in Firebase Storage
    and creates a per-session agent with those skills via SkillToolset.

    Supports:
    - Text messages: JSON {"type": "text", "text": "..."}
    - Image data: JSON {"type": "image", "data": "base64...", "mimeType": "image/jpeg"}
    - Audio data: Raw binary frames (PCM audio, 16kHz, 16-bit)

    Sends back: Filtered JSON-encoded ADK Event objects (text, audio,
    transcriptions, turn_complete, interrupted only).
    """
    # Authenticate via query param
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001, reason="Missing token query parameter")
        return
    try:
        decoded = await asyncio.to_thread(firebase_auth.verify_id_token, token)
        user_id = decoded["uid"]
    except Exception as e:
        await websocket.close(code=4001, reason=f"Invalid token: {e}")
        return

    logger.info(f"WebSocket connected: user_id={user_id}, workspace_id={workspace_id}")
    await websocket.accept()

    # --- Load user skills from Firebase Storage ---
    try:
        user_skills = await asyncio.to_thread(
            skill_loader.load_user_skills, user_id, STORAGE_BUCKET
        )
        if user_skills:
            logger.info(
                f"Loaded {len(user_skills)} skills for user {user_id}: "
                + ", ".join(s.frontmatter.name for s in user_skills)
            )
    except Exception as e:
        logger.warning(f"Failed to load user skills: {e}")
        user_skills = []

    # --- Create file-operation tools for this user ---
    file_tools = agent_tools.create_file_tools(
        user_id=user_id, bucket_name=STORAGE_BUCKET
    )

    # --- Create per-session agent with user's skills + file tools ---
    session_agent = create_agent(
        user_skills=user_skills or None,
        agent_engine_resource_name=APP_NAME,
        file_tools=file_tools,
    )

    # Create a per-session runner
    session_runner = Runner(
        agent=session_agent,
        app_name=APP_NAME,
        session_service=session_service,
        memory_service=memory_service,
    )

    # --- Determine response modality based on model ---
    model_name = str(session_agent.model)
    is_native_audio = "native-audio" in model_name.lower()

    # Session resumption: ADK automatically handles ~10min connection timeouts
    # by caching resumption handles and reconnecting transparently.
    session_resumption = types.SessionResumptionConfig()

    # Context window compression: enables unlimited session duration by
    # summarizing older context when token count reaches trigger_tokens.
    # gemini-2.5-flash-native-audio has a 128k context window.
    context_compression = types.ContextWindowCompressionConfig(
        trigger_tokens=100000,  # ~78% of 128k — start compressing
        sliding_window=types.SlidingWindow(
            target_tokens=80000  # ~62% of 128k — compress down to this
        ),
    )

    if is_native_audio:
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=["AUDIO"],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            session_resumption=session_resumption,
            context_window_compression=context_compression,
        )
    else:
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=["TEXT"],
            session_resumption=session_resumption,
            context_window_compression=context_compression,
        )

    # --- Create a new session for each WebSocket connection ---
    session = await session_service.create_session(app_name=APP_NAME, user_id=user_id)
    session_id = session.id
    logger.info(f"Created session {session_id} for user {user_id}")

    live_request_queue = LiveRequestQueue()

    # --- Concurrent bidirectional streaming tasks ---

    async def upstream_task() -> None:
        """Receives messages from WebSocket and forwards to LiveRequestQueue."""
        while True:
            message = await websocket.receive()

            # Binary frames = audio data (PCM 16kHz 16-bit)
            if "bytes" in message:
                audio_data = message["bytes"]
                audio_blob = types.Blob(
                    mime_type="audio/pcm;rate=16000", data=audio_data
                )
                live_request_queue.send_realtime(audio_blob)

            # Text frames = JSON messages (text or image)
            elif "text" in message:
                text_data = message["text"]
                json_message = json.loads(text_data)

                if json_message.get("type") == "text":
                    content = types.Content(
                        parts=[types.Part(text=json_message["text"])]
                    )
                    live_request_queue.send_content(content)

                elif json_message.get("type") == "image":
                    image_data = base64.b64decode(json_message["data"])
                    mime_type = json_message.get("mimeType", "image/jpeg")
                    image_blob = types.Blob(mime_type=mime_type, data=image_data)
                    live_request_queue.send_realtime(image_blob)

    async def downstream_task() -> None:
        """Receives Events from run_live(), filters, and sends to WebSocket."""
        async for event in session_runner.run_live(
            user_id=user_id,
            session_id=session_id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        ):
            event_payload = json.loads(
                event.model_dump_json(exclude_none=True, by_alias=True)
            )

            # --- Detect tool calls and forward synthetic toolActivity events ---
            if "content" in event_payload:
                parts = event_payload["content"].get("parts", [])
                for part in parts:
                    fc = part.get("functionCall")
                    if fc and fc.get("name"):
                        tool_msg = {"toolActivity": {"name": fc["name"]}}
                        await websocket.send_text(json.dumps(tool_msg))

            # --- Filter content.parts: drop functionCall / functionResponse ---
            if "content" in event_payload:
                parts = event_payload["content"].get("parts", [])
                clean_parts = [p for p in parts if "text" in p or "inlineData" in p]
                if not clean_parts:
                    del event_payload["content"]
                else:
                    # Pydantic serializes bytes as URL-safe base64 (- and _).
                    # The browser's atob() requires standard base64 (+ and /).
                    # Re-encode inline audio data to standard base64 here so the
                    # frontend can decode with plain atob().
                    for part in clean_parts:
                        inline = part.get("inlineData")
                        if inline and "data" in inline:
                            raw = base64.urlsafe_b64decode(inline["data"])
                            inline["data"] = base64.b64encode(raw).decode("ascii")
                    event_payload["content"]["parts"] = clean_parts

            # --- Build the forwarded message with only client-relevant keys ---
            msg = {}
            for key in _FORWARD_KEYS:
                if key in event_payload:
                    msg[key] = event_payload[key]

            if not msg:
                continue

            # Log complete transcriptions only
            if "inputTranscription" in msg:
                t = msg["inputTranscription"]
                if isinstance(t, dict) and t.get("finished"):
                    logger.info(f"[user] {t.get('text', '')}")
                elif isinstance(t, str):
                    logger.info(f"[user] {t}")
            if "outputTranscription" in msg:
                t = msg["outputTranscription"]
                if isinstance(t, dict) and t.get("finished"):
                    logger.info(f"[agent] {t.get('text', '')}")
                elif isinstance(t, str):
                    logger.info(f"[agent] {t}")

            # Log errors
            if "errorCode" in msg or "errorMessage" in msg:
                logger.error(
                    f"Agent error: code={msg.get('errorCode')}, "
                    f"message={msg.get('errorMessage')}"
                )

            await websocket.send_text(json.dumps(msg))

    # Run both tasks concurrently
    try:
        await asyncio.gather(upstream_task(), downstream_task())
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        live_request_queue.close()

        # Memory is now saved automatically via after_agent_callback
        # (_auto_save_session_to_memory) after each agent turn, so we
        # no longer need to manually call add_session_to_memory() here.

        # Ensure clean close so the client can detect disconnect and reconnect
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
