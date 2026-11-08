#!/usr/bin/env bash
# Chạy toàn bộ ShopNow v2 trên máy dev (không cần K8s):
#   scripts/dev.sh up      — build + chạy mọi service (log ở .dev/logs/<svc>.log)
#   scripts/dev.sh down    — tắt mọi service
#   scripts/dev.sh status  — xem /readyz từng service
# Yêu cầu: hạ tầng `pnpm infra:up` đã chạy; Go service chạy bằng image docker; Python dùng .venv.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.dev"
mkdir -p "$RUN/logs" "$RUN/pids"

NODE_SERVICES=(identity user-profile seller catalog search cart promotion order payment shipping review notification api-gateway)
declare -A PORT=([api-gateway]=8080 [identity]=8101 [user-profile]=8102 [seller]=8103 [catalog]=8104 [search]=8105 [inventory]=8106
  [cart]=8107 [promotion]=8108 [order]=8109 [payment]=8110 [shipping]=8111 [review]=8112 [notification]=8113 [ai-service]=8114 [aiops]=8120)

PG="postgres://shopnow:shopnow@localhost:55432"
export NODE_ENV=development LOG_LEVEL="${LOG_LEVEL:-info}" KAFKA_BROKERS=localhost:59092 REDIS_URL=redis://localhost:56379
export MONGO_URL=mongodb://localhost:57017 INTERNAL_TOKEN=dev-internal-token
export JWKS_URL=http://localhost:8101/.well-known/jwks.json JWT_ISSUER=shopnow-identity JWT_AUDIENCE=shopnow
export IDENTITY_URL=http://localhost:8101 USER_PROFILE_URL=http://localhost:8102 SELLER_URL=http://localhost:8103
export CATALOG_URL=http://localhost:8104 SEARCH_URL=http://localhost:8105 INVENTORY_URL=http://localhost:8106
export CART_URL=http://localhost:8107 PROMOTION_URL=http://localhost:8108 ORDER_URL=http://localhost:8109
export PAYMENT_URL=http://localhost:8110 SHIPPING_URL=http://localhost:8111 REVIEW_URL=http://localhost:8112
export NOTIFICATION_URL=http://localhost:8113 AI_URL=http://localhost:8114
export WEB_URL="${WEB_URL:-http://localhost:3000}" PUBLIC_BASE_URL=http://localhost:8080/api/payment
export DEV_EXPOSE_OTP=true DEV_SIMULATOR=true DEV_AUTO_ADVANCE_SECONDS="${DEV_AUTO_ADVANCE_SECONDS:-0}"
export SMTP_URL=smtp://localhost:51025 SEARCH_ENGINE=postgres LLM_PROVIDER="${LLM_PROVIDER:-none}"
export AUTO_COMPLETE_SECONDS="${AUTO_COMPLETE_SECONDS:-259200}" PAYMENT_TIMEOUT_SECONDS="${PAYMENT_TIMEOUT_SECONDS:-900}"
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 khi bật profile observability

db_name() { case "$1" in user-profile) echo user_profile ;; order) echo orders ;; ai-service) echo ai ;; *) echo "$1" ;; esac; }

start_node() {
  local svc=$1
  [[ -f "$ROOT/services/$svc/dist/main.js" ]] || (cd "$ROOT/services/$svc" && pnpm -s build >/dev/null)
  (cd "$ROOT/services/$svc" && SERVICE_NAME=$svc PORT=${PORT[$svc]} DATABASE_URL="$PG/$(db_name "$svc")" MONGO_DB="$(db_name "$svc")" \
    nohup node --enable-source-maps dist/main.js >"$RUN/logs/$svc.log" 2>&1 & echo $! >"$RUN/pids/$svc.pid")
}

start_inventory() {
  docker rm -f shopnow-inventory >/dev/null 2>&1 || true
  if docker image inspect shopnow/inventory:dev >/dev/null 2>&1; then
    docker run -d --name shopnow-inventory --network host -e PORT=8106 -e DATABASE_URL="$PG/inventory" \
      -e KAFKA_BROKERS -e JWKS_URL -e JWT_ISSUER -e JWT_AUDIENCE -e INTERNAL_TOKEN shopnow/inventory:dev >/dev/null
  else
    echo "⚠ chưa có image shopnow/inventory:dev — chạy: docker build -t shopnow/inventory:dev services/inventory"
  fi
}

start_python() {
  local svc=$1 dir=$2 module=$3
  [[ -x "$ROOT/.venv/bin/python" ]] || { echo "⚠ chưa có .venv — bỏ qua $svc"; return; }
  (cd "$ROOT/$dir" && SERVICE_NAME=$svc PORT=${PORT[$svc]} DATABASE_URL="$PG/$(db_name "$svc")" \
    nohup "$ROOT/.venv/bin/python" -m uvicorn "$module" --host 0.0.0.0 --port "${PORT[$svc]}" >"$RUN/logs/$svc.log" 2>&1 & echo $! >"$RUN/pids/$svc.pid")
}

case "${1:-up}" in
  up)
    if [[ "${REBUILD:-0}" == 1 ]]; then pnpm -s -r --filter "./services/*" run build >/dev/null; fi
    start_node identity
    sleep 3
    for s in "${NODE_SERVICES[@]}"; do [[ $s == identity ]] || start_node "$s"; done
    start_inventory
    start_python ai-service services/ai-service "${AI_APP:-app.main:app}"
    echo "Đang khởi động… xem trạng thái: scripts/dev.sh status (log: .dev/logs)"
    ;;
  down)
    for f in "$RUN"/pids/*.pid; do [[ -f $f ]] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
    docker rm -f shopnow-inventory >/dev/null 2>&1 || true
    echo "Đã tắt."
    ;;
  status)
    for s in "${!PORT[@]}"; do
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT[$s]}/readyz" || true)
      printf '%-14s %-5s %s\n' "$s" "${PORT[$s]}" "$([[ $code == 200 ]] && echo OK || echo "DOWN($code)")"
    done | sort
    ;;
  *) echo "dùng: $0 up|down|status"; exit 1 ;;
esac
