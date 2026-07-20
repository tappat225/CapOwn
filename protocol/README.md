# CapOwn Protocol

<!-- SPDX-License-Identifier: Apache-2.0 -->

This directory contains the language-independent wire contract for the CapOwn
control plane. Go Master, TypeScript Worker, Python Client, dashboard code, and
future implementations MUST use this contract as their interoperability
boundary.

## Canonical specification

The current canonical document is:

- [`openapi.yaml`](./openapi.yaml) — OpenAPI 3.1 description of the HTTP and
  Server-Sent Events interfaces implemented by the current milestone.

The MCP transport and tool contract is documented in [`mcp.md`](./mcp.md).

The implementation source files are not protocol definitions. They are
implementations of this contract and may add internal fields or behavior only
when that behavior is not observable on the wire.

The plugin extension is documented in
[`plugin-protocol.md`](./plugin-protocol.md) and is included in
the current `openapi.yaml` contract.

## Scope of v1

The current `/v1` contract covers:

- health and metadata;
- first-user registration and web sessions;
- administrator-issued invitation registration for normal users;
- client/admin token management;
- Worker registration-token management;
- Worker registration;
- Worker Ed25519 challenge-response authentication;
- Worker runtime metadata and liveness;
- Worker runtime heartbeats and dashboard SSE events;
- Worker job claiming with `POST /v1/workers/{worker_id}/jobs/claim`;
- plugin discovery, task dispatch, task results, and task cancellation;
- `plugin_call` execution through MCP-over-stdio plugins; and
- persistent plugin enable/disable control through the Worker task channel.

The Master also exposes a stateless MCP Streamable HTTP endpoint at
`/mcp`. It accepts client bearer tokens and exposes only the current tool
surface; it does not provide the legacy shell, file, or container tools.

Workers claim jobs with `POST /v1/workers/{worker_id}/jobs/claim`:

- claimed task jobs remain `pending` until the Worker reports `running` with
  the current `delivery_id` before execution;
- interrupted, unconfirmed deliveries are made claimable again after a short
  internal lease; and
- Cancel requests for running tasks are claimed as `cancel` jobs.
- Worker liveness is reported separately through the runtime heartbeat.

## Versioning policy

1. `/v1` is the only HTTP protocol prefix during this pre-user development
   stage. It is a route namespace, not a promise that the SemVer major version
   is stable. Breaking changes update the current contract in place; do not add
   `/v2`, compatibility shims, or parallel protocol implementations.
2. `info.version` uses SemVer for the protocol contract. The current `0.1.0`
   version is the first pre-user baseline. Before `1.0.0`, protocol changes
   may be breaking; use patch releases for documentation or compatible fixes
   and minor releases for contract changes.
3. Product and protocol versions are related but independent. A product
   release MAY keep the same protocol version when its wire contract is
   unchanged, and a protocol revision MAY advance independently when the
   product release includes the change.
4. The detailed versions `1.0.0` through `1.9.0` were internal exploratory
   revisions and are not public compatibility targets; their history remains
   available in Git.
5. Every implementation MUST ignore unknown response fields and unknown SSE
   data fields.
6. Current v1 request handlers reject unknown JSON fields. Clients MUST send
   only fields defined for the current endpoint.

## Wire conventions

- JSON is UTF-8 and uses `snake_case` field names.
- HTTP JSON bodies use `Content-Type: application/json`.
- Timestamps are UTC RFC 3339 strings. Implementations should emit `Z` for UTC.
- IDs and opaque tokens are case-sensitive strings.
- `token_prefix` is a short display prefix returned by the current Master; it
  is not the full token-class prefix and MUST NOT be used for authentication.
- Empty collections are encoded as `[]`, not `null`.
- A field documented as nullable may be encoded as `null`; omission is allowed
  only when the schema marks the field as optional.
- Authentication uses `Authorization: Bearer <token>` unless an endpoint says
  otherwise.
- The configured Master URL is an origin only, for example
  `https://master.example.com:9230`; clients append the protocol path.
- Dashboard SSE uses `text/event-stream`. A comment line such as `: ping` is a
  heartbeat and is not an application event.

## Change process

For every protocol change:

1. update `openapi.yaml` first;
2. classify the change as patch or contract revision;
3. add or update cross-language contract tests;
4. update Go, TypeScript, and Python types/clients;
5. record migration notes in the same change; and
6. verify the Master and Worker against the complete current contract.

The current task protocol is a separate, reviewable extension. It must not be
silently reconstructed from the legacy Python implementation.
