#!/usr/bin/env bash
# Ghi tag + digest image mới vào repo GitOps: bump-image.sh <gitops_dir> <env> <service> <tag> [image_ref]
# Định dạng: environments/<env>/images.yaml → images.<service> = {tag, digest}  (digest được ưu tiên khi kéo image)
set -euo pipefail
dir=$1 env=$2 svc=$3 tag=$4
ref=${5:-ghcr.io/${GITHUB_REPOSITORY_OWNER:-luo-zhii}/shopnow/$svc:$tag}
file="$dir/environments/$env/images.yaml"
test -f "$file" || { echo "không thấy $file" >&2; exit 1; }
digest=$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' 2>/dev/null | jq -r '.digest // empty' || true)
TAG="$tag" DIGEST="$digest" SVC="$svc" yq -i '.images[strenv(SVC)].tag = strenv(TAG) | .images[strenv(SVC)].digest = strenv(DIGEST)' "$file"
echo "$env/$svc → $tag ${digest:-(chưa có digest)}"
