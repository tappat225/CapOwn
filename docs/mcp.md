# MCP Support

<!-- SPDX-License-Identifier: Apache-2.0 -->

The Master exposes a stateless MCP Streamable HTTP endpoint at `/mcp`. It is
the northbound interface for MCP hosts such as Codex and other agent clients.
It uses the same task and plugin model as the REST API.

## Endpoint and authentication

Send JSON-RPC requests with:

```text
POST https://master.example.com/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <client-token>
```

Only a `client` bearer token is accepted. Web sessions, admin tokens, Worker
sessions, and Worker registration tokens are rejected. Authentication applies
to `initialize`, `ping`, and `tools/list` as well as tool calls.

The endpoint is stateless and does not create an MCP session. `GET /mcp` is not
supported. Requests with an `Origin` header are checked against the configured
Master public URL; non-browser clients normally omit `Origin`.

## Initialization

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {"name": "example-client", "version": "0.1.0"}
  }
}
```

After `initialize`, clients may send the `notifications/initialized`
notification. Notifications are accepted with HTTP `202` and no response
body. The current server returns JSON responses for requests with an ID.

## Tools

| Tool | Purpose |
| --- | --- |
| `workers_list` | List Workers visible to the authenticated client. |
| `worker_get` | Get one Worker by ID or owned name. |
| `plugin_list` | Read a Worker's reported plugin snapshot. |
| `plugin_call` | Invoke a tool exposed by a healthy Worker plugin. |
| `task_get` | Read task status and result. |
| `task_wait` | Wait for a task for a bounded period. |
| `task_cancel` | Request cancellation of a pending or running task. |

Worker arguments accept the exact `worker_id` or the owned `worker_name`.
Concrete plugin and tool metadata comes from the Worker heartbeat. The Master
does not start a plugin process in the MCP handler.

Example plugin call:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "plugin_call",
    "arguments": {
      "worker": "build-host",
      "plugin_id": "filesystem",
      "tool_name": "read_file",
      "arguments": {"path": "/home/user/project/README.md"},
      "timeout_seconds": 60
    }
  }
}
```

`plugin_call` creates a `plugin_call` task through `/v1/tasks`, sends it to
the target Worker through the claim endpoint, and correlates the result. If a
bounded wait expires, the response includes the task ID and current status so
the client can use `task_get` or `task_wait`.

## Diagnostics with curl

```bash
curl -fsS https://master.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <client-token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The response follows the JSON-RPC shape. Tool failures are returned as MCP
errors and preserve CapOwn's machine-readable task and plugin error codes.

## Worker plugins

Plugins are local Worker configuration, not remotely installable code. A
manifest in `~/.capown/worker/plugins.d/` selects an MCP-over-stdio command:

```json
{
  "schema_version": 1,
  "plugin_id": "example",
  "version": "1.0.0",
  "kind": "mcp",
  "transport": "stdio",
  "enabled": true,
  "command": ["node", "./plugins/example.js"],
  "permissions": {
    "network": "none",
    "read_roots": [],
    "write_roots": []
  }
}
```

Commands are argv arrays and are never shell-interpolated. The Worker
sanitizes plugin metadata before reporting it and keeps its own credentials
out of plugin environment inheritance. The permission fields describe the
intended boundary; the plugin process is still trusted local code and the
Worker does not provide a general operating-system sandbox.

See [Plugin Protocol](../protocol/plugin-protocol.md) for the complete
manifest, lifecycle, result, and cancellation rules.

## REST relationship

MCP and REST share client-token authentication, ownership checks, task routing,
Worker claims, and result correlation. The REST contract is canonical in
[`protocol/openapi.yaml`](../protocol/openapi.yaml); MCP does not introduce a
second Worker delivery path.
