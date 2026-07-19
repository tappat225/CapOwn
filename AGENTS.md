# AGENTS.md - CapOwn-next Agent Guide

<!-- SPDX-License-Identifier: Apache-2.0 -->

> Compact operating guide for AI coding assistants working in the rewritten
> CapOwn repository. The wire contract lives in `protocol/openapi.yaml`.

## Repository scope

This repository is the next-generation CapOwn control plane. The legacy Python
repository is a reference for behavior and migration only; do not assume that
its modules, routes, dependencies, or deployment layout exist here.

Top-level responsibilities:

- `master/` - Go Master HTTP API, SQLite persistence, authentication, Worker
  sessions, centralized management and task coordination, claim queues, result
  correlation, MCP-over-HTTP entry point, and Dashboard SSE events.
- `worker/` - TypeScript/Node Worker for registration, Ed25519 authentication,
  runtime heartbeats, claim-based task and cancellation handling, and local
  MCP-over-stdio plugin lifecycle and execution.
- `protocol/` - language-independent protocol contract. OpenAPI is the
  canonical wire definition.

The deployment boundary intentionally combines the management plane and most
global control-plane responsibilities in Master. The execution plane remains
distributed: Workers claim jobs and execute them through local plugin
processes. Master routes and tracks work but does not invoke Worker plugins
directly.

Do not modify the sibling legacy `CapOwn` repository unless the user explicitly
asks for a cross-repository change.

## Commands

Run checks from the component directory unless noted otherwise.

### Master

```bash
cd master
go test ./...
go vet ./...
go build ./cmd/capown-master
go run ./cmd/capown-master
```

### Worker

```bash
cd worker
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` runs TypeScript compilation and Node's built-in test runner. The
Worker targets Node `>=20.18.0` and intentionally keeps dependencies minimal.

### Protocol

```bash
npx --yes swagger-cli validate protocol/openapi.yaml
```

The protocol check requires the Swagger CLI package. If network access or the
package registry is unavailable, still review the OpenAPI file and run the
component tests; do not silently replace the canonical contract with an
implementation-specific type file.

## Protocol-first rules

- Treat `protocol/openapi.yaml` as the source of truth for routes, JSON fields,
  status codes, authentication classes, error envelopes, token semantics, and
  SSE framing.
- Update the protocol document before changing an observable wire behavior.
- Keep `worker/src/protocol.ts` aligned with the OpenAPI schemas. It is an
  implementation view, not an independent protocol definition.
- Use `/v1` as the only protocol prefix during the current pre-user development
  stage and use SemVer in the protocol document. Update Master, Worker, and the
  canonical contract together for breaking changes; do not add `/v2`,
  compatibility shims, or parallel protocol implementations yet.
- Compatible response additions are allowed only when existing consumers can
  ignore them. Current request handlers reject unknown JSON fields, so clients
  must send only fields declared by the endpoint.
- Use UTF-8 JSON with `snake_case` fields, UTC RFC 3339 timestamps, `[]` for
  empty collections, and `Authorization: Bearer <token>` for authenticated
  requests.
- Keep new task types, execution capabilities, result shapes, cancellation
  semantics, and plugin controls out of the implementation until their
  Master-to-Worker protocol is specified first. The current v1 contract already
  includes claim-based `plugin_call` tasks, task results and cancellation,
  plugin discovery, and persistent plugin enable/disable control.
- Treat Worker job claims as the authoritative task and cancellation delivery
  channel. Worker liveness is maintained separately through authenticated
  runtime heartbeats; Worker-specific SSE transport is not part of the current
  protocol.

## Must

- Keep code, comments, docstrings, logs, CLI output, and commit messages in
  English unless the existing file is explicitly user-facing Chinese content.
- Preserve SPDX headers and the license convention of the file being changed.
- Keep Master, Worker, Client, and protocol code independently deployable; do
  not import implementation modules across component boundaries.
- Format Go changes with `gofmt` and keep Go tests in `*_test.go` files.
- Keep Worker code TypeScript ESM-compatible and pass `npm run typecheck`.
- Prefer platform and standard-library capabilities before adding a dependency.
- Update committed `*.example` configuration files whenever configuration shape,
  environment variables, or default paths change.
- Add focused tests for behavior changes, especially authentication, URL/path
  construction, protocol serialization, Dashboard SSE framing/replay,
  heartbeats, job claims, cancellation, and reconnect behavior.
- Keep secrets out of source, tests, logs, fixtures, examples, and error text.
- Use a plain Master origin in configuration, such as
  `http://localhost:9210`; clients append `/v1` themselves.

## Ask first

Ask for confirmation before:

- changing public routes, JSON fields, status codes, error codes, token formats,
  authentication rules, or SSE event semantics;
- changing the `/v1` protocol boundary or introducing another protocol prefix;
- adding a new task type, execution capability, plugin transport, or remotely
  configurable plugin behavior beyond the current protocol;
- changing config locations, environment variable names, deployment behavior,
  or token storage/handling;
- adding a runtime dependency to Master or Worker;
- changing license headers or moving code between component boundaries; or
- deleting, resetting, or rewriting the legacy sibling repository.

## Never

- Never hardcode real tokens, URLs, domains, keys, passwords, or local secrets.
- Never log bearer tokens, private keys, registration tokens, or full request
  bodies that may contain secrets or large payloads.
- Never import Go Master code into Worker code, Worker code into Master code, or
  make the future Python Client depend on either implementation.
- Never use old Python `shared/protocol.py` as the authority for next protocol
  behavior; use `protocol/openapi.yaml` and update language-specific types from
  it.
- Never copy the legacy deployment tree into this repository without checking
  its assumptions about routes, config paths, runtime dependencies, and
  licensing.
- Never deliver Worker tasks or cancellation through Dashboard SSE. Workers
  receive both through the authenticated long-poll job-claim endpoint.
- Never execute plugins inside Master or bypass the Worker claim/result path;
  execution belongs to the target Worker's local plugin runtime.
- Never commit generated build output, local databases, real config files, or
  dependency directories such as `node_modules/`.

## Local architecture

### Master

- Go 1.23 module under `master/`.
- Uses Go `net/http` routing, SQLite, Ed25519 verification, PBKDF2 password
  hashing, in-memory Worker challenge/session stores, an in-memory task store
  with claim queues and delivery leases, and a Dashboard SSE event bus.
- Web sessions use `cown_web_*`; Worker sessions use `cown_sess_*`; Worker
  registration tokens use `cown_register_*`. Client/admin API tokens are opaque
  bearer tokens managed by the Master.
- Worker runtime and job-claim endpoints require a Worker session bound to the
  requested `worker_id`; task-result reports require the session to belong to
  the task's target Worker.
- Worker listing/detail endpoints are owner-scoped and use the caller's valid
  bearer identity; administrative operations require the appropriate web/admin
  authorization described in the protocol.
- Master owns global task admission, authorization, routing, queueing, delivery
  leases, cancellation coordination, status, and result correlation. It does
  not start or invoke plugin processes directly.

### Worker

- TypeScript ESM under `worker/`, using Node built-ins plus the dependencies
  declared in `worker/package.json`, including `toml`, `zod`, and the bundled
  filesystem MCP server.
- Generates raw Ed25519 key material compatible with PyNaCl and signs the exact
  UTF-8 bytes of the challenge nonce.
- Persists the existing identity format and reconnects after transient Master
  authentication, heartbeat, or job-claim failures.
- Reports runtime and plugin snapshots through periodic authenticated
  heartbeats, and continuously long-polls the claim endpoint for task and
  cancellation jobs.
- Manages local MCP-over-stdio plugin processes, invokes supported plugin tools,
  handles cancellation, and reports task state and results to Master.
- Reports `mode: "capability"` and an explicit `capabilities: []` in the current
  protocol. Plugin tools are reported separately in plugin snapshots; do not
  advertise general execution capabilities that are not implemented.

### Client migration boundary

The future Python Client should remain a thin HTTP CLI. Its core runtime should
prefer the standard library and depend only on the language-independent
protocol. Registration helpers, deployment helpers, and legacy Python shared
modules must be ported deliberately rather than assumed to be available.

## References

- Protocol contract: `protocol/openapi.yaml`
- Protocol governance: `protocol/README.md`
- Protocol history: `protocol/CHANGELOG.md`
- Repository overview: `README.md`
- Master architecture and routes: `master/README.md`
- Worker milestone and usage: `worker/README.md`
- TypeScript protocol types: `worker/src/protocol.ts`
- Worker Master client: `worker/src/master-client.ts`
- Worker lifecycle and job execution: `worker/src/runner.ts`
- Worker plugin runtime: `worker/src/plugins/`
