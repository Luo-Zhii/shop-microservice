# syntax=docker/dockerfile:1.7
# Build (context = thư mục service):  docker build -t shopnow-ai-service services/ai-service
FROM python:3.13-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.txt .
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.13-slim AS runtime
ARG APP_VERSION=dev
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    SERVICE_NAME=ai-service PORT=8114 APP_VERSION=${APP_VERSION} LLM_PROVIDER=none
RUN groupadd -g 10001 app && useradd -u 10001 -g app -M -s /usr/sbin/nologin app
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=10001:10001 ai_service ai_service
USER 10001
EXPOSE 8114
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys;urllib.request.urlopen('http://127.0.0.1:8114/healthz',timeout=2)" || exit 1
CMD ["python", "-m", "ai_service"]
LABEL org.opencontainers.image.source="https://github.com/Luo-Zhii/shop-microservice" \
      org.opencontainers.image.title="shopnow-ai-service"
