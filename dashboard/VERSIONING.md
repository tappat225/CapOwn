# Dashboard Versioning

<!-- SPDX-License-Identifier: Apache-2.0 -->

Dashboard versioning is governed by the repository-level
[`VERSIONING.md`](../VERSIONING.md). The source of truth is the root
[`version.json`](../version.json), specifically
`components.dashboard.version` and
`components.dashboard.minimum_protocol_version`.

From `dashboard/`, synchronize the Dashboard package metadata and generated
constants with:

```bash
npm run version:sync
```

Run the complete repository version check from the repository root:

```bash
node scripts/version.mjs sync-worker
node scripts/version.mjs sync-dashboard
node scripts/version.mjs check
```

The generated `src/generated/version.ts` file and build output are ignored.
Do not create a second Dashboard version manifest.
