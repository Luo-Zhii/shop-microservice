#!/usr/bin/env bash
# Render các sơ đồ Graphviz (dot/*.dot) ra PNG 200 dpi + SVG trong out/ — dùng graphviz cài sẵn (apt install graphviz).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
for f in dot/*.dot; do n=$(basename "$f" .dot); dot -Gdpi=200 -Tpng "$f" -o "out/$n.png"; dot -Tsvg "$f" -o "out/$n.svg"; echo "out/$n.png"; done
