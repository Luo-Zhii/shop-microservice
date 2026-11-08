# Máy dev không cần cài Go: mọi lệnh chạy trong golang:1.23-alpine (cache mod/build ở named volume).
GO_IMAGE ?= golang:1.23-alpine
TEST_DATABASE_URL ?= postgres://shopnow:shopnow@localhost:55432/inventory_test
IMAGE ?= shopnow/inventory:dev
GO = docker run --rm --network host -e GOTOOLCHAIN=local -e TEST_DATABASE_URL=$(TEST_DATABASE_URL) \
	-v $(CURDIR):/src -v shopnow-gomod:/go/pkg/mod -v shopnow-gocache:/root/.cache/go-build -w /src $(GO_IMAGE)

.PHONY: test build lint image

test:
	$(GO) go test -count=1 ./...

build:
	$(GO) sh -c 'CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/inventory ./cmd/inventory'

lint:
	$(GO) sh -c 'test -z "$$(gofmt -l .)" || { gofmt -l .; exit 1; }; go vet ./...'

image:
	docker build -t $(IMAGE) .
