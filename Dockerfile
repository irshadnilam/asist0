FROM python:3.13-slim

WORKDIR /app

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files first for better caching
COPY pyproject.toml uv.lock* ./

# Install dependencies (no dev deps, no editable install)
RUN uv sync --no-dev --no-install-project

# Copy application code
COPY main.py .
COPY storage_ops.py .
COPY skill_loader.py .
COPY agent_tools.py .
COPY config.yaml .
COPY asisto_agent/ asisto_agent/

# Expose port
EXPOSE 8080

# Run with uvicorn
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
