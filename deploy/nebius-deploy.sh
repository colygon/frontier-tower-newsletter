#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Eventsy — Nebius Cloud Deployment
#
# Deploys the full Eventsy platform to Nebius:
#   1. Container Registry → push Docker image
#   2. VPC Network + Subnet
#   3. Nebius Managed PostgreSQL (external service)
#   4. AI Endpoints (serverless containers):
#      - Eventsy Platform (our app)
#      - Twenty CRM
#      - Hi.Events
#      - OpenClaw
#
# Prerequisites:
#   - nebius CLI installed and authenticated
#   - docker installed
#   - PROJECT_ID set (your Nebius project)
# ============================================================

# --- Configuration ---
PROJECT_ID="${NEBIUS_PROJECT_ID:?Set NEBIUS_PROJECT_ID}"
REGION="${NEBIUS_REGION:-eu-north1}"
APP_NAME="eventsy"
CPU_PLATFORM="cpu-e2"
if [ "$REGION" = "eu-west1" ]; then
  CPU_PLATFORM="cpu-d3"
fi

echo "=============================================="
echo "  Eventsy — Nebius Deployment"
echo "  Project: $PROJECT_ID"
echo "  Region:  $REGION"
echo "  Platform: $CPU_PLATFORM"
echo "=============================================="

# --- Step 1: Container Registry ---
echo ""
echo "[1/6] Setting up Container Registry..."

REGISTRY_ID=$(nebius registry list --parent-id "$PROJECT_ID" --format json 2>/dev/null \
  | jq -r ".items[] | select(.name==\"${APP_NAME}\") | .id" 2>/dev/null || echo "")

if [ -z "$REGISTRY_ID" ]; then
  echo "  Creating registry '${APP_NAME}'..."
  REGISTRY_ID=$(nebius registry create \
    --name "$APP_NAME" \
    --parent-id "$PROJECT_ID" \
    --format json | jq -r '.id')
  echo "  Created registry: $REGISTRY_ID"
else
  echo "  Registry already exists: $REGISTRY_ID"
fi

REGISTRY_URL="cr.${REGION}.nebius.cloud/${REGISTRY_ID}"

# --- Step 2: Build & Push Docker Image ---
echo ""
echo "[2/6] Building and pushing Docker image..."

# Authenticate Docker
nebius iam get-access-token | docker login "cr.${REGION}.nebius.cloud" \
  --username iam \
  --password-stdin

# Build and push the platform image
docker build -t "${REGISTRY_URL}/${APP_NAME}:latest" .
docker push "${REGISTRY_URL}/${APP_NAME}:latest"
echo "  Pushed: ${REGISTRY_URL}/${APP_NAME}:latest"

# --- Step 3: VPC Networking ---
echo ""
echo "[3/6] Setting up VPC networking..."

NETWORK_ID=$(nebius vpc network list --parent-id "$PROJECT_ID" --format json 2>/dev/null \
  | jq -r ".items[] | select(.name==\"${APP_NAME}-net\") | .id" 2>/dev/null || echo "")

if [ -z "$NETWORK_ID" ]; then
  echo "  Creating network '${APP_NAME}-net'..."
  NETWORK_ID=$(nebius vpc network create \
    --name "${APP_NAME}-net" \
    --parent-id "$PROJECT_ID" \
    --format json | jq -r '.id')
  echo "  Created network: $NETWORK_ID"
else
  echo "  Network already exists: $NETWORK_ID"
fi

SUBNET_ID=$(nebius vpc subnet list --parent-id "$PROJECT_ID" --format json 2>/dev/null \
  | jq -r ".items[] | select(.name==\"${APP_NAME}-subnet\") | .id" 2>/dev/null || echo "")

if [ -z "$SUBNET_ID" ]; then
  echo "  Creating subnet '${APP_NAME}-subnet'..."
  SUBNET_ID=$(nebius vpc subnet create \
    --name "${APP_NAME}-subnet" \
    --parent-id "$PROJECT_ID" \
    --network-id "$NETWORK_ID" \
    --ipv4-cidr-block "10.0.0.0/24" \
    --format json | jq -r '.id')
  echo "  Created subnet: $SUBNET_ID"
else
  echo "  Subnet already exists: $SUBNET_ID"
fi

# --- Step 4: PostgreSQL (Nebius Managed) ---
echo ""
echo "[4/6] PostgreSQL — Nebius Managed PostgreSQL"

# Nebius Managed PostgreSQL connection details
PG_CLUSTER_ID="postgresql-e00c9be8vdp8rx0dn3"
PG_HOST_PRIVATE="private-rw.postgresql-e00c9be8vdp8rx0dn3.backbone-e00qegmfj4yxpj4fgj.msp.eu-north1.nebius.cloud"
PG_HOST_PUBLIC="public-rw.postgresql-e00c9be8vdp8rx0dn3.backbone-e00qegmfj4yxpj4fgj.msp.eu-north1.nebius.cloud"
PG_USER="${NEBIUS_PG_USER:-eventsy}"
PG_PASSWORD="${NEBIUS_PG_PASSWORD:?Set NEBIUS_PG_PASSWORD}"
PG_PORT="${NEBIUS_PG_PORT:-5432}"

# Use private endpoint for service-to-service (within Nebius network)
NEBIUS_PG_URL="postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST_PRIVATE}:${PG_PORT}/eventsy?sslmode=require"
NEBIUS_PG_URL_TWENTY="postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST_PRIVATE}:${PG_PORT}/twenty?sslmode=require"
NEBIUS_PG_URL_HIEVENTS="postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST_PRIVATE}:${PG_PORT}/hievents?sslmode=require"

echo "  Cluster:  $PG_CLUSTER_ID"
echo "  Private:  $PG_HOST_PRIVATE"
echo "  Public:   $PG_HOST_PUBLIC"
echo "  User:     $PG_USER"
echo "  Databases: eventsy, twenty, hievents"
echo ""
echo "  Ensure these databases exist. Connect via public endpoint to create them:"
echo "    psql \"postgres://${PG_USER}:***@${PG_HOST_PUBLIC}:${PG_PORT}/postgres?sslmode=require\""
echo "    CREATE DATABASE eventsy; CREATE DATABASE twenty; CREATE DATABASE hievents;"

# --- Step 5: Deploy Serverless Endpoints ---
echo ""
echo "[5/6] Deploying serverless endpoints..."

# --- 5a: Eventsy Platform ---
echo "  Deploying Eventsy Platform..."
nebius ai endpoint create \
  --name "${APP_NAME}-platform" \
  --parent-id "$PROJECT_ID" \
  --image "${REGISTRY_URL}/${APP_NAME}:latest" \
  --platform "$CPU_PLATFORM" \
  --preset "1vcpu-4gb" \
  --container-port 3000 \
  --disk-size 10 \
  --env "DATABASE_URL=${NEBIUS_PG_URL}" \
  --env "NEBIUS_PG_HOST=${PG_HOST_PRIVATE}" \
  --env "TWENTY_BASE_URL=http://${APP_NAME}-twenty:3000" \
  --env "HI_EVENTS_BASE_URL=http://${APP_NAME}-hievents:8080" \
  --env "OPENCLAW_BASE_URL=http://${APP_NAME}-openclaw:8080" \
  --env "NODE_ENV=production" \
  --env "DATA_DIR=/app/data" \
  --public \
  --format json | jq '.'

# --- 5b: Twenty CRM ---
echo "  Deploying Twenty CRM..."
nebius ai endpoint create \
  --name "${APP_NAME}-twenty" \
  --parent-id "$PROJECT_ID" \
  --image "twentycrm/twenty:latest" \
  --platform "$CPU_PLATFORM" \
  --preset "2vcpu-8gb" \
  --container-port 3000 \
  --disk-size 20 \
  --env "PG_DATABASE_URL=${NEBIUS_PG_URL_TWENTY}" \
  --env "SERVER_URL=https://crm.${DOMAIN:-eventsy.app}" \
  --public \
  --format json | jq '.'

# --- 5c: Hi.Events ---
echo "  Deploying Hi.Events..."
nebius ai endpoint create \
  --name "${APP_NAME}-hievents" \
  --parent-id "$PROJECT_ID" \
  --image "daveearley/hi.events-all-in-one:latest" \
  --platform "$CPU_PLATFORM" \
  --preset "1vcpu-4gb" \
  --container-port 8080 \
  --disk-size 10 \
  --env "DB_HOST=${PG_HOST_PRIVATE}" \
  --env "DB_PORT=${PG_PORT}" \
  --env "DB_DATABASE=hievents" \
  --env "DB_USERNAME=${PG_USER}" \
  --env "DB_PASSWORD=${PG_PASSWORD}" \
  --env "DB_CONNECTION=pgsql" \
  --env "DB_SSLMODE=require" \
  --public \
  --format json | jq '.'

# --- 5d: OpenClaw ---
echo "  Deploying OpenClaw..."
OPENCLAW_TOKEN=$(openssl rand -hex 16)
echo "  OpenClaw gateway token: $OPENCLAW_TOKEN (save this!)"

nebius ai endpoint create \
  --name "${APP_NAME}-openclaw" \
  --parent-id "$PROJECT_ID" \
  --image "ghcr.io/opencolin/openclaw-serverless:latest" \
  --platform "$CPU_PLATFORM" \
  --preset "1vcpu-4gb" \
  --container-port 8080 \
  --container-port 18789 \
  --disk-size 10 \
  --env "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_TOKEN}" \
  --public \
  --format json | jq '.'

# --- Step 6: Wait & Report ---
echo ""
echo "[6/6] Waiting for endpoints to become RUNNING..."

for ENDPOINT_NAME in "${APP_NAME}-platform" "${APP_NAME}-twenty" "${APP_NAME}-hievents" "${APP_NAME}-openclaw"; do
  echo -n "  Waiting for ${ENDPOINT_NAME}..."
  for i in $(seq 1 60); do
    STATE=$(nebius ai endpoint get --name "$ENDPOINT_NAME" --parent-id "$PROJECT_ID" --format json 2>/dev/null \
      | jq -r '.status.state' 2>/dev/null || echo "PENDING")
    if [ "$STATE" = "RUNNING" ]; then
      URL=$(nebius ai endpoint get --name "$ENDPOINT_NAME" --parent-id "$PROJECT_ID" --format json \
        | jq -r '.status.url // .status.public_ip // "pending"')
      echo " RUNNING ($URL)"
      break
    fi
    echo -n "."
    sleep 5
  done
done

echo ""
echo "=============================================="
echo "  Deployment complete!"
echo ""
echo "  Services:"
echo "    Platform:  ${APP_NAME}-platform"
echo "    CRM:       ${APP_NAME}-twenty"
echo "    Events:    ${APP_NAME}-hievents"
echo "    OpenClaw:  ${APP_NAME}-openclaw"
echo ""
echo "  OpenClaw Token: $OPENCLAW_TOKEN"
echo ""
echo "  Next steps:"
echo "    1. Set up DNS records pointing to endpoint IPs"
echo "    2. Configure env vars in .env.local with actual URLs"
echo "    3. Run: nebius ai endpoint logs ${APP_NAME}-platform"
echo "=============================================="
