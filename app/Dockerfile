# Asisto Frontend - Cloud Run Dockerfile
# TanStack Start + Bun + Nitro (bun preset)

FROM oven/bun:latest

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json bun.lock ./

# Install all dependencies (need devDeps for build)
RUN bun install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Build the production bundle
RUN bun run build

# Cloud Run sets PORT env var (default 8080)
ENV PORT=8080

# Start the production server
CMD ["bun", "run", ".output/server/index.mjs"]
