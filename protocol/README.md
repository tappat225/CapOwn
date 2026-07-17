# CapOwn Protocol

<!-- SPDX-License-Identifier: Apache-2.0 -->

This directory contains the language-independent wire contract for the CapOwn
control plane. Go Master, TypeScript Worker, Python Client, dashboard code, and
future implementations MUST use this contract as their interoperability
boundary.

## Canonical specification

The current canonical document is:

- [`openapi.yaml`](./openapi.yaml) — OpenAPI 3.1 description of the HTTP and
  Server-Sent Events interfaces implemented by the current `next` milestone.

The implementation source files are not protocol definitions. They are
implementations of this contract and may add internal fields or behavior only
when that behavior is not observable on the wire.

## Scope of v1.1

v1.1 renames Worker enrollment to Worker registration:

- All `enroll` / `enrollment` identifiers are renamed to `register` /
  `registration`.
- Registration tokens now use the `cown_register_*` prefix.
- The Master returns an optional `registration_url` when `CAPOWN_MASTER_PUBLIC_URL`
  is configured, providing a ready-to-use `capown-worker register` link.

v1.1 still covers the connectivity milestone:

- health and metadata;
- first-user registration and web sessions;
- client/admin token management;
- Worker registration-token management;
- Worker registration;
- Worker Ed25519 challenge-response authentication;
- Worker runtime metadata and liveness;
- Worker-to-Master SSE; and
- dashboard SSE events.

Task dispatch, task results, task history, cancellation, file/shell execution,
and plugin invocation are deliberately not part of v1.x. They require a later
protocol extension covering both the Master and Worker sides.

## Versioning policy

1. The URL prefix (`/v1`) is the major protocol version. A breaking wire
   change requires a new prefix such as `/v2`.
2. `info.version` in the OpenAPI document uses SemVer. Patch releases clarify
   wording or correct documentation. Minor releases may add optional response
   fields, new event types, or new endpoints without changing existing
   semantics.
3. Existing required fields, field meanings, authentication rules, status
   codes, error codes, and event semantics MUST NOT be changed in a compatible
   minor release.
4. Every implementation MUST ignore unknown response fields and unknown SSE
   data fields.
5. Current v1 request handlers reject unknown JSON fields. Clients MUST send
   only fields defined for the endpoint; a future additive request field must
   be introduced together with an implementation update or an explicit
   capability negotiation mechanism.
6. Deprecated endpoints and fields remain documented for at least one minor
   release before removal, unless they are security-sensitive.

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
  `https://master.example.com:9210`; clients append the protocol path.
- SSE uses `text/event-stream`. A comment line such as `: ping` is a heartbeat
  and is not an application event.

## Change process

For every protocol change:

1. update `openapi.yaml` first;
2. classify the change as patch, compatible minor, or breaking major;
3. add or update cross-language contract tests;
4. update Go, TypeScript, and Python types/clients;
5. record migration notes in the same change; and
6. verify that old clients can still consume the changed responses when the
   change is declared compatible.

The task protocol should be added as a separate, reviewable extension. It
should not be silently reconstructed from the legacy Python implementation.
