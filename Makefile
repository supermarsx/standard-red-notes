# =============================================================================
# Standard Red Notes - top-level Makefile
#
# Thin, conventional wrappers around the EXISTING yarn / docker / setup commands
# (see package.json "scripts", docker-compose.yml, and scripts/setup.*). Nothing
# here invents new build logic; every recipe forwards to a command that already
# works on its own.
#
# Requires GNU make. On Windows use WSL or Git Bash (the recipes shell out to
# yarn, docker, and a bash setup script). Run `make` or `make help` for a list.
# =============================================================================

SHELL := /bin/sh
.DEFAULT_GOAL := help

.PHONY: help install install-app install-server build build-app build-server \
        build-mcp build-openclaw test lint typecheck format check setup up down \
        logs config clean

## ---------------------------------------------------------------------------
## Help
## ---------------------------------------------------------------------------

help: ## Show this help (default target)
	@echo "Standard Red Notes - make targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

## ---------------------------------------------------------------------------
## Install
## ---------------------------------------------------------------------------

install: ## Install root workspace deps (yarn install). App/server have their own deps - see install-app / install-server.
	yarn install

install-app: ## Install the app workspace deps (yarn install in ./app)
	cd app && yarn install

install-server: ## Install the server workspace deps (yarn install in ./server)
	cd server && yarn install

## ---------------------------------------------------------------------------
## Build (wrap package.json build scripts)
## ---------------------------------------------------------------------------

build: ## Build everything: mcp, openclaw, app, server (yarn build)
	yarn build

build-app: ## Build the web/app workspaces (yarn build:app -> cd app && yarn build:all)
	yarn build:app

build-server: ## Build the server workspaces (yarn build:server -> cd server && yarn build)
	yarn build:server

build-mcp: ## Build the MCP bridge (yarn build:mcp)
	yarn build:mcp

build-openclaw: ## Build the openclaw workspace (yarn build:openclaw)
	yarn build:openclaw

## ---------------------------------------------------------------------------
## Quality (wrap package.json test/lint/typecheck/format scripts)
## ---------------------------------------------------------------------------

test: ## Run all tests: openclaw, app, server (yarn test)
	yarn test

lint: ## Lint/typecheck all workspaces (yarn lint)
	yarn lint

typecheck: ## Type-check the mcp + openclaw workspaces (yarn typecheck)
	yarn typecheck

format: ## Auto-format all workspaces (yarn format)
	yarn format

check: ## Full gate: typecheck + lint + format:check + test (yarn check)
	yarn check

## ---------------------------------------------------------------------------
## Self-hosting setup
## ---------------------------------------------------------------------------

setup: ## Generate .env with secrets and (interactively) start the stack (scripts/setup.sh)
	./scripts/setup.sh

## ---------------------------------------------------------------------------
## Docker Compose stack
## ---------------------------------------------------------------------------

up: ## Build and start the full stack in the background (docker compose up -d --build)
	docker compose up -d --build

down: ## Stop and remove the stack containers (yarn docker:down -> docker compose down)
	yarn docker:down

logs: ## Follow logs from all stack services (docker compose logs -f)
	docker compose logs -f

config: ## Render the resolved compose configuration (yarn docker:config -> docker compose config)
	yarn docker:config

## ---------------------------------------------------------------------------
## Clean
## ---------------------------------------------------------------------------

# Conservative: removes only build output and installed dependencies in the repo
# root, ./app, and ./server. Does NOT touch Docker volumes (your data/db), .env,
# or anything outside these trees. Re-run `make install` afterwards.
clean: ## Remove node_modules and dist/build output in root, app, and server (NOT Docker volumes or .env)
	rm -rf node_modules app/node_modules server/node_modules
	rm -rf app/dist server/dist
	rm -rf packages/*/dist
