#!/bin/bash
# =============================================================================
# build-and-push.sh — Build Docker images & push lên Harbor Registry
# (Node.js version)
# =============================================================================
set -euo pipefail

HARBOR_HOST="${HARBOR_HOST:-harbor-server}"
HARBOR_PROJECT="${HARBOR_PROJECT:-techcareer}"
IMAGE_TAG="${1:-latest}"

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo " Building & Pushing ShopNow Node.js Images"
echo " Harbor: ${HARBOR_HOST}/${HARBOR_PROJECT}"
echo " Tag:    ${IMAGE_TAG}"
echo "============================================"

SERVICES=(
  "product-service:5861"
  "shopping-cart-service:5863"
  "user-service:5865"
  "api-gateway:5860"
)

for service_info in "${SERVICES[@]}"; do
  IFS=':' read -r service_name service_port <<< "$service_info"
  echo ""
  echo "--- Building ${service_name} ---"
  cd "${BASE_DIR}/${service_name}"
  docker build -t "${HARBOR_HOST}/${HARBOR_PROJECT}/${service_name}:${IMAGE_TAG}" .
  echo "--- Pushing ${service_name} ---"
  docker push "${HARBOR_HOST}/${HARBOR_PROJECT}/${service_name}:${IMAGE_TAG}"
done

echo ""
echo "============================================"
echo " All Node.js images built & pushed!"
echo "============================================"
docker images | grep "${HARBOR_HOST}/${HARBOR_PROJECT}"
