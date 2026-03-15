"""A2UI update_ui tool — applies A2UI messages to the UI state in session.

The session state key "a2ui" holds the full UI state as a dict of surfaces:
{
  "surfaces": {
    "<surfaceId>": {
      "catalogId": "basic",
      "components": { "<componentId>": { ...component... }, ... },
      "dataModel": { ... }
    },
    ...
  }
}

When the agent calls update_ui with A2UI envelope messages, this tool:
1. Validates the messages.
2. Applies each message to the state (create/upsert/patch/delete surfaces).
3. Writes the updated state back — triggering state_delta.
4. The backend intercepts state_delta["a2ui"] and forwards to the frontend.
"""

import json
import logging
from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# A2UI envelope keys
_ENVELOPE_KEYS = {
    "createSurface",
    "updateComponents",
    "updateDataModel",
    "deleteSurface",
}

# Default empty A2UI state
DEFAULT_A2UI_STATE = {"surfaces": {}}


def _apply_message(state: dict, msg: dict) -> str | None:
    """Apply a single A2UI envelope message to the state. Returns error or None."""
    surfaces = state.setdefault("surfaces", {})

    if "createSurface" in msg:
        payload = msg["createSurface"]
        sid = payload.get("surfaceId")
        if not sid:
            return "createSurface missing surfaceId"
        surfaces[sid] = {
            "catalogId": payload.get("catalogId", "basic"),
            "components": {},
            "dataModel": {},
        }
        if "theme" in payload:
            surfaces[sid]["theme"] = payload["theme"]
        return None

    if "updateComponents" in msg:
        payload = msg["updateComponents"]
        sid = payload.get("surfaceId")
        if not sid:
            return "updateComponents missing surfaceId"
        # Auto-create surface if it doesn't exist (progressive rendering)
        if sid not in surfaces:
            surfaces[sid] = {"catalogId": "basic", "components": {}, "dataModel": {}}
        # Upsert components by ID
        for comp in payload.get("components", []):
            comp_id = comp.get("id")
            if comp_id:
                surfaces[sid]["components"][comp_id] = comp
        return None

    if "updateDataModel" in msg:
        payload = msg["updateDataModel"]
        sid = payload.get("surfaceId")
        if not sid:
            return "updateDataModel missing surfaceId"
        if sid not in surfaces:
            surfaces[sid] = {"catalogId": "basic", "components": {}, "dataModel": {}}
        path = payload.get("path", "/")
        value = payload.get("value")
        if path == "/" or not path:
            # Replace entire data model
            if value is not None:
                surfaces[sid]["dataModel"] = value if isinstance(value, dict) else {}
            else:
                surfaces[sid]["dataModel"] = {}
        else:
            # Set at JSON Pointer path
            _set_at_pointer(surfaces[sid]["dataModel"], path, value)
        return None

    if "deleteSurface" in msg:
        payload = msg["deleteSurface"]
        sid = payload.get("surfaceId")
        if not sid:
            return "deleteSurface missing surfaceId"
        surfaces.pop(sid, None)
        return None

    return "Unknown message type"


def _set_at_pointer(obj: dict, pointer: str, value) -> None:
    """Set a value at a JSON Pointer path (RFC 6901)."""
    if not pointer or pointer == "/":
        return
    segments = pointer.strip("/").split("/")
    segments = [s.replace("~1", "/").replace("~0", "~") for s in segments]
    current = obj
    for seg in segments[:-1]:
        if seg not in current or not isinstance(current.get(seg), dict):
            current[seg] = {}
        current = current[seg]
    if value is None:
        current.pop(segments[-1], None)
    else:
        current[segments[-1]] = value


def update_ui(messages: list, tool_context: ToolContext) -> dict:
    """Update the UI in the user's workspace.

    Applies A2UI protocol messages to the current UI state. The UI
    updates immediately in the user's workspace.

    Args:
        messages: A list of A2UI message objects. Each message object
                  must have exactly one of: createSurface,
                  updateComponents, updateDataModel, deleteSurface.

    Returns:
        dict: Status of the update operation.
    """
    # ADK may pass messages as already-parsed list/dict or as a JSON string
    if isinstance(messages, str):
        try:
            parsed = json.loads(messages)
        except json.JSONDecodeError as e:
            return {"status": "error", "error": f"Invalid JSON: {e}"}
    else:
        parsed = messages

    # Accept a single message or an array
    if isinstance(parsed, dict):
        parsed = [parsed]

    if not isinstance(parsed, list):
        return {
            "status": "error",
            "error": "Expected a JSON object or array of A2UI messages",
        }

    # Normalize items: handle JSON strings inside the array
    normalized = []
    for item in parsed:
        if isinstance(item, str):
            try:
                item = json.loads(item)
            except json.JSONDecodeError:
                pass
        normalized.append(item)
    parsed = normalized

    # Get current UI state from session (or initialize empty)
    ui_state = tool_context.state.get("a2ui", DEFAULT_A2UI_STATE)
    if not isinstance(ui_state, dict):
        ui_state = dict(DEFAULT_A2UI_STATE)

    # Make a mutable copy
    ui_state = json.loads(json.dumps(ui_state))

    # Apply each message
    ops = []
    errors = []
    for i, msg in enumerate(parsed):
        if not isinstance(msg, dict):
            errors.append(f"Message {i} is not an object")
            continue

        envelope_keys = _ENVELOPE_KEYS & set(msg.keys())
        if not envelope_keys:
            errors.append(
                f"Message {i} missing A2UI envelope key, keys={list(msg.keys())}"
            )
            continue

        error = _apply_message(ui_state, msg)
        if error:
            errors.append(f"Message {i}: {error}")
        else:
            ops.extend(envelope_keys)

    if errors:
        logger.warning(f"update_ui errors: {errors}")

    if errors and not ops:
        return {"status": "error", "errors": errors}

    # Write updated state — triggers state_delta
    tool_context.state["a2ui"] = ui_state

    surface_ids = list(ui_state.get("surfaces", {}).keys())
    logger.info(f"update_ui: applied {len(ops)} ops, surfaces={surface_ids}")

    result = {
        "status": "success",
        "applied": len(ops),
        "operations": ops,
        "active_surfaces": surface_ids,
    }
    if errors:
        result["warnings"] = errors
    return result
