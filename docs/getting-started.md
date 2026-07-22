# Getting Started

<!-- SPDX-License-Identifier: Apache-2.0 -->

This guide runs the current Master and Worker, then connects an MCP client.
The protocol is still pre-user-development `v1`; use
[`protocol/openapi.yaml`](../protocol/openapi.yaml) for exact request and
response shapes.

## Prerequisites

- Go 1.23 or newer for the Master.
- Node.js 20.18 or newer and npm for the Worker.
- Docker and Docker Compose for the recommended Master deployment.
- A client token for REST or MCP access.

The Worker does not require an inbound port. The Master must be reachable by
both the Worker and the client.

## 1. Start the Master

From the repository root:

```bash
cd master
docker compose up -d --build
```

The default host port is `9230`. To use another host port, change only the
mapping:

```bash
MASTER_PORT=9320 docker compose up -d --build
```

The container still listens on port `9230`. Persistent configuration and the
SQLite database live under `~/.capown/master`; on Windows the default is
`%USERPROFILE%\.capown\master`. Set `CAPOWN_MASTER_DIR` when Docker cannot
resolve the intended home directory.

When the default registries are not reachable, provide alternate build sources
through `GO_IMAGE`, `ALPINE_IMAGE`, `ALPINE_MIRROR`, and `GOPROXY` before the
same Compose command. See [Deployment](deployment.md) for an example.

Check the process:

```bash
curl http://localhost:9230/healthz
curl http://localhost:9230/v1/health
```

For a local non-Docker install, run `bash scripts/install-master.sh` from the
repository root. The Windows equivalent is
`scripts/install-master.ps1`.

## 2. Create the first user

The first user becomes an administrator and does not need an invitation:

```bash
curl -X POST http://localhost:9230/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"replace-this-password"}'
```

Use the returned web session with the web management endpoints or Dashboard.
After initialization, normal user registration requires an administrator
invitation.

## 3. Create a Worker registration link

Create a registration token through the authenticated web API:

```bash
curl -X POST http://localhost:9230/v1/worker-registrations \
  -H "Authorization: Bearer <web-session>" \
  -H "Content-Type: application/json" \
  -d '{"label":"workstation","expires_in":86400,"max_uses":1}'
```

The response contains a plaintext `registration_token` and, when
`CAPOWN_MASTER_PUBLIC_URL` is configured, a `registration_url`. Treat both as
secrets. The plaintext token is returned only when the registration token is
created.

## 4. Register and start a Worker

On the target machine, build or install the Worker and register it with the
link from the previous step:

```bash
cd worker
npm ci
npm run build
node dist/src/cli.js register \
  http://localhost:9230/v1/worker-registrations/<token> \
  --name build-host
node dist/src/cli.js start --foreground
```

After installation, the same commands are available as `capown-worker`:

```bash
capown-worker register https://master.example.com/v1/worker-registrations/<token>
capown-worker start
capown-worker status
capown-worker logs --no-follow
```

The Worker stores its configuration at
`~/.capown/worker/config.toml` and its Ed25519 identity at
`~/.capown/worker/identity.toml` by default. Registration saves the Worker ID
and name; the registration token is not persisted.

The first Worker startup provisions the local `filesystem` MCP plugin and its
private `~/.capown/worker/workspace` directory. This plugin is local trusted
code, not an operating-system sandbox.

## 5. Create a client token

Client tokens are created through the authenticated web token API:

```bash
curl -X POST http://localhost:9230/v1/tokens \
  -H "Authorization: Bearer <web-session>" \
  -H "Content-Type: application/json" \
  -d '{"type":"client","label":"mcp-host"}'
```

Store the returned plaintext token securely. It is shown only at creation
time and can later be disabled or revoked through the web token API.

## 6. Connect through MCP

Configure the MCP host to send requests to:

```text
http://localhost:9230/mcp
Authorization: Bearer <client-token>
```

The endpoint is stateless. Every request needs the client token and the MCP
`Accept: application/json, text/event-stream` header. See [MCP](mcp.md) for
initialization, tools, Origin handling, and examples.

## 7. Use the REST client

The repository also includes a small standard-library client. It reads the
default config at `~/.capown/client/config.toml` (or the path passed with
`--config`):

```toml
role = "client"
master_url = "http://localhost:9230"
client_token = "<client-token>"

[client]
soft_timeout = 30
```

List Workers from the command line:

```bash
python client/capown_client.py workers-list
```

The library API remains available for Python callers:

```python
from client.capown_client import CapownClient, ClientConfig

client = CapownClient(ClientConfig(
    master_url="http://localhost:9230",
    client_token="<client-token>",
))
print(client.workers_list())
```

Its methods target the same `/v1` contract. It is not a replacement protocol
and exposes MCP-aligned methods such as `workers_list`, `worker_get`,
`plugin_list`, `plugin_call`, `task_get`, `task_wait`, and `task_cancel`.

## Troubleshooting

- Master health fails: inspect `docker compose logs -f master` and verify the
  host port mapping.
- Worker is offline: run `capown-worker status`, then
  `capown-worker logs --no-follow`; verify `master_url` and network access.
- Registration fails: create a fresh registration token and verify that the
  URL uses `/v1/worker-registrations/<token>`.
- MCP returns `401`: use a client token, not a web session, admin token,
  Worker session, or registration token.
