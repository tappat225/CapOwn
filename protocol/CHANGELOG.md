# Protocol Changelog

<!-- SPDX-License-Identifier: Apache-2.0 -->

## 0.3.0 - 2026-07-23

Compatible administrative API addition:

- Document `GET /v1/admin/workers`, which returns all non-revoked Workers
  across owners to an administrator Web Session or admin Token.
- Keep `GET /v1/workers` owner-scoped for every caller, including
  administrators using the normal Worker-list endpoint.

## 0.2.0 - 2026-07-22

Plugin call results now support image, audio, and embedded resource content
blocks. Worker-to-Master result fields use `snake_case`; the northbound MCP
response uses MCP's `mimeType` spelling.

## 0.1.1 - 2026-07-21

`POST /v1/workers` treats an Ed25519 `public_key` as the Worker's local
installation identity. A new registration token creates a new `worker_id` even
when the key was previously registered, and supersedes the prior active
registration for that key. Repeating the same token and key is idempotent and
returns `200` with the original registration result without consuming another
token use while that registration remains active. Registration tokens default
to 10 uses so one link supports a
multi-Worker deployment. Worker names are assigned by Master, preserving the
latest name for known keys and deriving a unique name from the reported
hostname for new keys.

Breaking change (pre-1.0, updated together): tighten `plugin_install`
semantics.

- Client `plugin_install` params: only `plugin_id` + optional `version`.
  Sending `package_url`, `sha256`, or `manifest` is rejected.
- Master resolves install params from the registry (pinning `package_url`,
  `sha256`, `manifest`). Bundled plugins cannot be installed or uninstalled.
- Worker enforces HTTPS-only `package_url`, non-empty SHA-256 verification,
  command path confinement to install directory, and AbortSignal cancellation
  for install/uninstall.
- Add deploy-time registry copy: installer scripts and Docker entrypoint copy
  `registry/registry.json` to Master data directory.
- Default registry path: `~/.capown/master/registry/registry.json`.

## 0.1.0 - 2026-07-19

First pre-user baseline of the CapOwn control-plane protocol.

This release includes authentication, Worker registration and heartbeats,
claim-based task delivery, task cancellation, plugin discovery and invocation,
token management, Dashboard SSE, and the MCP Streamable HTTP endpoint.

Master and Worker are updated together. No external compatibility guarantee is
made before `1.0.0`.

## Pre-0.1.0 development history

Versions `1.0.0` through `1.9.0` were internal, unreleased exploratory
revisions. Their detailed history remains available in Git and is not part of
the public protocol version history.
