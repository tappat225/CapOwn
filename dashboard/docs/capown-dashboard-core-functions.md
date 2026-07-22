# CapOwn Dashboard Core Functions

## Architecture

CapOwn Dashboard is a static browser SPA. It connects directly to the selected
CapOwn Master through the current `/v1` HTTP and authenticated streaming-fetch
SSE contract. It has no backend, database, proxy, local account system, or
server-side token storage.

The Dashboard accepts only `product: capown-master` and rejects Masters below
the generated `minimum_protocol_version`. The canonical protocol contract is
the repository-level `protocol/openapi.yaml`.

## Browser storage

- The Master origin is stored only in `localStorage`.
- The `cown_web_*` token and current Master user are stored only in
  `sessionStorage`.
- A `401` response or a `403 user_disabled` response clears the session and
  returns the browser to `/login`.
- Credentials, bearer tokens, registration tokens, and plugin configuration
  secrets are never logged.

## Credential generation

- Workers use a short-lived registration token created through
  `POST /v1/worker-registrations`. The Dashboard builds a copyable
  `capown-worker register` command from the connected Master origin and the
  registration token. When the Master has a public URL configured, the
  response may also include a ready-to-share Worker registration link.
- Client and MCP access use the same long-lived client token created through
  `POST /v1/tokens` with `type: client`. The Dashboard shows the connected
  Master URL and a copyable Client configuration after creation.
- The Access page lists the user's client tokens without exposing plaintext,
  including status, creation time, last-use time, and the optional
  `last_used_ip` audit field. Active and disabled tokens can be enabled or
  disabled through `PATCH /v1/tokens/{token_id}`; any token can be permanently
  revoked through `DELETE /v1/tokens/{token_id}`.
- Newly returned plaintext credentials remain only in the current page state.
  They are not written to browser storage and are not shown again after the
  page is refreshed.

## Roles

Runtime roles are exactly `user` and `admin` and are read from the connected
Master after login.

- Users manage resources owned by their Master account.
- Administrators can manage Master accounts and, in the current contract, see
  all Workers. Global Worker entries always include their owner identity.
- Destructive Worker operations display the owner before confirmation.

## Worker and plugin management

The Worker view uses Master responses as the source of truth and refreshes from
authenticated streaming `fetch()` SSE. Normal users receive owner-scoped
events; administrators receive global Worker events. Periodic refresh is a
recovery mechanism, not the primary consistency path.

Workers report a sanitized plugin snapshot containing identity, enabled state,
runtime status, tools, input schemas, and sanitized errors. The Dashboard may
enable or disable a plugin through the Master task channel. It cannot install
plugins or edit commands, environment variables, permissions, or secrets.

## Account lifecycle

Administrators can enable, disable, and permanently deprovision accounts.

After the first administrator initializes the Master, normal users register
through a one-time administrator invitation. Invitation plaintext is displayed
only when created; Dashboard never stores it. Invitations expire after seven
days and can be listed or revoked by administrators.

- Disabling revokes active sessions and disconnects the account's Workers.
- Enabling changes only the account status and does not proactively reconnect
  Workers.
- Deprovisioning is irreversible. It revokes credentials, registration tokens,
  Workers, and live connections while retaining identifiers for referential
  integrity.

## Protocol ownership

All Master access and response validation is implemented in
`src/lib/master-client.ts`. The canonical wire contract lives in the root
`protocol/openapi.yaml`; Dashboard code never imports Master or Worker
implementation modules.
