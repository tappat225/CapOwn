# Versioning

<!-- SPDX-License-Identifier: Apache-2.0 -->

## Version layers

CapOwn uses independent versions for independently deployable components and
for the language-independent control-plane protocol. The committed source is
the root `version.json`:

- `protocol_version` identifies the OpenAPI wire contract.
- `components.master.version` identifies the Go Master.
- `components.worker.version` identifies the Node Worker package.
- `components.dashboard.version` identifies the static Dashboard release.
- `components.dashboard.minimum_protocol_version` identifies the oldest
  protocol that the Dashboard accepts.

The Python Client is currently a source client rather than a separately
published artifact, so it does not have an independent release version yet.
Add one when the Client gains a packaging and release boundary.

Component versions drive update notifications. A Worker-only change bumps the
Worker version without bumping Master or Dashboard. The protocol version only
changes when the observable contract changes; internal implementation changes
do not change it.

## Git release tags

An annotated tag such as `v0.2.0` identifies a repository release snapshot. It
is useful for source archives, release notes, reproducible builds, and rollback,
but it is not the installed version of every component. A release may contain
only a new Worker or Dashboard artifact.

Release automation may pass the tag to builds as `CAPOWN_RELEASE_TAG`. The tag
must not be copied into `version.json` or used as the component update check.

## Compatibility policy

- Component patch releases contain compatible fixes.
- Component minor releases add backward-compatible behavior.
- Component major releases may break that component's public behavior.
- Compatible protocol additions require a protocol minor release; breaking
  route, field, status, authentication, or SSE changes require a protocol major
  release according to the project's pre-1.0 policy.
- A component declares protocol compatibility separately from its own version.
  The Dashboard minimum is generated from
  `components.dashboard.minimum_protocol_version`.

## Build and synchronization

Run these commands from the repository root after editing `version.json`:

```bash
node scripts/version.mjs sync-worker
node scripts/version.mjs sync-dashboard
node scripts/version.mjs check
```

The synchronization command updates the Worker and Dashboard package metadata
and their ignored generated version constants. Do not add another committed
component version source.

Master binaries read `components.master.version` and `protocol_version` from
the manifest. Release builds inject the Master version with Go linker flags.
Docker labels use the Master component version and may include the repository
release tag separately.

For a tagged Master container release:

```bash
export CAPOWN_MASTER_VERSION="$(node scripts/version.mjs master)"
export CAPOWN_PROTOCOL_VERSION="$(node scripts/version.mjs protocol)"
export CAPOWN_RELEASE_TAG="v0.2.0"
docker compose -f master/compose.yaml build
```

On PowerShell:

```powershell
$env:CAPOWN_MASTER_VERSION = node scripts/version.mjs master
$env:CAPOWN_PROTOCOL_VERSION = node scripts/version.mjs protocol
$env:CAPOWN_RELEASE_TAG = "v0.2.0"
docker compose -f master/compose.yaml build
```

The root CI runs both synchronization commands before checking the generated
metadata and OpenAPI version literals.
