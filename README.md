
# CapOwn-next

Next generation of CapOwn core service. Components:

- **`master/`** - Go HTTP API server (SQLite, Ed25519 auth, job claims, heartbeats)
- **`worker/`** - TypeScript/Node Worker (job claims, plugin execution, heartbeats)
- **`protocol/`** - Language-independent wire contract
- **`scripts/`** - Installation helpers

The language-independent control-plane contract is maintained in
[`protocol/`](./protocol/), with the current OpenAPI specification at
[`protocol/openapi.yaml`](./protocol/openapi.yaml).

## Running the Master

The Master can be run locally or with Docker Compose. Both methods keep the
configuration and SQLite data under the user's CapOwn directory:

```text
Linux/macOS: ~/.capown/master/
Windows:     %USERPROFILE%\.capown\master\
```

### Docker Compose

```bash
cd master
docker compose up -d --build
```

The default host port is `9230`. To choose another mapped host port, pass
`MASTER_PORT`; the container continues to listen on `9210`:

```bash
MASTER_PORT=9320 docker compose up -d --build
```

For a public or reverse-proxied deployment, override
`CAPOWN_MASTER_PUBLIC_URL` with the Dashboard-visible Master URL.

On Windows PowerShell:

```powershell
cd master
$env:MASTER_PORT = "9320"
docker compose up -d --build
```

After the Master is running, connect the Dashboard to
`http://localhost:<port>`. The Dashboard can then perform first-user setup,
create Worker registration links, and manage Workers. The Master data remains
in `~/.capown/master` (or `%USERPROFILE%\.capown\master` on Windows).

An empty `allowed_dashboard_origins` list leaves CORS unrestricted by default,
which is convenient for self-hosted deployments. For a Dashboard deployed
elsewhere or any public deployment, edit the persistent Master configuration
at `~/.capown/master/config.toml` (or `%USERPROFILE%\.capown\master\config.toml`)
and set the exact trusted Dashboard origins:

```toml
[master]
allowed_dashboard_origins = ["https://dashboard.example.com"]
```

Apply the change with `docker compose restart`. The environment variable
`CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS` remains available as an explicit
override for automation and temporary deployments. The official CapOwn service
can apply its own deployment-specific allowlist.

Useful commands:

```bash
docker compose logs -f master
docker compose stop
docker compose start
docker compose down
```

Set `CAPOWN_MASTER_DIR` when Docker Desktop or a shell does not expose the
home-directory environment variable automatically. It must point to the
user's `.capown/master` directory.

### Local installation

The local installer builds the Go binary and creates a launcher. It does not
create a system service.

```bash
bash scripts/install-master.sh
~/.capown/bin/capown-master
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-master.ps1
& "$HOME\.capown\bin\capown-master.cmd"
```

The local install stores the configuration at
`~/.capown/master/config.toml` and the database at
`~/.capown/master/data/master.db`.
