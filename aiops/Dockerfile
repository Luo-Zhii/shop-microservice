# syntax=docker/dockerfile:1.7
# Build (context = thư mục aiops):  docker build -t shopnow-aiops aiops
FROM python:3.13-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/venv && grep -v '^pytest' /tmp/requirements.txt > /tmp/req.txt \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/req.txt

FROM python:3.13-slim AS runtime
ARG APP_VERSION=dev
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8120 APP_VERSION=${APP_VERSION} \
    DRY_RUN=true LLM_PROVIDER=none AIOPS_DATA_DIR=/data AUDIT_LOG=/data/aiops-audit.jsonl
RUN groupadd -g 10001 app && useradd -u 10001 -g app -M -s /usr/sbin/nologin app && mkdir -p /data && chown 10001:10001 /data
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=10001:10001 . /app/aiops
USER 10001
VOLUME ["/data"]
EXPOSE 8120
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8120/healthz',timeout=2)" || exit 1
CMD ["python", "-m", "aiops", "serve"]
LABEL org.opencontainers.image.source="https://github.com/Luo-Zhii/shop-microservice" \
      org.opencontainers.image.title="shopnow-aiops"
