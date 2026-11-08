# syntax=docker/dockerfile:1
# Build context: services/inventory
FROM golang:1.23-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
COPY go.mod go.sum ./
# Thử lại khi mạng chập chờn (TLS handshake timeout tới proxy.golang.org).
RUN --mount=type=cache,target=/go/pkg/mod for i in 1 2 3; do go mod download && exit 0; sleep 5; done; exit 1
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags "-s -w" -o /out/inventory ./cmd/inventory

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/inventory /inventory
ENV PORT=8106
EXPOSE 8106
USER nonroot:nonroot
ENTRYPOINT ["/inventory"]
