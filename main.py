"""Asisto Agent API with Gemini Live bidirectional streaming over WebSocket."""

import asyncio
import base64
import json
import logging
import os
import warnings
from pathlib import Path

import yaml
import firebase_admin
from firebase_admin import auth as firebase_auth
from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import VertexAiSessionService
from google.adk.memory import VertexAiMemoryBankService
from google.genai import types

from asisto_agent.agent import root_agent


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

    return {
        "project_id": os.getenv("GOOGLE_CLOUD_PROJECT", gcp.get("project_id", "")),
        "region": os.getenv("GOOGLE_CLOUD_LOCATION", gcp.get("region", "us-central1")),
        "engine_id": os.getenv("AGENT_ENGINE_ID", engine.get("resource_id", "")),
    }


cfg = _load_config()
PROJECT_ID = cfg["project_id"]
LOCATION = cfg["region"]
ENGINE_ID = cfg["engine_id"]

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
app = FastAPI(title="Asisto Agent API")

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
runner = Runner(
    agent=root_agent,
    app_name=APP_NAME,
    session_service=session_service,
    memory_service=memory_service,
)


# --- Request/Response Models ---
class CreateWorkspaceResponse(BaseModel):
    workspace_id: str


class WorkspaceInfo(BaseModel):
    workspace_id: str


# --- REST Endpoints (Workspace Management) ---


@app.post("/workspaces", response_model=CreateWorkspaceResponse)
async def create_workspace(user_id: str = Depends(get_current_user)):
    """Create a new workspace (conversation session) for the authenticated user."""
    session = await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
    )
    return CreateWorkspaceResponse(workspace_id=session.id)


@app.get("/workspaces", response_model=list[WorkspaceInfo])
async def list_workspaces(user_id: str = Depends(get_current_user)):
    """List all workspaces for the authenticated user."""
    result = await session_service.list_sessions(
        app_name=APP_NAME,
        user_id=user_id,
    )
    return [WorkspaceInfo(workspace_id=s.id) for s in result.sessions]


@app.get("/workspaces/{workspace_id}", response_model=WorkspaceInfo)
async def get_workspace(workspace_id: str, user_id: str = Depends(get_current_user)):
    """Get a specific workspace."""
    session = await session_service.get_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=workspace_id,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return WorkspaceInfo(workspace_id=session.id)


@app.delete("/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str, user_id: str = Depends(get_current_user)):
    """Delete a workspace."""
    await session_service.delete_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=workspace_id,
    )
    return {"status": "deleted"}


# --- Event Filtering ---

# Keys worth forwarding to the frontend client.
_FORWARD_KEYS = {
    "content",
    "turnComplete",
    "interrupted",
    "inputTranscription",
    "outputTranscription",
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

    Supports:
    - Text messages: JSON {"type": "text", "text": "..."}
    - Image data: JSON {"type": "image", "data": "base64...", "mimeType": "image/jpeg"}
    - Audio data: Raw binary frames (PCM audio, 16kHz, 16-bit)

    Sends back: Filtered JSON-encoded ADK Event objects (text, audio,
    transcriptions, turn_complete, interrupted only).

    Args:
        websocket: The WebSocket connection
        workspace_id: Workspace identifier (create via POST /workspaces first)
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

    # --- Determine response modality based on model ---
    model_name = str(root_agent.model)
    is_native_audio = "native-audio" in model_name.lower()

    if is_native_audio:
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=["AUDIO"],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
        )
    else:
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=["TEXT"],
        )

    # --- Get or create session (workspace_id maps to ADK session_id) ---
    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=workspace_id
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=workspace_id
        )

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
        """Receives Events from run_live(), filters, and sends to WebSocket.

        Only forwards user-facing data: audio, text, transcriptions,
        turnComplete, interrupted. Strips out function calls, function
        responses, and agent-delegation internals.
        """
        async for event in runner.run_live(
            user_id=user_id,
            session_id=workspace_id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        ):
            event_payload = json.loads(
                event.model_dump_json(exclude_none=True, by_alias=True)
            )

            # --- Filter content.parts: drop functionCall / functionResponse ---
            if "content" in event_payload:
                parts = event_payload["content"].get("parts", [])
                # Keep only parts that have text or inlineData (audio)
                clean_parts = [p for p in parts if "text" in p or "inlineData" in p]
                if not clean_parts:
                    # All parts were tool internals — skip the content key
                    del event_payload["content"]
                else:
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

            await websocket.send_text(json.dumps(msg))

    # Run both tasks concurrently
    try:
        await asyncio.gather(upstream_task(), downstream_task())
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as e:
        logger.error(f"Error in streaming tasks: {e}", exc_info=True)
    finally:
        live_request_queue.close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
