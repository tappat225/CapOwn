# Protocol Changelog

<!-- SPDX-License-Identifier: Apache-2.0 -->

## 0.1.0 - 2026-07-19

First pre-user baseline of the CapOwn control-plane protocol.

This release includes authentication, Worker registration and heartbeats,
claim-based task delivery, task cancellation, plugin discovery and invocation,
token management, Dashboard SSE, and the MCP Streamable HTTP endpoint.

Master and Worker are updated together. No external compatibility guarantee is
made before `1.0.0`.

## 0.1.1 - 2026-07-21

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

## Pre-0.1.0 development history

Versions `1.0.0` through `1.9.0` were internal, unreleased exploratory
revisions. Their detailed history remains available in Git and is not part of
the public protocol version history.
