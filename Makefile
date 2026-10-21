.PHONY: proto build build-go build-frontend test test-go vet lint clean dev provision docker build-linux run stop logs

# Plugin ID (the Explorer is a single app plugin; it uses the existing VictoriaMetrics datasource)
APP_PLUGIN_ID := ahfuzhang-victoriametricsexplorer-app

# Go binary name (must start with gpx_ for Grafana)
GO_BINARY := gpx_victoriametricsexplorer

# Grafana plugin directory (override with GRAFANA_PLUGINS_DIR=...)
GRAFANA_PLUGINS_DIR ?= /usr/local/var/grafana/plugins

# Go flags
GOFLAGS := -trimpath -ldflags="-s -w"
GOTESTFLAGS := -v -race -count=1

# Frontend
NPM ?= npm
YARN ?= yarn

##@ Build

build: build-go build-frontend ## Build the complete plugin (Go backend + frontend)

build-go: ## Build the Go backend binary
	CGO_ENABLED=0 go build $(GOFLAGS) -o dist/$(GO_BINARY)_$$(go env GOARCH) .
	@echo "Built dist/$(GO_BINARY)_$$(go env GOARCH)"
	@# Generate go_plugin_build_manifest.json for the local platform
	@printf '{"exec":"%s","os":"%s","arch":"%s"}\n' "$(GO_BINARY)_$$(go env GOARCH)" "$$(go env GOOS)" "$$(go env GOARCH)" > dist/go_plugin_build_manifest.json
	@echo "Generated go_plugin_build_manifest.json"

build-go-arm64: ## Build the Go backend binary for ARM64
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(GOFLAGS) -o dist/$(GO_BINARY)_arm64 .
	@echo "Built dist/$(GO_BINARY)_arm64"

build-frontend: ## Build the frontend bundles
	$(NPM) run build

##@ Protobuf

proto: ## Generate Go (pkg/proto) and TypeScript (src/generated) code from proto/
	protoc -I proto \
		--go_out=. --go_opt=module=github.com/ahfuzhang/victoriametricsexplorer \
		--plugin=protoc-gen-es=node_modules/.bin/protoc-gen-es \
		--es_out=src/generated --es_opt=target=ts,import_extension=none \
		proto/explorer/explorer.proto
	@# Backend-only messages (cache entries): Go code only.
	protoc -I proto \
		--go_out=. --go_opt=module=github.com/ahfuzhang/victoriametricsexplorer \
		proto/explorer/cache.proto

##@ Development

dev: ## Watch mode for frontend development
	$(NPM) run dev

dev-go: ## Run Go backend in watch mode (requires air)
	air -c .air.toml

##@ Testing

test: test-go test-frontend ## Run all tests

test-go: ## Run Go tests
	go test $(GOTESTFLAGS) ./...

test-frontend: ## Run frontend tests
	$(NPM) test

##@ Quality

vet: ## Run go vet
	go vet ./...

lint: ## Run linters
	$(NPM) run lint
	go vet ./...

lint-fix: ## Fix linting issues
	$(NPM) run lint:fix

typecheck: ## TypeScript type checking
	$(NPM) run typecheck

##@ Provisioning

provision: build ## Build and copy plugin to Grafana plugins directory
	mkdir -p $(GRAFANA_PLUGINS_DIR)/$(APP_PLUGIN_ID)
	cp -r dist/* $(GRAFANA_PLUGINS_DIR)/$(APP_PLUGIN_ID)/
	@echo "Plugin installed to $(GRAFANA_PLUGINS_DIR)/$(APP_PLUGIN_ID)"
	@echo "Restart Grafana to load the plugin."

##@ Docker

docker: ## Build Docker image
	docker build -t $(APP_PLUGIN_ID):dev .

# Docker engine architecture (arm64 on Apple Silicon, amd64 on Intel); the Linux plugin binary must match it
DOCKER_ARCH ?= $(shell docker version --format '{{.Server.Arch}}' 2>/dev/null)
COMPOSE ?= docker compose
GRAFANA_URL ?= http://localhost:3000

# Frontend first: webpack cleans dist/, so the Go binary has to be written after it.
# Grafana resolves the executable next to plugin.json using the <executable>_<os>_<arch> naming.
build-linux: build-frontend ## Build frontend + Linux backend binary for the Docker engine's architecture
	@test -n "$(DOCKER_ARCH)" || { echo "Cannot detect Docker architecture; is Docker running?"; exit 1; }
	CGO_ENABLED=0 GOOS=linux GOARCH=$(DOCKER_ARCH) go build $(GOFLAGS) -o dist/$(GO_BINARY)_linux_$(DOCKER_ARCH) .
	@echo "Built dist/$(GO_BINARY)_linux_$(DOCKER_ARCH)"

run: build-linux ## Build the plugin and start Grafana (+ VictoriaMetrics) in Docker with it installed
	$(COMPOSE) up -d --force-recreate grafana
	@printf "Waiting for Grafana"; \
	for i in $$(seq 1 60); do \
		curl -fsS $(GRAFANA_URL)/api/health >/dev/null 2>&1 && break; \
		printf "."; sleep 1; \
	done; echo
	@curl -fsS $(GRAFANA_URL)/api/health >/dev/null 2>&1 || { echo "Grafana did not become healthy; check 'make logs'"; exit 1; }
	@echo "Grafana is ready: $(GRAFANA_URL)  (login: admin / admin)"
	@echo "Plugin page:      $(GRAFANA_URL)/a/$(APP_PLUGIN_ID)"

stop: ## Stop Grafana and VictoriaMetrics (data volumes are kept)
	$(COMPOSE) down

logs: ## Tail Grafana logs
	$(COMPOSE) logs -f grafana

##@ Clean

clean: ## Clean build artifacts
	rm -rf dist/
	rm -f coverage.out
	@echo "Cleaned."

##@ Help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
