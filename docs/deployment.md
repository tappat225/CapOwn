# Deployment

<!-- SPDX-License-Identifier: Apache-2.0 -->

CapOwn has one central Master and one or more outbound-connected Workers.
Docker is the supported packaging path for the Master. The Worker is a
Node.js application installed on each execution host.

## Master with Docker Compose

```bash
cd master
docker compose up -d --build
```

Compose maps the host port `${MASTER_PORT:-9230}` to the container's fixed
port `9230` and mounts `${CAPOWN_MASTER_DIR:-$HOME/.capown/master}` at
`/data`. Configuration is created at `/data/config.toml`; the database is at
`/data/data/master.db`.

Useful operations:

```bash
docker compose logs -f master
docker compose restart
docker compose stop
docker compose start
docker compose down
```

For a public or reverse-proxied deployment, set
`CAPOWN_MASTER_PUBLIC_URL` to the URL that Workers and clients use. This
allows the Master to return complete Worker registration links and is also
used when validating browser `Origin` headers for MCP.

The persistent `[master].allowed_dashboard_origins` list controls browser
access. An empty list is unrestricted for local self-hosted use. For a public
deployment, set exact trusted origins and restart the service:

```toml
[master]
allowed_dashboard_origins = ["https://dashboard.example.com"]
```

`CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS` is an optional comma-separated
environment override for automation and temporary deployments.

## Local Master installation

The installer builds the Go binary and creates a launcher. It does not create
a system service:

```bash
bash scripts/install-master.sh
~/.capown/bin/capown-master
```

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-master.ps1
& "$HOME\.capown\bin\capown-master.cmd"
```

Use `--prefix <directory>` with either installer to place the installation
under an isolated test home. Master configuration and data remain outside the
repository by default.

## Worker installation

The Worker requires Node.js `>=20.18.0` and npm. From a local checkout:

```bash
bash scripts/install-worker.sh
capown-worker register https://master.example.com/v1/worker-registrations/<token>
capown-worker start
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-worker.ps1
& "$HOME\.capown\bin\capown-worker.cmd" register `
  https://master.example.com/v1/worker-registrations/<token>
& "$HOME\.capown\bin\capown-worker.cmd" start
```

The installer builds an application copy under `~/.capown/worker/app` and
keeps mutable configuration under `~/.capown/worker`. It does not create a
system service or automatically register a Worker.

For a foreground development run:

```bash
cd worker
npm ci
npm run build
node dist/src/cli.js start --foreground
```

## Reverse proxy

Expose the Master origin through TLS and forward both `/v1/` and `/mcp` to
the same upstream. Workers use ordinary HTTP requests for registration,
authentication, heartbeats, claims, and results, so no Worker-specific inbound
listener or SSE proxy is required.

Minimal Nginx shape:

```nginx
server {
    listen 443 ssl;
    server_name master.example.com;

    location / {
        proxy_pass http://127.0.0.1:9230;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Set `CAPOWN_MASTER_PUBLIC_URL=https://master.example.com` and configure the
Dashboard origin allowlist when a browser Dashboard is hosted separately.
Do not copy the old classic proxy rules that route Worker task delivery over
SSE; current Workers use the authenticated claim endpoint.

## Persistent paths

| Data | Default path |
| --- | --- |
| Master config | `~/.capown/master/config.toml` |
| Master database | `~/.capown/master/data/master.db` |
| Worker config | `~/.capown/worker/config.toml` |
| Worker identity | `~/.capown/worker/identity.toml` |
| Worker plugins | `~/.capown/worker/plugins.d/` |
| Worker logs | `~/.capown/worker/worker.log` |
| Master registry | `~/.capown/master/registry/registry.json` |

Keep config, database, identity, registration links, and bearer tokens out of
source control and logs. Registration tokens are returned in plaintext only
when created; client tokens are returned in plaintext only at token creation.

## Operational checks

```bash
curl -fsS https://master.example.com/healthz
curl -fsS https://master.example.com/v1/health
capown-worker status
capown-worker logs --no-follow
```

When a Worker is stale, inspect its last runtime heartbeat and confirm that it
can reach the Master origin. A task is delivered only after the Worker claims
it; Dashboard event delivery does not affect Worker task delivery.
