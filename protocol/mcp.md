# CapOwn MCP

<!-- SPDX-License-Identifier: Apache-2.0 -->

The Master exposes a stateless MCP Streamable HTTP endpoint at `/mcp`.
It is a northbound interface for MCP hosts such as Codex. The endpoint uses
the current task protocol and does not expose legacy shell, file, or
container capabilities.

## Transport

Send JSON-RPC requests with:

```text
POST http://localhost:9230/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <client-token>
```

The server returns JSON responses and does not create an MCP session. `GET
/mcp` is not supported. Every request, including `initialize` and
`tools/list`, requires a valid client token. Web sessions, admin tokens,
Worker session tokens, and registration tokens are rejected.

When `public_url` is configured, a supplied `Origin` header must match that
origin. Non-browser MCP clients normally omit `Origin`.

## Initialization

The server supports MCP protocol version `2025-03-26` and advertises the
following capabilities:

```json
{
  "tools": {
    "listChanged": false
  }
}
```

After `initialize`, clients may send the
`notifications/initialized` notification. Notifications receive HTTP 202 with
an empty body.

## Tools

The current tool set is:

| Tool | Purpose |
| --- | --- |
| `workers_list` | List Workers owned by the authenticated client identity. |
| `worker_get` | Get one Worker by ID or name. |
| `plugin_list` | List the plugin snapshot reported by a Worker. |
| `plugin_call` | Invoke a tool exposed by a Worker plugin. |
| `task_get` | Read the status and result of a task. |
| `task_wait` | Wait for a task for a bounded period and return its current state. |
| `task_cancel` | Cancel a pending or running task. |

Worker arguments accept either the exact `worker_id` or the owned
`worker_name`. `plugin_call` dispatches a `plugin_call` task through the
existing `/v1/tasks` contract. It never invokes a plugin process directly from
the MCP HTTP handler.

Example call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "plugin_call",
    "arguments": {
      "worker": "worker-name",
      "plugin_id": "example",
      "tool_name": "echo",
      "arguments": {
        "value": "hello"
      },
      "timeout_seconds": 120
    }
  }
}
```

Successful plugin results are returned as MCP content blocks. If the Worker
has not completed before the bounded wait expires, the result contains the
task ID and current status so the client can use `task_get` or `task_wait`.

## Token configuration

Create a `client` token through the existing Master token API. Keep the token
outside source files and configure the MCP host to send it as a bearer token.
The token must not be a Worker session or registration token.
