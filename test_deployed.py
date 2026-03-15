"""
Test script for interacting with the deployed Asisto agent
using VertexAiSessionService and VertexAiMemoryBankService.
"""

import asyncio
from google.adk.sessions import VertexAiSessionService
from google.adk.memory import VertexAiMemoryBankService
from google.adk.runners import Runner
from google.genai.types import Content, Part
from asisto_agent.agent import root_agent

# --- Configuration ---
PROJECT_ID = "asista-hackathon"
LOCATION = "us-central1"
AGENT_ENGINE_ID = "2439436970523361280"
REASONING_ENGINE_APP_NAME = (
    f"projects/{PROJECT_ID}/locations/{LOCATION}/reasoningEngines/{AGENT_ENGINE_ID}"
)
USER_ID = "test_user_1"


async def main():
    # --- Initialize Vertex AI Services ---
    print("Initializing Vertex AI Session and Memory services...")

    session_service = VertexAiSessionService(project=PROJECT_ID, location=LOCATION)
    memory_service = VertexAiMemoryBankService(
        project=PROJECT_ID,
        location=LOCATION,
        agent_engine_id=AGENT_ENGINE_ID,
    )

    # --- Create Runner ---
    runner = Runner(
        agent=root_agent,
        app_name=REASONING_ENGINE_APP_NAME,
        session_service=session_service,
        memory_service=memory_service,
    )

    # --- Create a new session ---
    print("Creating session...")
    session = await session_service.create_session(
        app_name=REASONING_ENGINE_APP_NAME,
        user_id=USER_ID,
    )
    print(f"Session created: {session.id}")

    # --- Interactive chat loop ---
    print("\n--- Asisto Agent (Vertex AI) ---")
    print("Type 'quit' to exit.\n")

    while True:
        user_input = input("You > ")
        if user_input.strip().lower() in ("quit", "exit", "q"):
            break

        message = Content(parts=[Part(text=user_input)], role="user")

        async for event in runner.run_async(
            user_id=USER_ID,
            session_id=session.id,
            new_message=message,
        ):
            if event.is_final_response() and event.content and event.content.parts:
                print(f"Asisto > {event.content.parts[0].text}\n")

    print("Session ended.")


if __name__ == "__main__":
    asyncio.run(main())
