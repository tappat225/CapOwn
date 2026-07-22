# CapOwn Documentation

<!-- SPDX-License-Identifier: Apache-2.0 -->

These documents describe the current Go Master and TypeScript Worker
implementation. The classic repository contains older Python deployment and
execution documentation; it is not authoritative for this repository.

## Guides

- [Getting Started](getting-started.md) - Run a Master, create credentials,
  register a Worker, and connect an MCP client.
- [Deployment](deployment.md) - Docker Compose, local installation, persistent
  paths, reverse proxies, and operational checks.
- [Dashboard guide](../dashboard/README.md) - Static Dashboard development,
  deployment, browser storage, and Master CORS configuration.
- [Architecture](architecture.md) - Control-plane and execution-plane
  boundaries, authentication, heartbeats, claims, and cancellation.
- [MCP](mcp.md) - The current `/mcp` endpoint, client-token rules, tools, and
  plugin calls.

## Canonical references

- [OpenAPI contract](../protocol/openapi.yaml)
- [Protocol guide](../protocol/README.md)
- [MCP transport contract](../protocol/mcp.md)
- [Plugin protocol](../protocol/plugin-protocol.md)
- [Master implementation guide](../master/README.md)
- [Worker implementation guide](../worker/README.md)
- [Dashboard guide](../dashboard/README.md)

The OpenAPI document defines routes, JSON fields, authentication classes,
status codes, and SSE framing. Update it before changing observable behavior.
