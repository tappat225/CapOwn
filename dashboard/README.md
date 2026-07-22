# CapOwn Dashboard

CapOwn Dashboard is a static Next.js SPA. The browser connects directly to a
CapOwn Master through the versioned `/v1` API and authenticated streaming-fetch
SSE events. The Dashboard has no backend, database, proxy, or server-side token
store.

## Development

Run these commands from the repository root:

```bash
cd dashboard
npm ci
npm run dev
```

Open `http://localhost:3000` and enter the Master origin, such as
`http://localhost:9230`. The Dashboard requires Node.js `>=22`.

## Checks and static build

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

The static output is written to `out/`. It can be served by Nginx, Caddy, an
object-storage website, or the included static Docker server.

## Docker

Run from the repository root:

```bash
docker compose -f dashboard/docker-compose.yml up --build -d
```

The default host port is `3000`; set `CAPOWN_DASHBOARD_PORT` to change it. The
container serves static files only and does not persist Dashboard data.

## Master CORS

Because the browser calls Master directly, configure the Master with the exact
Dashboard origin:

```toml
[master]
allowed_dashboard_origins = ["http://localhost:3000"]
```

For a public deployment, use the real HTTPS origin. Do not use a wildcard
allowlist for a public Master.

## Browser storage

- The Master origin is stored in `localStorage` under
  `capown_master_origin`.
- The current `cown_web_*` session token is stored only in `sessionStorage`.
- Credentials, bearer tokens, registration tokens, and plugin secrets are not
  logged or persisted by the Dashboard.

## Layout

```text
src/app/                 Static pages and login flow
src/components/          Dashboard, navigation, and Worker UI
src/lib/master-client.ts Browser Master client, validation, storage, and SSE
next.config.ts           Static export configuration
out/                     Generated build output (ignored)
```
