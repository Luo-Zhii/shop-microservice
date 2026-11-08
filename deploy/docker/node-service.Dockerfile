# syntax=docker/dockerfile:1.7
# Image chung cho mọi service Node: docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=catalog .
ARG NODE_VERSION=22.14-alpine3.21

FROM node:${NODE_VERSION} AS build
ARG SERVICE
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages packages
COPY services/${SERVICE}/package.json services/${SERVICE}/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@shopnow/${SERVICE}..."
COPY scripts scripts
COPY services/${SERVICE} services/${SERVICE}
RUN pnpm --filter "@shopnow/${SERVICE}" run build \
 && pnpm --filter "@shopnow/${SERVICE}" deploy --legacy --prod --config.node-linker=hoisted /out

FROM node:${NODE_VERSION} AS runtime
ARG SERVICE
ARG APP_VERSION=dev
ENV NODE_ENV=production SERVICE_NAME=${SERVICE} APP_VERSION=${APP_VERSION} NODE_OPTIONS="--enable-source-maps"
RUN apk add --no-cache tini && addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
WORKDIR /app
COPY --from=build --chown=app:app /out /app
USER 10001
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
LABEL org.opencontainers.image.source="https://github.com/Luo-Zhii/shop-microservice" \
      org.opencontainers.image.title="shopnow-${SERVICE}"
