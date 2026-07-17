# Protocol Changelog

<!-- SPDX-License-Identifier: Apache-2.0 -->

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
