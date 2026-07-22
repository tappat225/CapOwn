# Versioning

<!-- SPDX-License-Identifier: Apache-2.0 -->

## Source of truth

`version.json` is the only committed source for Dashboard release metadata:

- `dashboard_version` identifies the Dashboard SPA release.
- `minimum_protocol_version` identifies the oldest CapOwn Master protocol that
  this Dashboard accepts.

The Dashboard version is independent from the CapOwn core product version.
The protocol version is also independent from both software versions.

## Compatibility policy

Dashboard accepts a Master when its valid SemVer protocol version is greater
than or equal to `minimum_protocol_version`. A Master advertising a lower or
invalid protocol version is rejected during metadata discovery.

This minimum-only policy is intentional for the current pre-user project. The
protocol is still `0.x`, so a future protocol minor version may contain a
breaking change. If independent deployments begin, replace this policy with an
explicit supported range or capability negotiation before relying on newer
protocol versions.

## Updating versions

Run the following from the Dashboard repository root after editing
`version.json`:

```bash
node scripts/version.mjs sync
node scripts/version.mjs check
npm run typecheck
npm test
```

The synchronization command updates `package.json`, `package-lock.json`, and
the ignored generated client constants. Do not add another manual version
source.
