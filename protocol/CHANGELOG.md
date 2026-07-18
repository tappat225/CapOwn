# Protocol Changelog

<!-- SPDX-License-Identifier: Apache-2.0 -->

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
