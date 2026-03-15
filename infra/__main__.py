"""Asisto infrastructure - Pulumi program for Google Cloud.

Provisions:
1. Required GCP APIs
2. Artifact Registry repository
3. Docker image build + push (backend API)
4. Cloud Run service (FastAPI + WebSocket backend)
5. Docker image build + push (frontend app)
6. Cloud Run service (TanStack Start frontend)

Reads configuration from ../config.yaml.
"""

from pathlib import Path

import yaml
import pulumi
import pulumi_gcp as gcp
import pulumi_docker as docker

# --- Load config.yaml ---
config_path = Path(__file__).parent.parent / "config.yaml"
if not config_path.exists():
    raise FileNotFoundError(
        f"{config_path} not found. Copy config.yaml.example to config.yaml "
        "and fill in your values."
    )

with open(config_path) as f:
    app_config = yaml.safe_load(f)

project = app_config["gcp"]["project_id"]
region = app_config["gcp"]["region"]
engine_id = app_config["agent_engine"]["resource_id"]
service_name = app_config["cloud_run"]["service_name"]
min_instances = app_config["cloud_run"]["min_instances"]
max_instances = app_config["cloud_run"]["max_instances"]
agent_model = app_config["agent"]["model"]

# Frontend config
frontend_config = app_config.get("frontend", {})
frontend_service_name = frontend_config.get("service_name", "asisto-app")
frontend_min_instances = frontend_config.get("min_instances", 0)
frontend_max_instances = frontend_config.get("max_instances", 3)

# Custom domains (optional)
domains_config = app_config.get("domains", {})
frontend_domain = domains_config.get("frontend", "")
api_domain = domains_config.get("api", "")

if not engine_id:
    raise ValueError(
        "agent_engine.resource_id is not set in config.yaml. "
        "Deploy the agent first with: make deploy-agent"
    )

# --- 1. Enable Required APIs ---

apis = [
    "aiplatform.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "firebase.googleapis.com",
    "identitytoolkit.googleapis.com",
]

enabled_apis = []
for api in apis:
    enabled_api = gcp.projects.Service(
        f"api-{api.split('.')[0]}",
        service=api,
        project=project,
        disable_on_destroy=False,
    )
    enabled_apis.append(enabled_api)

# --- 2. Artifact Registry Repository ---

repo = gcp.artifactregistry.Repository(
    "asisto-repo",
    repository_id="asisto",
    location=region,
    format="DOCKER",
    project=project,
    opts=pulumi.ResourceOptions(depends_on=enabled_apis),
)

# Registry URL for images
registry_url = f"{region}-docker.pkg.dev/{project}/asisto"

# --- 3. Backend Docker Image Build & Push ---

backend_image_name = f"{registry_url}/{service_name}"

backend_image = docker.Image(
    "asisto-image",
    image_name=backend_image_name,
    build=docker.DockerBuildArgs(
        context="..",  # Project root (one level up from infra/)
        dockerfile="../Dockerfile",
        platform="linux/amd64",
    ),
    registry=docker.RegistryArgs(
        server=f"{region}-docker.pkg.dev",
    ),
    opts=pulumi.ResourceOptions(depends_on=[repo]),
)

# --- 4. Backend Cloud Run Service ---

# Service account for backend (needs Vertex AI access)
service_account = gcp.serviceaccount.Account(
    "asisto-sa",
    account_id="asisto-api-sa",
    display_name="Asisto API Service Account",
    project=project,
)

# Grant Vertex AI User role to the service account
vertex_ai_binding = gcp.projects.IAMMember(
    "asisto-sa-vertex-ai",
    project=project,
    role="roles/aiplatform.user",
    member=pulumi.Output.concat("serviceAccount:", service_account.email),
)

# Backend Cloud Run service
cloud_run_service = gcp.cloudrunv2.Service(
    service_name,
    name=service_name,
    location=region,
    project=project,
    deletion_protection=False,
    ingress="INGRESS_TRAFFIC_ALL",
    template={
        "service_account": service_account.email,
        "timeout": "300s",
        "scaling": {
            "min_instance_count": min_instances,
            "max_instance_count": max_instances,
        },
        "containers": [
            {
                "image": backend_image.repo_digest,
                "resources": {
                    "limits": {
                        "cpu": "2",
                        "memory": "1Gi",
                    },
                },
                "envs": [
                    {"name": "GOOGLE_GENAI_USE_VERTEXAI", "value": "TRUE"},
                    {"name": "GOOGLE_CLOUD_PROJECT", "value": project},
                    {"name": "GOOGLE_CLOUD_LOCATION", "value": region},
                    {"name": "AGENT_ENGINE_ID", "value": engine_id},
                    {"name": "ASISTO_AGENT_MODEL", "value": agent_model},
                ],
            }
        ],
    },
    opts=pulumi.ResourceOptions(
        depends_on=enabled_apis + [vertex_ai_binding],
    ),
)

# Allow unauthenticated access to backend
cloud_run_iam = gcp.cloudrunv2.ServiceIamMember(
    "asisto-public-access",
    project=project,
    location=region,
    name=cloud_run_service.name,
    role="roles/run.invoker",
    member="allUsers",
)

# --- 5. Frontend Docker Image Build & Push ---

frontend_image_name = f"{registry_url}/{frontend_service_name}"

frontend_image = docker.Image(
    "asisto-frontend-image",
    image_name=frontend_image_name,
    build=docker.DockerBuildArgs(
        context="../app",  # Frontend directory (one level up from infra/, then into app/)
        dockerfile="../app/Dockerfile",
        platform="linux/amd64",
    ),
    registry=docker.RegistryArgs(
        server=f"{region}-docker.pkg.dev",
    ),
    opts=pulumi.ResourceOptions(depends_on=[repo]),
)

# --- 6. Frontend Cloud Run Service ---

# The frontend gets the backend API URL via env var.
# If a custom API domain is configured, use it. Otherwise fall back to the
# Cloud Run service URL.
if api_domain:
    api_endpoint_value = f"https://{api_domain}"
else:
    api_endpoint_value = cloud_run_service.uri

frontend_cloud_run = gcp.cloudrunv2.Service(
    frontend_service_name,
    name=frontend_service_name,
    location=region,
    project=project,
    deletion_protection=False,
    ingress="INGRESS_TRAFFIC_ALL",
    template={
        "scaling": {
            "min_instance_count": frontend_min_instances,
            "max_instance_count": frontend_max_instances,
        },
        "containers": [
            {
                "image": frontend_image.repo_digest,
                "resources": {
                    "limits": {
                        "cpu": "1",
                        "memory": "512Mi",
                    },
                },
                "envs": [
                    {
                        "name": "API_ENDPOINT",
                        "value": api_endpoint_value,
                    },
                ],
            }
        ],
    },
    opts=pulumi.ResourceOptions(
        depends_on=enabled_apis + [cloud_run_service],
    ),
)

# Allow unauthenticated access to frontend
frontend_iam = gcp.cloudrunv2.ServiceIamMember(
    "asisto-frontend-public-access",
    project=project,
    location=region,
    name=frontend_cloud_run.name,
    role="roles/run.invoker",
    member="allUsers",
)

# --- Outputs ---
pulumi.export("service_url", cloud_run_service.uri)
pulumi.export("service_name", cloud_run_service.name)
pulumi.export("image", backend_image.repo_digest)
pulumi.export("frontend_url", frontend_cloud_run.uri)
pulumi.export("frontend_name", frontend_cloud_run.name)
pulumi.export("frontend_image", frontend_image.repo_digest)
pulumi.export(
    "agent_engine_resource",
    (f"projects/{project}/locations/{region}/reasoningEngines/{engine_id}"),
)

# --- 7. Custom Domain Mappings (optional) ---

if frontend_domain:
    frontend_domain_mapping = gcp.cloudrun.DomainMapping(
        "asisto-frontend-domain",
        location=region,
        name=frontend_domain,
        project=project,
        metadata={
            "namespace": project,
        },
        spec={
            "route_name": frontend_service_name,
            "certificate_mode": "AUTOMATIC",
        },
        opts=pulumi.ResourceOptions(depends_on=[frontend_cloud_run]),
    )
    pulumi.export("frontend_domain", frontend_domain)
    pulumi.export(
        "frontend_dns_record",
        f"CNAME {frontend_domain} -> ghs.googlehosted.com",
    )

if api_domain:
    api_domain_mapping = gcp.cloudrun.DomainMapping(
        "asisto-api-domain",
        location=region,
        name=api_domain,
        project=project,
        metadata={
            "namespace": project,
        },
        spec={
            "route_name": service_name,
            "certificate_mode": "AUTOMATIC",
        },
        opts=pulumi.ResourceOptions(depends_on=[cloud_run_service]),
    )
    pulumi.export("api_domain", api_domain)
    pulumi.export(
        "api_dns_record",
        f"CNAME {api_domain} -> ghs.googlehosted.com",
    )
