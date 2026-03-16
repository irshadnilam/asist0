# Asisto Deployment Guide

This guide covers deploying Asisto to Google Cloud:
- Agent deployment to **Vertex AI Agent Engine**
- Backend + frontend to **Cloud Run**
- **Firebase** Authentication, Storage, and Firestore
- Infrastructure management with **Pulumi** (Python, local state)

## Architecture

```
┌─────────────────┐                    ┌──────────────────┐
│  Browser         │     HTTPS          │  Cloud Run       │
│  (Firebase Auth) │◄──────────────────►│  (TanStack Start)│
│  (Firestore      │                    │  asisto-app      │
│   realtime sync) │                    └────────┬─────────┘
└─────────────────┘                              │ API_ENDPOINT
                                                 ▼
        ┌────── WS (direct) ──────►  ┌──────────────────┐
        │                            │  Cloud Run       │
        │                            │  (FastAPI + WS)  │
        │                            │  asisto-api      │
        │                            └────────┬─────────┘
        │                                     │
        │              ┌──────────────────────┼──────────────────────┐
        │              │                      │                      │
        │              ▼                      ▼                      ▼
        │   ┌────────────────┐    ┌─────────────────┐    ┌────────────────┐
        │   │ Agent Engine   │    │ Firebase Storage │    │ Firestore      │
        │   │ (Sessions +    │    │ (file blobs +    │    │ (file metadata │
        │   │  Memory Bank)  │    │  skill files)    │    │  + realtime)   │
        │   └────────────────┘    └─────────────────┘    └────────────────┘
```

## Prerequisites

### Required tools

| Tool | Purpose | Install |
|------|---------|---------|
| **gcloud CLI** | Google Cloud auth & management | [Install](https://cloud.google.com/sdk/docs/install) |
| **Python 3.13+** | Runtime | [python.org](https://www.python.org/) |
| **uv** | Python package manager | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **Pulumi** | Infrastructure as code | `brew install pulumi/tap/pulumi` |
| **Docker** | Container image builds | [docker.com](https://www.docker.com/) |
| **Bun** | Frontend runtime + package manager | `curl -fsSL https://bun.sh/install \| bash` |
| **Firebase CLI** | Rules deployment | `npm install -g firebase-tools` |
| **make** | Build orchestration | Pre-installed on macOS/Linux |

### Required GCP APIs

Automatically enabled by Pulumi, or enable manually:

```bash
gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable cloudresourcemanager.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable run.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable artifactregistry.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable cloudbuild.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable firebase.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable identitytoolkit.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable firestore.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable storage.googleapis.com --project=YOUR_PROJECT_ID
```

---

## Step 1: Authenticate with Google Cloud

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
```

## Step 2: Setup Firebase

### Add Firebase to your GCP project

```bash
firebase projects:addfirebase YOUR_PROJECT_ID
```

### Create a web app

```bash
firebase apps:create WEB asisto-web --project=YOUR_PROJECT_ID
firebase apps:sdkconfig WEB APP_ID --project=YOUR_PROJECT_ID
```

Update the Firebase config in `app/src/lib/firebase.ts` with the output values.

### Enable Google Sign-In

1. Go to [Firebase Console](https://console.firebase.google.com/) → Authentication → Sign-in method
2. Enable **Google** provider
3. Add your Cloud Run frontend domain to **Authorized domains**

### Create Firestore database

```bash
gcloud firestore databases create --location=us-central1 --project=YOUR_PROJECT_ID
```

### Deploy security rules

```bash
make deploy-rules
```

This deploys both `firestore.rules` and `storage.rules`:
- Firestore: `users/{userId}/files/{fileId}` -- only `auth.uid == userId`
- Storage: `users/{userId}/{allPaths=**}` -- only `auth.uid == userId`

## Step 3: Create config.yaml

```bash
cp config.yaml.example config.yaml
```

Edit `config.yaml`:

```yaml
gcp:
  project_id: "your-gcp-project-id"
  region: "us-central1"

agent_engine:
  resource_id: ""  # Fill after deploying agent (Step 4)

cloud_run:
  service_name: "asisto-api"
  min_instances: 0
  max_instances: 5

frontend:
  service_name: "asisto-app"
  min_instances: 0
  max_instances: 3

firebase:
  storage_bucket: "your-project-id.firebasestorage.app"

agent:
  model: "gemini-live-2.5-flash-native-audio"
  display_name: "Asisto Agent"
```

**Important:** `config.yaml` is in `.gitignore`. Never commit it.

## Step 4: Deploy Agent to Agent Engine

```bash
make deploy-agent
```

On success:

```
AgentEngine created. Resource name:
  projects/123456/locations/us-central1/reasoningEngines/2439436970523361280
```

Copy the resource ID and update `config.yaml`:

```yaml
agent_engine:
  resource_id: "2439436970523361280"
```

### Find your resource ID later

```bash
gcloud ai reasoning-engines list --project=YOUR_PROJECT_ID --region=us-central1
```

## Step 5: Setup Pulumi

### Configure state backend

**Local file (recommended for solo dev):**
```bash
pulumi login --local
```

Set empty passphrase when prompted (or set `PULUMI_CONFIG_PASSPHRASE=""`).

### Run setup

```bash
make setup
```

This:
1. Configures Docker for Artifact Registry
2. Installs Pulumi Python packages
3. Creates a Pulumi stack named `dev`

## Step 6: Deploy Infrastructure

Preview:
```bash
make preview
```

Deploy:
```bash
make deploy-infra
```

This provisions:
1. **Artifact Registry** -- Docker image repository
2. **Service Account** -- with Vertex AI User, Datastore User, Storage Object Admin, Token Creator roles
3. **Backend Cloud Run** -- FastAPI + WebSocket + ADK runner + file API
4. **Frontend Cloud Run** -- TanStack Start (Bun + Nitro)
5. **Docker images** -- built and pushed for both services

Pulumi outputs:
```
service_url:    "https://asisto-api-xxxxx-uc.a.run.app"
frontend_url:   "https://asisto-app-xxxxx-uc.a.run.app"
```

The frontend's `API_ENDPOINT` is automatically set to the backend URL by Pulumi.

### Deploy everything at once

```bash
make deploy-all
```

## API Endpoints

All REST endpoints require `Authorization: Bearer <firebase-id-token>`.

### File Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/files` | List root-level files |
| `GET` | `/files/{id}` | List folder contents |
| `POST` | `/files` | Create file/folder at root |
| `POST` | `/files/{id}` | Create in subfolder |
| `POST` | `/upload` | Upload file at root |
| `POST` | `/upload/{id}` | Upload to subfolder |
| `PUT` | `/files/{id}` | Rename |
| `PUT` | `/files` | Move/copy |
| `DELETE` | `/files` | Delete |
| `GET` | `/download/{id}` | Stream file content |
| `GET` | `/info` | Drive info + auto-seed for new users |

### WebSocket

**Connect:** `wss://BACKEND_URL/ws/default?token=FIREBASE_ID_TOKEN`

| Direction | Format | Description |
|-----------|--------|-------------|
| Client → Server | JSON `{"type": "text", "text": "..."}` | Text message |
| Client → Server | Binary (PCM 16kHz 16-bit) | Audio |
| Server → Client | JSON with `content`, `turnComplete`, `interrupted` | Agent response |
| Server → Client | JSON with `inputTranscription` / `outputTranscription` | Transcriptions |

## Configuration Reference

| Config path | Env var override | Description |
|-------------|-----------------|-------------|
| `gcp.project_id` | `GOOGLE_CLOUD_PROJECT` | GCP project ID |
| `gcp.region` | `GOOGLE_CLOUD_LOCATION` | GCP region (must be `us-central1` for Live API) |
| `agent_engine.resource_id` | `AGENT_ENGINE_ID` | Agent Engine resource ID |
| `agent.model` | `ASISTO_AGENT_MODEL` | Gemini model name |
| `firebase.storage_bucket` | `STORAGE_BUCKET` | Firebase Storage bucket |

## Updating

### Agent changes (`asisto_agent/`)

```bash
make deploy-agent       # Creates new Agent Engine resource
# Update config.yaml with new resource_id
make deploy-infra       # Redeploy Cloud Run
```

### Backend changes (`main.py`, `storage_ops.py`, `agent_tools.py`, `skill_loader.py`)

```bash
make deploy-infra       # Rebuilds Docker image + redeploys
```

### Frontend changes (`app/`)

```bash
make deploy-frontend    # Rebuilds + redeploys frontend only
```

### Firebase rules changes

```bash
make deploy-rules
```

## Custom Domains (Optional)

### 1. Verify domain ownership

```bash
gcloud domains verify agents.sh
```

### 2. Configure in config.yaml

```yaml
domains:
  frontend: "asisto.agents.sh"
  api: "asisto-api.agents.sh"
```

### 3. Deploy

```bash
make deploy-infra
```

### 4. Add DNS records

| Name | Type | Value |
|------|------|-------|
| `asisto.agents.sh` | CNAME | `ghs.googlehosted.com` |
| `asisto-api.agents.sh` | CNAME | `ghs.googlehosted.com` |

### 5. Add domain to Firebase Auth

Firebase Console → Authentication → Settings → Authorized domains → Add `asisto.agents.sh`

SSL certificate provisions automatically (15-30 minutes after DNS propagates).

## Tearing Down

```bash
make destroy            # Remove Cloud Run + Pulumi resources
```

To also delete the Agent Engine:
```bash
gcloud ai reasoning-engines delete RESOURCE_ID \
  --project=YOUR_PROJECT_ID --region=us-central1
```

## Troubleshooting

### "Agent Engine resource_id not set"

Run `make deploy-agent` first and copy the ID to `config.yaml`.

### Docker authentication errors

```bash
make setup
# or manually:
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
```

### WebSocket 1008 error

The Live API model is only available in `us-central1`. Ensure `GOOGLE_CLOUD_LOCATION=us-central1`.

### "document is not defined" (SSR)

WinBox.js must be dynamically imported inside `useEffect`. The `Window.tsx` component handles this automatically.

### SVAR filter crash on open-file

Ensure `data` prop contains all files (not just root), and `open-file` uses `api.intercept()` to stop SVAR's internal pipeline.

### Cloud Run WebSocket timeouts

Default timeout is 300s in Pulumi config. Increase `timeout` in `infra/__main__.py` for longer sessions.

### Quota errors

```bash
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

## Make Commands

```bash
make help            # Show all available commands
make dev             # Run backend + frontend concurrently
make dev-api         # Run FastAPI backend only (localhost:8080)
make dev-adk         # Run ADK web UI locally
make dev-app         # Run frontend dev server only (localhost:3000)
make deploy-agent    # Deploy agent to Agent Engine
make deploy-rules    # Deploy Firebase security rules
make setup           # First-time Pulumi setup
make preview         # Preview infrastructure changes
make deploy-infra    # Deploy backend + frontend to Cloud Run
make deploy-frontend # Deploy frontend only
make deploy-all      # Deploy agent + infrastructure
make logs            # View backend Cloud Run logs
make logs-app        # View frontend Cloud Run logs
make status          # Check deployment status
make destroy         # Tear down infrastructure
```
