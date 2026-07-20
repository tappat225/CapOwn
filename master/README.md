# CapOwn Master -- Go Implementation

Next-generation Master server for CapOwn, written in Go.

The current `/v1` wire contract is defined centrally in
[`../protocol/openapi.yaml`](../protocol/openapi.yaml). Master endpoints must
implement that specification.

## Architecture

```
[Dashboard (browser)] --- CORS ---+
                                  |--- [Master (Go)] --- SQLite ---> master.db
[Worker (TypeScript)] -- Ed25519 -+         |
                                            |--- ChallengeStore (in-memory)
                                            |--- SessionStore  (in-memory)
                                            |--- TaskStore     (job claim queues)
                                            |--- DashboardBus  (user events)
```

## Quick Start

### Docker Compose (recommended)

```bash
# Run from this directory.
docker compose up -d --build
```

The default host port is `9230`. Use `MASTER_PORT` to change only the host
mapping; the Master still listens on port `9230` inside the container:

```bash
MASTER_PORT=9320 docker compose up -d --build
```

For a public or reverse-proxied deployment, set
`CAPOWN_MASTER_PUBLIC_URL` to the Dashboard-visible Master URL.

The Compose setup bind-mounts the user's
`~/.capown/master` directory (`%USERPROFILE%\.capown\master` on Windows) to
the container. The first run creates `config.toml`; the SQLite database is
stored below the same directory. Set `CAPOWN_MASTER_DIR` explicitly if the
Docker environment cannot resolve the home directory.

The mounted `config.toml` is the persistent source of truth for CORS. An empty
`allowed_dashboard_origins` list leaves CORS unrestricted by default, which is
convenient for self-hosted deployments. For a public deployment, configure the
exact Dashboard origins that should be allowed:

```toml
[master]
allowed_dashboard_origins = ["https://dashboard.example.com"]
```

Keep this list restricted to trusted Dashboard origins when the Master is
exposed beyond a local or private network. The official CapOwn service can
provide its own deployment-specific allowlist.

Then restart the Master:

```bash
docker compose restart
```

The Compose environment variable
`CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS` is an optional override for
automation or temporary deployments. If set, it takes precedence over the
file and accepts comma-separated exact Origins.

After startup, point the Dashboard at `http://localhost:<port>`. User setup,
Worker registration links, and Worker management are handled from there.

### Local installation

From the repository root:

```bash
bash scripts/install-master.sh
~/.capown/bin/capown-master
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-master.ps1
& "$HOME\.capown\bin\capown-master.cmd"
```

The installer requires Go 1.23+, does not create a system service, and stores
all local state under `~/.capown/master` or `%USERPROFILE%\.capown\master`.

### Manual development run

```bash
# Keep development state outside the repository.
mkdir -p "$HOME/.capown/master/data"
if [ ! -f "$HOME/.capown/master/config.toml" ]; then
  cp config.toml.example "$HOME/.capown/master/config.toml"
fi

# Run the Master with user-directory state.
CAPOWN_MASTER_CONFIG="$HOME/.capown/master/config.toml" \
CAPOWN_MASTER_DB_PATH="$HOME/.capown/master/data/master.db" \
go run ./cmd/capown-master
```

On Windows PowerShell:

```powershell
$masterHome = Join-Path $HOME ".capown\master"
New-Item -ItemType Directory -Path (Join-Path $masterHome "data") -Force | Out-Null
if (-not (Test-Path (Join-Path $masterHome "config.toml"))) {
    Copy-Item .\config.toml.example (Join-Path $masterHome "config.toml")
}
$env:CAPOWN_MASTER_CONFIG = Join-Path $masterHome "config.toml"
$env:CAPOWN_MASTER_DB_PATH = Join-Path $masterHome "data\master.db"
go run ./cmd/capown-master
```

The master listens on `0.0.0.0:9230` by default.

## First User Registration

```bash
curl -X POST http://localhost:9230/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "my-secure-password"}'
```

The first user is created as an admin without an invitation. After
initialization, administrators issue one-time invitations for normal user
registration. Invitation plaintext is returned once and only its hash is
stored by the Master.

## API

### Meta
```
GET /v1/meta
```

### Authentication (Web Sessions)
```
POST /v1/auth/register    -- first admin or invited normal-user registration
POST /v1/auth/login       -- username + password -> cown_web_* session
POST /v1/auth/logout      -- revoke session
GET  /v1/me               -- current user info
PATCH /v1/me/password     -- change password
```

### Client Tokens
```
GET    /v1/tokens?type=client   -- list your tokens
POST   /v1/tokens               -- create a token
PATCH  /v1/tokens/{id}          -- enable or disable an owned client token
DELETE /v1/tokens/{id}          -- revoke a token
```

### Worker Registration Tokens
```
GET    /v1/worker-registrations            -- list registration tokens
POST   /v1/worker-registrations            -- create registration token
DELETE /v1/worker-registrations/{id}       -- revoke
```

### Worker Management
```
GET    /v1/workers              -- list your workers
GET    /v1/workers/{id}         -- get worker info
PATCH  /v1/workers/{id}         -- rename worker
DELETE /v1/workers/{id}         -- revoke worker
GET    /v1/workers/{id}/plugins -- list reported plugins
PATCH  /v1/workers/{id}/plugins/{plugin_id} -- enable or disable a plugin
```

### Worker API (TypeScript Worker)
```
POST /v1/workers                           -- register (with cown_register_* token)
POST /v1/workers/auth/challenges           -- request Ed25519 nonce
POST /v1/workers/auth/sessions             -- verify signed nonce
PUT  /v1/workers/{id}/runtime              -- report runtime metadata
POST /v1/workers/{id}/jobs/claim            -- long-poll and claim jobs
```

### Tasks
```
POST /v1/tasks                              -- enqueue a task
GET  /v1/tasks/{task_id}                    -- get task status/result
PUT  /v1/tasks/{task_id}/result             -- report a task result
POST /v1/tasks/{task_id}/cancel             -- cancel a task
```

### Dashboard Events
```
GET /v1/events   -- SSE stream (requires cown_web_* session)
```

### Admin APIs
```
GET    /v1/admin/users                                     -- list users
POST   /v1/admin/users                                     -- create user
GET    /v1/admin/users/{username}                           -- get user
PATCH  /v1/admin/users/{username}                           -- update user
DELETE /v1/admin/users/{username}                           -- permanently deprovision user
GET    /v1/admin/users/{username}/tokens                    -- list user tokens
POST   /v1/admin/users/{username}/tokens                    -- create user token
DELETE /v1/admin/tokens/{id}                                -- revoke any token
GET    /v1/admin/users/{username}/worker-registrations      -- list registrations
POST   /v1/admin/users/{username}/worker-registrations      -- create registration
DELETE /v1/admin/worker-registrations/{id}                   -- revoke registration
GET    /v1/admin/invitations                                -- list user invitations
POST   /v1/admin/invitations                                -- create one-time invitation
DELETE /v1/admin/invitations/{id}                           -- revoke invitation
```

## Configuration

See `config.toml.example` for all options.

| Env Variable | Config Field | Default |
|-------------|-------------|---------|
| `CAPOWN_MASTER_CONFIG` | config file path | auto-detected |
| `CAPOWN_MASTER_HOST` | host | `0.0.0.0` |
| `CAPOWN_MASTER_PORT` | port | `9230` |
| `CAPOWN_MASTER_DB_PATH` | db_path | `./data/master.db` |
| `CAPOWN_MASTER_PUBLIC_URL` | public_url | `""` |
| `CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS` | allowed_dashboard_origins | empty (uses config file; empty list is unrestricted) |
| `CAPOWN_MASTER_LOG_LEVEL` | log_level | `"info"` |

`CAPOWN_MASTER_PUBLIC_URL` is used to generate Worker registration links
(e.g. `https://master.example.com/v1/worker-registrations/<token>`).
When set, the `POST /v1/worker-registrations` response includes a
`registration_url` field with a ready-to-use link for `capown-worker register`.

## Build

```bash
go build ./cmd/capown-master
```

## Test

```bash
go test ./...
```

## Docker image

Use the Docker Compose setup above for normal deployment. It binds the
container's `/data` directory to the user's `.capown/master` directory so
configuration and database state survive container recreation.

## Token Prefixes

| Prefix | Type | Storage |
|--------|------|---------|
| `cown_web_*` | Web session (dashboard) | DB (SHA-256) |
| `cown_sess_*` | Worker session | In-memory |
| `cown_register_*` | Worker registration | DB (SHA-256) |

## Design Decisions

- **Single SQLite database**: Unifies Python Master's split registry.db and users.db
- **In-memory challenge/session stores**: Nonces and worker sessions are ephemeral; Master restart requires workers to re-authenticate (matching Python behavior)
- **Go 1.22+ ServeMux**: Uses `"GET /path/{param}"` syntax -- no third-party router
- **Claim-based jobs**: Workers claim tasks and cancellation jobs through a
  long-poll endpoint; short delivery leases requeue interrupted claims, and a
  task becomes running only after Worker confirmation with the current opaque
  delivery ID. Task payloads are delivered only through the claim endpoint.
- **Runtime heartbeats**: Workers periodically report runtime metadata to keep
  their liveness lease fresh. Stale Workers are marked offline and their
  unfinished tasks are recovered.
- **Ed25519 via crypto/ed25519**: Pure Go implementation matching Node.js `crypto.sign()`
- **PBKDF2-HMAC-SHA256**: 600,000 iterations, hex salt -- Python-compatible password hashing
- **Registration links**: When `CAPOWN_MASTER_PUBLIC_URL` is configured, the Master returns full registration URLs for the Worker CLI
