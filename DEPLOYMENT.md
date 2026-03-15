# Asisto Deployment Guide

This guide covers deploying the Asisto agent to Google Cloud, including:
- Agent deployment to **Vertex AI Agent Engine**
- FastAPI service deployment to **Cloud Run**
- **Firebase Auth** (Google Sign-In)
- Infrastructure management with **Pulumi** (Python)

## Architecture

```
┌─────────────────┐                    ┌──────────────────┐
│                 │     HTTPS          │  Cloud Run       │
│  Browser        │◄──────────────────►│  (TanStack Start)│
│  (Firebase Auth)│                    │  asisto-app      │
└─────────────────┘                    └────────┬─────────┘
                                                │ API_ENDPOINT
                                                ▼
                                       ┌──────────────────┐
                                       │  Cloud Run       │
                                       │  (FastAPI + WS)  │
                                       │  asisto-api      │
                                       │  Firebase Admin  │
                                       └────────┬─────────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          │                     │                     │
                          ▼                     ▼                     ▼
                   ┌──────────────┐   ┌─────────────────┐   ┌──────────────┐
                   │ Agent Engine │   │ Vertex AI        │   │ Vertex AI    │
                   │ (Reasoning   │   │ Session Service  │   │ Memory Bank  │
                   │  Engine)     │   │                  │   │ Service      │
                   └──────────────┘   └─────────────────┘   └──────────────┘
```

## Prerequisites

### Required tools

| Tool | Purpose | Install |
|------|---------|---------|
| **gcloud CLI** | Google Cloud authentication & management | [Install](https://cloud.google.com/sdk/docs/install) |
| **Python 3.13+** | Runtime | [python.org](https://www.python.org/) |
| **uv** | Python package manager | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **Pulumi** | Infrastructure as code | `brew install pulumi/tap/pulumi` |
| **Docker** | Container image builds | [docker.com](https://www.docker.com/) |
| **Bun** | Frontend runtime + package manager | `curl -fsSL https://bun.sh/install \| bash` |
| **make** | Build orchestration | Pre-installed on macOS/Linux |

### Required GCP APIs

These are automatically enabled by Pulumi, but you can enable them manually:

```bash
gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable cloudresourcemanager.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable run.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable artifactregistry.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable cloudbuild.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable firebase.googleapis.com --project=YOUR_PROJECT_ID
gcloud services enable identitytoolkit.googleapis.com --project=YOUR_PROJECT_ID
```

---

## Step 1: Authenticate with Google Cloud

```bash
# Login to your Google account
gcloud auth login

# Set application default credentials (used by the app and Pulumi)
gcloud auth application-default login

# Set your default project
gcloud config set project YOUR_PROJECT_ID

# Verify
gcloud config get-value project
```

## Step 2: Setup Firebase Auth

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

1. Go to the [Firebase Console](https://console.firebase.google.com/project/YOUR_PROJECT_ID/authentication/providers)
2. Click **Sign-in method** tab
3. Enable **Google** provider
4. Add your Cloud Run frontend domain to **Authorized domains**

## Step 3: Create config.yaml

Copy the example config and fill in your project details:

```bash
cp config.yaml.example config.yaml
```

Edit `config.yaml`:

```yaml
gcp:
  project_id: "your-gcp-project-id"
  region: "us-central1"

agent_engine:
  # Leave empty for now -- we'll fill this after deploying the agent
  resource_id: ""

cloud_run:
  service_name: "asisto-api"
  min_instances: 0
  max_instances: 5

frontend:
  service_name: "asisto-app"
  min_instances: 0
  max_instances: 3

agent:
  model: "gemini-live-2.5-flash-native-audio"
  display_name: "Asisto Agent"
```

**Important:** `config.yaml` is in `.gitignore` and should never be committed.
It contains project-specific configuration. The `config.yaml.example` is the
template that gets committed.

## Step 4: Deploy Agent to Agent Engine

This deploys your agent code to Vertex AI Agent Engine, which provides:
- Managed session persistence
- Memory bank service
- Scalable agent hosting

```bash
make deploy-agent
```

This runs `adk deploy agent_engine` under the hood. It takes several minutes.

On success, you'll see output like:

```
AgentEngine created. Resource name:
  projects/875791790592/locations/us-central1/reasoningEngines/2439436970523361280
```

**Copy the resource ID** (the number at the end, e.g., `2439436970523361280`)
and update `config.yaml`:

```yaml
agent_engine:
  resource_id: "2439436970523361280"  # <-- paste your ID here
```

### How to find your resource ID later

If you lose the ID, you can find it via:

```bash
gcloud ai reasoning-engines list --project=YOUR_PROJECT_ID --region=us-central1
```

Or in the [Agent Engine UI](https://console.cloud.google.com/vertex-ai/agents/agent-engines).

## Step 4: Setup Pulumi

### Configure Pulumi state backend (do this first)

Pulumi needs somewhere to store its state (a record of what infrastructure
exists). You have three options:

**Option A: Local file (recommended for hackathons / solo dev)**

No account needed. State is stored on your machine at `~/.pulumi/`:

```bash
pulumi login --local
```

**Option B: Pulumi Cloud (free account, good for teams)**

State stored in Pulumi's cloud service. Requires a free account:

```bash
pulumi login
```

**Option C: Google Cloud Storage bucket**

State stored in your own GCS bucket. No Pulumi account needed:

```bash
pulumi login gs://your-bucket-name
```

### Run setup

Once you've chosen a state backend, run the setup:

```bash
make setup
```

This does three things:
1. Configures Docker to push to Artifact Registry (`gcloud auth configure-docker`)
2. Installs Pulumi Python packages in `infra/venv/`
3. Creates a Pulumi stack named `dev`

## Step 5: Deploy Infrastructure (Cloud Run)

Preview what will be created:

```bash
make preview
```

Deploy:

```bash
make deploy-infra
```

This provisions:
1. **Artifact Registry** -- Docker image repository
2. **Docker images** -- Builds and pushes backend (FastAPI) and frontend (TanStack Start)
3. **Service Account** -- With Vertex AI User role
4. **Backend Cloud Run service** -- Runs FastAPI + WebSocket server
5. **Frontend Cloud Run service** -- Runs TanStack Start app (Bun + Nitro)

On success, Pulumi outputs the Cloud Run URLs:

```
Outputs:
    service_url:    "https://asisto-api-xxxxx-uc.a.run.app"
    frontend_url:   "https://asisto-app-xxxxx-uc.a.run.app"
```

The frontend's `API_ENDPOINT` env var is automatically set to the backend's
Cloud Run URL by Pulumi. Every deploy picks up the latest backend URL.

### Or deploy everything at once

```bash
make deploy-all
```

This runs `deploy-agent` first, prompts you to update `config.yaml`, then
runs `deploy-infra`.

## API Endpoints

Once deployed, the backend Cloud Run service exposes:

All REST endpoints require `Authorization: Bearer <firebase-id-token>` header.
The user ID is extracted from the token server-side.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workspaces` | Create a new workspace |
| `GET` | `/workspaces` | List all workspace IDs for the authenticated user |
| `GET` | `/workspaces/{workspace_id}` | Get a workspace by ID |
| `DELETE` | `/workspaces/{workspace_id}` | Delete a workspace |
| `WS` | `/ws/{workspace_id}?token=<firebase-id-token>` | Bidirectional streaming (voice + text) |

### WebSocket protocol

**Connect:** `wss://YOUR_BACKEND_URL/ws/{workspace_id}?token=FIREBASE_ID_TOKEN`

**Client -> Server (text):**
```json
{"type": "text", "text": "What time is it in Colombo?"}
```

**Client -> Server (image):**
```json
{"type": "image", "data": "base64_encoded_data", "mimeType": "image/jpeg"}
```

**Client -> Server (audio):**
Raw binary frames -- PCM audio, 16kHz, 16-bit.

**Server -> Client:**
JSON-encoded ADK Event objects (camelCase field names). Audio data is URL-safe
base64 encoded PCM int16 at 24kHz.

## Configuration Reference

All configuration flows from `config.yaml`. Environment variables override
config values when set:

| Config path | Env var override | Description |
|-------------|-----------------|-------------|
| `gcp.project_id` | `GOOGLE_CLOUD_PROJECT` | GCP project ID |
| `gcp.region` | `GOOGLE_CLOUD_LOCATION` | GCP region |
| `agent_engine.resource_id` | `AGENT_ENGINE_ID` | Reasoning Engine resource ID |
| `agent.model` | `ASISTO_AGENT_MODEL` | Gemini model name |

On Cloud Run, the Pulumi code sets these env vars from `config.yaml` automatically.
The frontend receives `API_ENDPOINT` (the backend Cloud Run URL) automatically
from Pulumi -- no manual configuration needed.

## Updating the Agent

After making changes to `asisto_agent/agent.py`:

```bash
# Redeploy agent to Agent Engine (creates new resource -- update config.yaml)
make deploy-agent

# Redeploy Cloud Run (picks up code changes)
make deploy-infra
```

Note: `adk deploy agent_engine` creates a **new** Reasoning Engine resource
each time. Update `config.yaml` with the new `resource_id` before running
`make deploy-infra`.

## Updating the Frontend

After making changes to the frontend (`app/`):

```bash
# Redeploy everything (backend + frontend)
make deploy-infra
```

The frontend container is rebuilt and redeployed. The `API_ENDPOINT` env var
is always set to the latest backend Cloud Run URL by Pulumi.

To delete an old agent:

```bash
gcloud ai reasoning-engines delete OLD_RESOURCE_ID \
  --project=YOUR_PROJECT_ID --region=us-central1
```

## Custom Domains (Optional)

You can map custom domains to the Cloud Run services (e.g., `asisto.agents.sh`
and `asisto-api.agents.sh`) instead of using the default `*.run.app` URLs.

### Step 1: Verify domain ownership

Google requires you to prove you own the domain before mapping it. Run:

```bash
gcloud domains verify agents.sh
```

This opens Google Search Console in your browser. Choose the **DNS record**
verification method and add the TXT record it provides to your DNS:

| Name | Type | Value |
|------|------|-------|
| `agents.sh` | TXT | `google-site-verification=...` (value from Search Console) |

Wait for verification to complete (usually 1--2 minutes after DNS propagates).

### Step 2: Configure domains in config.yaml

```yaml
domains:
  frontend: "asisto.agents.sh"
  api: "asisto-api.agents.sh"
```

Leave values empty to skip domain mapping.

### Step 3: Deploy

```bash
make deploy-infra
```

Pulumi creates the domain mappings and outputs the required DNS records:

```
frontend_dns_record: "CNAME asisto.agents.sh -> ghs.googlehosted.com"
api_dns_record:      "CNAME asisto-api.agents.sh -> ghs.googlehosted.com"
```

When a custom API domain is set, the frontend's `API_ENDPOINT` env var
automatically points to `https://asisto-api.agents.sh` instead of the
`*.run.app` URL. WebSocket connections from the browser will use the custom
domain as well.

### Step 4: Add CNAME records in DNS

In your DNS provider (e.g., Route 53), create:

| Name | Type | Value |
|------|------|-------|
| `asisto.agents.sh` | CNAME | `ghs.googlehosted.com` |
| `asisto-api.agents.sh` | CNAME | `ghs.googlehosted.com` |

### Step 5: Wait for SSL certificate provisioning

Google automatically provisions a managed TLS certificate. This can take
15--30 minutes after DNS propagates. Check status with:

```bash
gcloud run domain-mappings describe \
  --domain asisto.agents.sh --region us-central1
gcloud run domain-mappings describe \
  --domain asisto-api.agents.sh --region us-central1
```

Look for `CertificateProvisioned` status to be `True`.

### Step 6: Update Firebase authorized domains

Add the frontend custom domain to Firebase Auth so Google Sign-In works:

1. Go to [Firebase Console](https://console.firebase.google.com/) → Authentication → Settings → Authorized domains
2. Add `asisto.agents.sh`

### Removing domain mappings

To remove domain mappings, either:

- Clear the `domains` values in `config.yaml` and run `make deploy-infra`, or
- Remove them manually:

```bash
gcloud run domain-mappings delete --domain asisto.agents.sh --region us-central1
gcloud run domain-mappings delete --domain asisto-api.agents.sh --region us-central1
```

## Tearing Down

Remove Cloud Run and all Pulumi-managed infrastructure:

```bash
make destroy
```

This does **not** delete the Agent Engine. To delete it:

```bash
gcloud ai reasoning-engines delete RESOURCE_ID \
  --project=YOUR_PROJECT_ID --region=us-central1
```

## Troubleshooting

### "Agent Engine resource_id not set"

You haven't set the resource ID in `config.yaml`. Run `make deploy-agent`
first and copy the ID.

### Docker authentication errors

Run `make setup` again, or manually:

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
```

### Quota errors from gcloud

Set a quota project:

```bash
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

### Cloud Run WebSocket timeouts

Cloud Run has a default request timeout. The Pulumi config sets it to 300s.
For longer WebSocket sessions, increase `timeout` in `infra/__main__.py`.

### Domain mapping fails with "domain not verified"

You need to verify domain ownership first:

```bash
gcloud domains verify YOUR_DOMAIN
```

Follow the instructions to add a TXT record, then retry `make deploy-infra`.

### SSL certificate stuck in "pending"

The managed certificate won't provision until DNS CNAME records point to
`ghs.googlehosted.com`. Verify your CNAME records are correct:

```bash
dig asisto.agents.sh CNAME +short
# Should return: ghs.googlehosted.com.
```

If DNS is correct, wait up to 30 minutes. Check status with:

```bash
gcloud run domain-mappings describe --domain YOUR_DOMAIN --region us-central1
```

## Make Commands

```bash
make help            # Show all available commands
make dev             # Run backend + frontend concurrently
make dev-api         # Run FastAPI backend only (localhost:8080)
make dev-adk         # Run ADK web UI locally
make dev-app         # Run frontend dev server only (localhost:3000)
make deploy-agent    # Deploy agent to Agent Engine
make setup           # First-time Pulumi setup
make preview         # Preview infrastructure changes
make deploy-infra    # Deploy backend + frontend to Cloud Run
make deploy-frontend # Deploy frontend only to Cloud Run
make deploy-all      # Deploy agent + infrastructure
make logs            # View backend Cloud Run logs
make logs-app        # View frontend Cloud Run logs
make status          # Check deployment status
make destroy         # Tear down infrastructure
```
