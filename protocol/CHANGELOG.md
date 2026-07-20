# Protocol Changelog

<!-- SPDX-License-Identifier: Apache-2.0 -->

## 1.9.0 - 2026-07-19

Added client-token lifecycle and usage auditing:

- `PATCH /v1/tokens/{token_id}` enables or disables an owned client token.
- Client token views include `last_used_ip` and `disabled_at` metadata.
- Client token listing retains revoked entries so Dashboard users can review
  the complete token lifecycle.
- Successful client and admin bearer authentication records the request peer
  IP and UTC last-use timestamp for the authenticated token.

## 1.8.0 - 2026-07-19

Removed the Worker-specific SSE transport:

- Removed `GET /v1/workers/{worker_id}/events` and Worker `wake` events.
- Worker task and cancellation delivery use the long-poll claim endpoint only.
- Worker liveness is maintained by periodic authenticated runtime heartbeats.
- Worker online dispatch checks use fresh runtime heartbeats, and stale workers
  are recovered without depending on an active claim request.
- Dashboard `/v1/events` SSE remains available for UI event delivery.

## 1.7.0 - 2026-07-19

Added the authenticated next-only MCP Streamable HTTP interface:

- New stateless `POST /mcp` endpoint for MCP hosts.
- Client bearer tokens are required for initialization, tool discovery, and
  tool calls; web, admin, Worker session, and registration tokens are rejected.
- Added Worker, plugin, and task tools backed by the current `plugin_call`
  task protocol.
- Added `mcp_enabled: true` to health responses.

## 1.6.0 — 2026-07-19

Added administrator-issued invitations for normal user registration:

- The first administrator still initializes an empty Master without a code.
- Later registrations require a one-time `cown_invite_*` code.
- Invitation plaintext is returned only at creation; Master persistence stores
  only its hash and display prefix.
- Invitations expire after seven days, are consumed atomically with user and
  web-session creation, and can be listed or revoked by administrators.

## 1.5.0 — 2026-07-18

Aligned Dashboard management and plugin lifecycle behavior:

- Worker responses now include owner identity and a required plugin snapshot.
- Plugin snapshots distinguish persistent `enabled` state from runtime status.
- Added owner-authorized remote plugin enable/disable through the Worker task
  claim channel; plugin commands, environment, permissions, and installation
  remain local-only.
- Administrator dashboard SSE subscriptions now receive global Worker events.
- Disabled accounts return the stable `user_disabled` error code and active
  Dashboard/Worker connections are closed.
- Added irreversible administrator account deprovisioning.
- Master discovery now fixes `product` to `capown-master`.
- Password minimum length is six characters throughout the contract.

## 1.4.0 — 2026-07-18

Made claim-based delivery recoverable when a claim response is interrupted:

- Claiming a task now creates a short internal delivery lease while the public
  task remains `pending`.
- A Worker confirms receipt with the existing task-result endpoint by reporting
  `status: running` and the claimed job's opaque `delivery_id` before it starts
  execution. Later results carry the same delivery identifier.
- Unconfirmed task jobs and uncompleted cancel jobs become claimable again when
  their delivery lease expires.
- Repeating the same `running` or terminal result is idempotent.
- Optional SSE `wake` events never cancel an active long-poll request.

## 1.3.0 — 2026-07-18

Current `/v1` contract revision: task delivery is claim-based instead of SSE
push. This project is pre-user; Master and Worker are updated together without
compatibility shims.

- New endpoint `POST /v1/workers/{worker_id}/jobs/claim` — atomic long-poll claim of
  `task` and `cancel` jobs for a Worker session.
- New schemas: `JobType`, `WorkerJob`, `WorkerJobsResponse`, `WorkerWakeData`.
- Worker SSE stream no longer delivers task payloads. It may emit optional
  `wake` events (`reason: jobs_available`) as an accelerator only.
- `POST /v1/tasks` enqueues `pending` work for claim. Status becomes `running`
  when the Worker claims the job, not when the client dispatches or waits.
- Offline dispatch still requires an online Worker (open SSE or active job
  long-poll). Dispatch no longer fails because an SSE push queue was full.
- `POST /v1/tasks/{task_id}/cancel`:
  - pending tasks are canceled immediately and removed from the claim queue;
  - running tasks receive a `cancel` job on the claim path;
  - terminal tasks remain idempotent.
- Removed the synthetic SSE `task_cancel` control message.
- Dropped `503 WorkerUnavailable` from task dispatch/cancel responses for
  delivery failures.

## 1.2.0 — 2026-07-17

Added plugin discovery and task dispatch protocol:

- New schemas: `PluginToolInfo`, `PluginInfo`, `TaskId`, `TaskStatus`,
  `TaskDispatchRequest`, `Task`, `TaskResult`, `PluginCallResult`,
  `ContentBlock`.
- New endpoint `GET /v1/workers/{worker_id}/plugins` — list Worker plugins.
- New endpoint `POST /v1/tasks` — dispatch a task (sync with `?wait=true` or
  async).
- New endpoint `GET /v1/tasks/{task_id}` — query task status and result.
- New endpoint `PUT /v1/tasks/{task_id}/result` — Worker reports task result.
- New endpoint `POST /v1/tasks/{task_id}/cancel` — request task cancellation.
- `WorkerRuntimeUpdateRequest` gains an optional `plugins` field.
- `Worker` response schema gains an optional `plugins` field.
- Worker SSE stream now dispatches `task` events for work items.
- Plugin error codes documented as `x-capown-plugin-error-codes`.
- `plugin-protocol.md` finalized from draft.
- Tags `plugins` and `tasks` added.

## 1.1.0 — 2026-07-17

Renamed Worker enrollment to Worker registration (breaking change):

- `enroll` / `enrollment` -> `register` / `registration`
- Worker enrollment tokens use `cown_register_*` prefix instead of `cown_enroll_*`
- `POST /v1/worker-enrollments` -> `POST /v1/worker-registrations`
- `GET /v1/worker-enrollments` -> `GET /v1/worker-registrations`
- `DELETE /v1/worker-enrollments/{enrollment_id}` -> `DELETE /v1/worker-registrations/{registration_id}`
- `POST /v1/workers` request field `enrollment_token` -> `registration_token`
- Admin endpoints renamed similarly
- `CreatedRegistrationToken` response includes optional `registration_url` when
  `CAPOWN_MASTER_PUBLIC_URL` is configured on the Master

## 1.0.0 — 2026-07-17

Initial `next` control-plane contract:

- health and metadata;
- user registration, login, logout, current-user, and password change;
- client/admin token lifecycle;
- Worker enrollment-token lifecycle;
- Worker enrollment and Worker identity authentication;
- Worker runtime metadata and Worker SSE transport;
- Worker listing, detail, rename, and revoke operations; and
- dashboard SSE events.

Explicitly not included: task dispatch, task results, task status/history,
cancellation, file/shell/container execution, and plugin invocation.
