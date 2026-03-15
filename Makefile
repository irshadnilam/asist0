.PHONY: help setup deploy-agent deploy-infra deploy-frontend deploy-all preview destroy dev dev-app

# --- Read config from config.yaml ---
PROJECT_ID := $(shell python3 -c "import yaml; c=yaml.safe_load(open('config.yaml')); print(c['gcp']['project_id'])" 2>/dev/null || echo "NOT_SET")
REGION := $(shell python3 -c "import yaml; c=yaml.safe_load(open('config.yaml')); print(c['gcp']['region'])" 2>/dev/null || echo "us-central1")
AGENT_DISPLAY_NAME := $(shell python3 -c "import yaml; c=yaml.safe_load(open('config.yaml')); print(c['agent']['display_name'])" 2>/dev/null || echo "Asisto Agent")
SERVICE_NAME := $(shell python3 -c "import yaml; c=yaml.safe_load(open('config.yaml')); print(c['cloud_run']['service_name'])" 2>/dev/null || echo "asisto-api")
FRONTEND_SERVICE_NAME := $(shell python3 -c "import yaml; c=yaml.safe_load(open('config.yaml')); print(c['frontend']['service_name'])" 2>/dev/null || echo "asisto-app")
PULUMI_STACK := dev

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Local Development ---

dev: ## Run backend + frontend concurrently
	@trap 'kill 0' EXIT; \
	uv run python main.py & \
	cd app && bun run dev & \
	wait

dev-api: ## Run FastAPI server only
	uv run python main.py

dev-adk: ## Run ADK web UI locally
	uv run adk web

dev-app: ## Run frontend dev server only
	cd app && bun run dev

# --- Agent Engine Deployment ---

deploy-agent: ## Deploy agent to Vertex AI Agent Engine
	@echo "Deploying agent to Agent Engine..."
	uv run adk deploy agent_engine \
		--project=$(PROJECT_ID) \
		--region=$(REGION) \
		--display_name="$(AGENT_DISPLAY_NAME)" \
		asisto_agent
	@echo ""
	@echo "=== IMPORTANT ==="
	@echo "Copy the resource ID from the output above and set it in config.yaml:"
	@echo "  agent_engine:"
	@echo "    resource_id: \"<paste_id_here>\""
	@echo ""

# --- Infrastructure (Pulumi) ---

setup: ## First-time setup: configure Docker auth, install Pulumi deps, create stack
	@if [ ! -f config.yaml ]; then \
		echo "ERROR: config.yaml not found. Copy from config.yaml.example:"; \
		echo "  cp config.yaml.example config.yaml"; \
		exit 1; \
	fi
	@echo "Configuring Docker for Artifact Registry..."
	gcloud auth configure-docker $(REGION)-docker.pkg.dev --quiet
	@echo "Installing Pulumi dependencies..."
	cd infra && pulumi install
	@echo "Selecting/creating Pulumi stack..."
	cd infra && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null || true
	@echo ""
	@echo "Setup complete. Run 'make preview' to see what will be deployed."

preview: ## Preview infrastructure changes
	cd infra && pulumi preview

deploy-infra: ## Deploy backend + frontend Cloud Run services
	cd infra && pulumi up --yes

deploy-frontend: ## Deploy frontend only (rebuilds frontend image + Cloud Run)
	cd infra && pulumi up --yes --target \
		"urn:pulumi:$(PULUMI_STACK)::asisto-infra::docker:index/image:Image::asisto-frontend-image" \
		"urn:pulumi:$(PULUMI_STACK)::asisto-infra::gcp:cloudrunv2/service:Service::$(FRONTEND_SERVICE_NAME)"
	@echo ""
	@echo "=== Frontend Deployed ==="
	@echo "URL: $$(cd infra && pulumi stack output frontend_url)"
	@echo ""

destroy: ## Tear down all infrastructure (keeps Agent Engine)
	cd infra && pulumi destroy --yes

# --- Full Deployment ---

deploy-all: deploy-agent ## Deploy everything (agent + infrastructure)
	@echo ""
	@echo "Waiting for you to set the resource_id in config.yaml..."
	@echo "Did you update config.yaml with the resource_id? [y/N]"
	@read -r answer; \
	if [ "$$answer" != "y" ] && [ "$$answer" != "Y" ]; then \
		echo "Aborted. Update config.yaml first, then run 'make deploy-infra'."; \
		exit 1; \
	fi
	$(MAKE) deploy-infra
	@echo ""
	@echo "=== Deployment Complete ==="
	@echo "Backend:  $$(cd infra && pulumi stack output service_url)"
	@echo "Frontend: $$(cd infra && pulumi stack output frontend_url)"
	@echo ""

# --- Utilities ---

logs: ## View backend Cloud Run logs
	gcloud run services logs read $(SERVICE_NAME) \
		--project=$(PROJECT_ID) --region=$(REGION) --limit=50

logs-app: ## View frontend Cloud Run logs
	gcloud run services logs read $(FRONTEND_SERVICE_NAME) \
		--project=$(PROJECT_ID) --region=$(REGION) --limit=50

status: ## Show deployment status
	@echo "=== Agent Engine ==="
	@gcloud ai reasoning-engines list \
		--project=$(PROJECT_ID) --region=$(REGION) 2>/dev/null || echo "  No agents found"
	@echo ""
	@echo "=== Backend (Cloud Run) ==="
	@gcloud run services describe $(SERVICE_NAME) \
		--project=$(PROJECT_ID) --region=$(REGION) \
		--format="value(status.url)" 2>/dev/null || echo "  Not deployed"
	@echo ""
	@echo "=== Frontend (Cloud Run) ==="
	@gcloud run services describe $(FRONTEND_SERVICE_NAME) \
		--project=$(PROJECT_ID) --region=$(REGION) \
		--format="value(status.url)" 2>/dev/null || echo "  Not deployed"
	@echo ""
	@echo "=== Pulumi Stack ==="
	@cd infra && pulumi stack output 2>/dev/null || echo "  No stack outputs"
