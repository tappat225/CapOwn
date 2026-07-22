# CapOwn

CapOwn is a self-hosted control plane for AI-agent-accessible Workers. A
Master manages users, authentication, Worker registration, task routing, and
results. Workers connect outbound and execute approved local MCP plugins.

The repository is split into independently deployable components:

- **`master/`** - Go HTTP API, SQLite persistence, authentication, task
  admission and routing, claim queues, result correlation, MCP-over-HTTP, and
  Dashboard events.
- **`worker/`** - TypeScript/Node Worker for Ed25519 authentication,
  heartbeats, claim-based task and cancellation delivery, and local MCP-over-
  stdio plugins.
- **`dashboard/`** - Static Next.js browser Dashboard that connects directly to
  the Master HTTP API and authenticated Dashboard event stream.
- **`client/`** - Minimal standard-library Python REST client for task and
  plugin operations.
- **`protocol/`** - Language-independent wire contract. The OpenAPI document
  is the canonical source for observable behavior.
- **`scripts/`** - Local installation and versioning helpers.

## Why CapOwn

CapOwn connects an AI agent to remote execution nodes without making each
Worker a public server. The Master is the control plane; the Worker remains
the execution boundary on the machine where its plugins run.

The current milestone provides:

- User registration, web sessions, client tokens, Worker registration tokens,
  and owner-scoped access.
- Ed25519 Worker identity and challenge-response authentication.
- Runtime heartbeats with stale-Worker detection and task recovery.
- Claim-based delivery for plugin calls and cancellation, with delivery leases
  and correlated results.
- MCP Streamable HTTP at `/mcp` for listing Workers, inspecting plugins,
  invoking plugin tools, and managing tasks.
- Local MCP-over-stdio plugin discovery, lifecycle management, and invocation.

The Worker does not directly implement shell, file, or container execution.
Those capabilities must be provided by local plugins described by the current
protocol. Dashboard SSE is for authenticated management events; Workers
receive tasks and cancellation only through the job-claim endpoint.

## Architecture

```text
[MCP host / REST client] -- HTTP --> [Master]
                                      |-- SQLite: users, tokens, Workers
                                      |-- in-memory: sessions, challenges,
                                      |              task queues and leases
                                      |-- Dashboard SSE events
                                           ^
                                           | register, authenticate,
                                           | heartbeat, claim, report
                                           |
                                      [Worker + local MCP plugins]
```

See [Architecture](docs/architecture.md) for the lifecycle and component
boundaries.

## Quick start

### Run the Master with Docker Compose

```bash
cd master
docker compose up -d --build
```

The default host port is `9230`. Master configuration and SQLite data are
stored under `~/.capown/master` (or `%USERPROFILE%\.capown\master` on
Windows). See [Getting Started](docs/getting-started.md) for first-user setup
and Worker registration. For mainland China deployments, the build source
variables are documented in [Deployment](docs/deployment.md).

### Install the Master locally

```bash
bash scripts/install-master.sh
~/.capown/bin/capown-master
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-master.ps1
& "$HOME\.capown\bin\capown-master.cmd"
```

### Build and test the Worker

```bash
cd worker
npm ci
npm run typecheck
npm test
npm run build
```

The Worker requires Node `>=20.18.0`. It can be installed from the repository
root with `scripts/install-worker.sh` or `scripts/install-worker.ps1`.

### Uninstall local components

```bash
python3 scripts/uninstall.py worker
python3 scripts/uninstall.py --all --yes
python3 scripts/uninstall.py master --force
```

Without `--yes` or `--force`, the script asks whether to keep the selected
components' data. `--yes` keeps data and `--force` removes it. Dashboard is
not managed by this script.

### Build and test the Dashboard

```bash
cd dashboard
npm ci
npm run typecheck
npm test
npm run build
```

The Dashboard requires Node `>=22`. It produces a static `out/` directory and
can be served independently. Configure the Master
`allowed_dashboard_origins` list with the exact Dashboard origin.

## Documentation

- [Documentation index](docs/README.md)
- [Getting Started](docs/getting-started.md)
- [Deployment](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [MCP](docs/mcp.md)
- [Protocol contract](protocol/README.md)
- [Master README](master/README.md)
- [Worker README](worker/README.md)
- [Dashboard README](dashboard/README.md)
- [Plugin protocol](protocol/plugin-protocol.md)

## Development checks

```bash
(cd master && go test ./... && go vet ./...)
(cd worker && npm run typecheck && npm test)
(cd dashboard && npm run format && npm run lint && npm run typecheck && npm test && npm run build)
npx --yes swagger-cli validate protocol/openapi.yaml
node scripts/version.mjs sync-worker
node scripts/version.mjs sync-dashboard
node scripts/version.mjs check
```

The exact commands and protocol governance rules are documented in
`AGENTS.md`.
