#!/usr/bin/env bash
# Render mọi sơ đồ PlantUML ra PNG (+SVG) vào out/. Cần: plantuml (apt install plantuml) hoặc PLANTUML_JAR=/đường/dẫn/plantuml.jar, và graphviz.
set -euo pipefail
cd "$(dirname "$0")"
if command -v plantuml >/dev/null; then RUN=(plantuml); else RUN=(java -Xmx512m -Djava.awt.headless=true -jar "${PLANTUML_JAR:?đặt PLANTUML_JAR}"); fi
"${RUN[@]}" -charset UTF-8 -tpng -o out ./*.puml
"${RUN[@]}" -charset UTF-8 -tsvg -o out ./*.puml
ls out
