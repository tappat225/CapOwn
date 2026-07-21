# CapOwn Plugin Registry

<!-- SPDX-License-Identifier: Apache-2.0 -->

This directory contains the official CapOwn plugin catalog. The Master loads
`registry.json` at startup and exposes it through a read-only catalog endpoint.
The Dashboard renders the catalog as a plugin marketplace; Workers use it to
resolve package URLs and manifest templates during installation.

## Admission principle

A plugin MUST operate on the **local resources of the Worker machine** to
qualify for this registry. Valid local resources include:

- filesystem (read, write, watch, search)
- local databases (SQLite, embedded KV stores)
- intranet services reachable only from the Worker host
- hardware interfaces (serial ports, USB, GPIO)
- local container runtimes (Docker, Podman)
- OS-level operations (process management, system metrics)

Plugins that merely call public SaaS APIs (weather, maps, GitHub.com REST,
search engines, LLM providers, etc.) MUST NOT be added here. Those capabilities
should be invoked directly by the AI agent on the host machine; routing them
through a remote Worker adds latency without benefit.

**Rule of thumb**: if the plugin would work identically on any machine with
internet access, it does not belong on a Worker.

## Registry format

`registry.json` is a UTF-8 JSON document:

```jsonc
{
  "schema_version": 1,          // bump on breaking format changes
  "updated_at": "<RFC 3339>",   // last modification timestamp
  "plugins": [ ... ]
}
```

### Plugin entry

| Field | Type | Description |
|-------|------|-------------|
| `plugin_id` | string | Unique ID; must match Worker manifest `plugin_id`. |
| `display_name` | string | Human-friendly name for the Dashboard. |
| `description` | string | One-line summary of what the plugin does. |
| `icon` | string | Icon identifier (Dashboard icon set) or URL. |
| `tags` | string[] | Categorization tags for filtering. |
| `publisher` | string | Publisher identifier (`capown-official` or third-party). |
| `source` | string | `"bundled"` (shipped with Worker) or `"registry"` (downloadable). |
| `versions` | array | Ordered list of published versions (newest first). |

### Version entry

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | SemVer version of the plugin. |
| `published_at` | string | RFC 3339 publication timestamp. |
| `package_url` | string | HTTPS URL to the `.tar.gz` package. Empty for bundled plugins. |
| `sha256` | string | Hex SHA-256 of the package file. Empty for bundled plugins. |
| `requires` | object | Runtime requirements (e.g. `{"node": ">=20.18.0"}`). |
| `manifest` | object | Worker plugin manifest template (see below). |

### Manifest template

The `manifest` object follows the Worker plugin manifest schema defined in
`protocol/plugin-protocol.md` §3.1, with two template variables:

- `{{install_dir}}` — replaced by the Worker with the plugin's installation
  directory at install time.
- `{{workspace}}` — replaced by the Worker's workspace path.

## Package format

Plugin packages are `.tar.gz` archives:

```
<plugin_id>-<version>.tar.gz
├── manifest.json        # optional; informational, registry is authoritative
├── dist/                # compiled entrypoint and assets
│   └── index.js
├── package.json         # runtime metadata
└── node_modules/        # pre-bundled dependencies (if any)
```

The Worker extracts the archive into `~/.capown/worker/plugins/<plugin_id>/`
and generates `plugins.d/<plugin_id>.json` from the registry manifest template.

## Deployment

The canonical registry file lives at the repository root (`registry/registry.json`).
At install or deploy time it is copied to the Master data directory:

| Deployment | Registry target |
|---|---|
| Local install (bash) | `~/.capown/master/registry/registry.json` (copied by installer) |
| Local install (PowerShell) | `%USERPROFILE%\.capown\master\registry\registry.json` (copied by installer) |
| Docker | `/data/registry/registry.json` (seeded from `/opt/capown/registry/` on first run) |

The Master searches for the registry at startup in this order when
`registry_path` is not explicitly configured:

1. `~/.capown/master/registry/registry.json`
2. `./registry/registry.json` (when cwd is the install dir)
3. `../registry/registry.json` (when cwd is `master/`)
4. Beside the Master executable

## Schema validation

The Master rejects a malformed registry at startup:

- `schema_version` must be `1`
- `updated_at` must be a non-empty RFC 3339 timestamp
- Each `plugin_id` must be unique and non-empty
- `source` must be `"bundled"` or `"registry"`
- `versions` must be non-empty
- When `source: "registry"`:
  - `package_url` must start with `https://`
  - `sha256` must be a non-empty 64-character hex string
- When `source: "bundled"`: `package_url` and `sha256` may be empty

If the file exists but is malformed the Master fails to start. If the file
does not exist the Master starts with a warning and an empty catalog (all
install requests will fail).

## Security requirements

- `package_url` MUST use HTTPS. Workers MUST reject `http://`.
- `sha256` is mandatory for all registry-source plugins. Workers MUST verify
  the hash before extraction and fail on mismatch.
- `manifest.command` arguments that look like paths MUST be inside
  `{{install_dir}}`. Interpreters in system PATH are allowed as argv[0].
- The Master rejects `plugin_install` for `source: "bundled"` plugins.
- The Master rejects `plugin_uninstall` for `source: "bundled"` plugins.
- Unknown plugin IDs are allowed for `plugin_uninstall` (cleanup) but not
  for `plugin_install`.
- The Master strips any `package_url`, `sha256`, or `manifest` fields from
  the client request and always pins from the registry.
- `manifest.env` MUST NOT contain secrets; secrets are configured locally by
  the Worker operator after installation.

## Change process

1. Open a pull request adding or updating an entry in `registry.json`.
2. Verify the plugin meets the admission principle above.
3. Ensure `sha256` matches the published package.
4. After merge, the Master picks up the change on next restart or reload.
