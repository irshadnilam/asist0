import datetime
import os
from zoneinfo import ZoneInfo
from google.adk.agents import Agent


def get_current_time(timezone: str = "UTC") -> dict:
    """Returns the current date and time for a given timezone.

    Args:
        timezone (str): The IANA timezone name (e.g., "America/New_York",
                        "Europe/London", "Asia/Colombo"). Defaults to "UTC".

    Returns:
        dict: status and result or error msg.
    """
    try:
        tz = ZoneInfo(timezone)
        now = datetime.datetime.now(tz)
        return {
            "status": "success",
            "report": (
                f"The current date and time in {timezone} is "
                f"{now.strftime('%Y-%m-%d %H:%M:%S %Z')}"
            ),
        }
    except Exception as e:
        return {
            "status": "error",
            "error_message": f"Could not get time for timezone '{timezone}': {e}",
        }


def do_math(expression: str) -> dict:
    """Evaluates a mathematical expression safely.

    Args:
        expression (str): A mathematical expression to evaluate
                          (e.g., "2 + 2", "sqrt(16)", "15 * 3.14").

    Returns:
        dict: status and result or error msg.
    """
    import math

    allowed_names = {k: v for k, v in math.__dict__.items() if not k.startswith("__")}
    allowed_names["abs"] = abs
    allowed_names["round"] = round
    allowed_names["min"] = min
    allowed_names["max"] = max

    try:
        result = eval(expression, {"__builtins__": {}}, allowed_names)
        return {
            "status": "success",
            "result": str(result),
        }
    except Exception as e:
        return {
            "status": "error",
            "error_message": f"Could not evaluate '{expression}': {e}",
        }


# Live API compatible model for Vertex AI
# Override with ASISTO_AGENT_MODEL env var if needed
LIVE_MODEL = os.getenv("ASISTO_AGENT_MODEL", "gemini-live-2.5-flash-native-audio")

root_agent = Agent(
    name="asisto_agent",
    model=LIVE_MODEL,
    description="A general-purpose AI assistant with voice and text support.",
    instruction=(
        "You are Asisto, a helpful and friendly AI assistant. "
        "You can answer general knowledge questions, help with math calculations, "
        "and tell the current time in any timezone. "
        "Be concise but thorough in your responses. "
        "If the user asks about the time, use the get_current_time tool. "
        "If the user asks for math calculations, use the do_math tool. "
        "For general questions, answer directly using your knowledge."
    ),
    tools=[get_current_time, do_math],
)
