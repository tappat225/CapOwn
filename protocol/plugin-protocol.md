# CapOwn Plugin Protocol

<!-- SPDX-License-Identifier: Apache-2.0 -->

> Status: Adopted in the current `/v1` contract. This document describes the plugin
> extension that is now part of the canonical OpenAPI contract.

## 1. Purpose and boundary

CapOwn-next keeps the Worker core capability-neutral. The Worker core is
responsible for:

- Master registration, authentication, liveness, and reconnect;
- loading local plugin manifests;
- starting, stopping, and monitoring plugin processes;
- speaking the configured plugin transport; and
- forwarding capability discovery and invocation results.

The Worker core MUST NOT implement shell execution, file-system operations,
container management, or other product capabilities directly. Those behaviors
belong to plugins.

This specification defines two related interfaces:

1. the local Worker-to-plugin runtime contract; and
2. the Master/Client contract needed to discover and invoke a plugin tool.

The first implementation profile is MCP over stdio. Other transports are
reserved for a later protocol version.

## 2. Scope of the first profile

The first profile supports:

- local JSON plugin manifests;
- `kind: "mcp"` and `transport: "stdio"`;
- MCP `initialize`, `tools/list`, and `tools/call`;
- Worker-side plugin status and tool discovery;
- plugin invocation through the `plugin_call` task type; and
- normalized text and structured JSON results.

The first profile does not define:

- remote plugin installation or updates;
- arbitrary native plugin protocols;
- plugin-to-plugin calls;
- Master-side execution of plugin processes; or
- a security sandbox implementation.

Plugin manifests are local Worker configuration. The Master MUST NOT be able
to choose an arbitrary executable, executable arguments, or environment for a
plugin.

The canonical schemas for `PluginInfo`, `PluginToolInfo`, `Task`, `TaskResult`,
`PluginCallResult`, and `ContentBlock` are defined in `openapi.yaml`. This
document describes the local Worker-to-plugin runtime contract.

## 3. Plugin manifest

Manifests are UTF-8 JSON files in the Worker plugin directory. The file name
is not the plugin identity; `plugin_id` is authoritative. A Worker MUST reject
unknown top-level fields so configuration mistakes are visible.

### 3.1 Manifest schema

```json
{
  "schema_version": 1,
  "plugin_id": "filesystem",
  "version": "1.0.0",
  "display_name": "Filesystem tools",
  "description": "Example local filesystem plugin",
  "kind": "mcp",
  "transport": "stdio",
  "enabled": true,
  "command": ["node", "./plugins/filesystem/server.js"],
  "env": {
    "PLUGIN_LOG_LEVEL": "warn"
  },
  "permissions": {
    "network": "none",
    "read_roots": ["/workspace"],
    "write_roots": ["/workspace"]
  },
  "limits": {
    "startup_timeout_seconds": 15,
    "call_timeout_seconds": 60,
    "max_argument_bytes": 200000,
    "max_output_bytes": 200000,
    "max_concurrency": 4
  }
}
```

Required fields:

| Field | Type | Rules |
|---|---|---|
| `schema_version` | integer | Must be `1` for this profile. |
| `plugin_id` | string | 1–64 characters; lowercase letters, digits, `_`, and `-`. |
| `version` | string | Semantic version. |
| `kind` | string | Must be `mcp`. |
| `transport` | string | Must be `stdio`. |
| `enabled` | boolean | Disabled plugins remain visible but cannot be invoked. |
| `command` | string array | Non-empty argv; MUST NOT be interpreted through a shell. |

Optional fields default as follows:

```json
{
  "display_name": "",
  "description": "",
  "env": {},
  "permissions": {
    "network": "none",
    "read_roots": [],
    "write_roots": []
  },
  "limits": {
    "startup_timeout_seconds": 15,
    "call_timeout_seconds": 60,
    "max_argument_bytes": 200000,
    "max_output_bytes": 200000,
    "max_concurrency": 4
  }
}
```

`permissions` is a declared policy boundary. Until an OS/container sandbox
is implemented, it MUST NOT be presented to users as proof that the process is
actually confined. A plugin process is otherwise trusted local code.

`env` is local-only configuration. It MUST never be included in Worker
runtime reports, Master responses, logs, or error messages. Worker credentials
and registration tokens MUST NOT be inherited by the plugin process.

## 4. Plugin lifecycle

For each enabled manifest, the Worker performs:

1. validate the manifest;
2. start the process using the exact argv list;
3. initialize the MCP session;
4. call `tools/list` and cache the result;
5. report a sanitized plugin snapshot to the Master; and
6. accept invocations only while the plugin is healthy.

A bad manifest or failed plugin MUST NOT prevent the Worker control-plane
connection from becoming online. The plugin is reported with `status: "error"`
and a sanitized error summary.

The allowed runtime statuses are:

```text
starting | running | stopped | error | disabled
```

The Worker MAY restart an unhealthy plugin, but restart attempts MUST be
bounded. A restart MUST NOT silently change the plugin ID, version, command,
permissions, or discovered tool schema.

The Master may request an owner-authorized `enabled` state change through the
Worker task claim channel. The Worker atomically persists the boolean in the
existing local JSON manifest before applying the lifecycle transition. This
control cannot install a plugin or modify its command, environment variables,
permissions, limits, or other manifest fields.

Enabling starts and initializes the plugin. A failed start keeps
`enabled: true` and reports `status: error`. Disabling rejects new calls,
cancels active calls, stops the process, and reports `status: disabled`.
Repeating the requested state is idempotent.

## 5. Discovered plugin information

The Worker reports only the following sanitized information to the Master:

```json
{
  "plugin_id": "filesystem",
  "version": "1.0.0",
  "kind": "mcp",
  "transport": "stdio",
  "status": "running",
  "tools": [
    {
      "name": "read_file",
      "description": "Read a UTF-8 text file",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {"type": "string"}
        },
        "required": ["path"],
        "additionalProperties": false
      }
    }
  ],
  "error": ""
}
```

`input_schema` is the plugin-provided JSON Schema for the tool. The Worker
MUST validate the top-level invocation shape before forwarding it. Tool-specific
validation remains the plugin's responsibility unless the Worker has a JSON
Schema validator available.

The Worker capability list SHOULD contain `plugin.invoke` when at least one
enabled, healthy plugin tool is available. Individual tool names SHOULD remain
in `plugins[].tools[]`; they SHOULD NOT be encoded into capability strings in
this first profile because plugin and tool names can contain separators and
are not stable authorization identifiers.

## 6. CapOwn invocation envelope

Plugin calls use the `plugin_call` task type dispatched through
`POST /v1/tasks`. The payload follows this shape:

```json
{
  "task_type": "plugin_call",
  "params": {
    "plugin_id": "filesystem",
    "tool_name": "read_file",
    "arguments": {
      "path": "/workspace/README.md"
    }
  }
}
```

The Master resolves the target Worker and verifies ownership before enqueueing
the task. The Master treats `plugin_id`, `tool_name`, and `arguments` as
untrusted input. It MUST NOT accept a command, executable path, or environment
override in this envelope.

The Worker claims jobs via long-poll:

```http
POST /v1/workers/{worker_id}/jobs/claim?limit=1&wait_seconds=25
```

A claimed work job looks like:

```json
{
  "job_type": "task",
  "delivery_id": "job_0123456789abcdef01234567",
  "task_id": "tsk_0123456789abcdef01234567",
  "task_type": "plugin_call",
  "params": { ... },
  "timeout_seconds": 60
}
```

Claiming a `task` job creates a short delivery lease. The task remains
`pending` until the Worker reports `status: running` with the claimed
`delivery_id`; the Worker MUST send that confirmation before invoking the
plugin and reuse that identifier for later results. If confirmation is not received,
the Master makes the task claimable again. Optional SSE `wake` events never
cancel an active claim request.
Optional Worker SSE may emit a `wake` event when jobs are available; Workers
MUST treat claim as the source of truth and MUST NOT rely on SSE for delivery.

The Worker MUST reject:

- an unknown plugin;
- a disabled or unhealthy plugin;
- an unknown tool;
- arguments larger than the configured limit; or
- a timeout outside the allowed range.

The task ID is the invocation correlation ID. It MUST be unique within the
Master's task namespace and MUST be included in the Worker result.

## 7. Result format

The initial result profile is deliberately smaller than the complete MCP
content model:

```json
{
  "task_id": "tsk_0123456789abcdef01234567",
  "worker_id": "wrk_0123456789abcdef01234567",
  "status": "completed",
  "result": {
    "is_error": false,
    "content": [
      {
        "type": "text",
        "text": "hello"
      }
    ],
    "structured_content": null
  },
  "error": null,
  "started_at": "2026-07-17T10:00:00Z",
  "completed_at": "2026-07-17T10:00:01Z",
  "truncated": false
}
```

The first profile supports these content blocks:

```json
{"type": "text", "text": "..."}
{"type": "json", "value": {}}
```

Binary, image, audio, resource-link, and embedded-resource blocks are
reserved until size limits, storage, and client behavior are specified.

`structured_content` MAY contain a JSON object or array when the plugin
returns structured output. The Worker MUST enforce `max_output_bytes` over the
serialized result envelope and set `truncated: true` when it trims output.

## 8. Error codes

The following machine-readable codes are reserved for plugin invocation:

```text
plugin_not_found
plugin_disabled
plugin_unavailable
plugin_tool_not_found
plugin_schema_invalid
plugin_timeout
plugin_canceled
plugin_output_too_large
plugin_protocol_error
plugin_concurrency_exceeded
```

Error responses MUST contain a stable code and a safe human-readable message.
They MUST NOT include bearer tokens, private keys, environment values, full
arguments, command lines, or raw plugin stderr when those values may contain
secrets.

## 9. Cancellation and failure semantics

Cancellation is best-effort and uses the same claim path as work:

- A `pending` task is marked `canceled` immediately and removed from the queue.
- A `running` task receives a claimable cancel job:

```json
{
  "job_type": "cancel",
  "task_id": "tsk_0123456789abcdef01234567"
}
```

The Worker SHOULD abort the matching active invocation and report a terminal
result (typically `canceled` / `plugin_canceled`). The Worker SHOULD use the
MCP cancellation mechanism when supported. If the underlying plugin cannot
safely cancel an in-flight call, the Worker MAY terminate and restart the
plugin session, then return `plugin_canceled`.

The following transitions are valid:

```text
pending → running → completed
pending → running → failed
pending → running → timeout
pending → running → canceled
pending → canceled
```

`pending → running` occurs when the Worker confirms a claimed job through the
task-result endpoint. If delivery is interrupted before that confirmation, the
Master requeues the task after the delivery lease expires. If a confirmed
Worker later becomes stale, the Master may recover its non-terminal work for
redelivery; a Worker MUST NOT claim success without a result.

## 10. Security requirements

- Plugin commands use argv execution and never shell interpolation.
- Master input cannot select or mutate the plugin executable.
- Worker and plugin credentials use separate environments.
- Manifest secrets are local-only and are never reported upstream.
- Plugin output is size-limited and treated as untrusted data.
- Plugin IDs and tool names are display/routing identifiers, not authorization
  credentials.
- Master authorization is based on the caller's token and Worker ownership.
- Any real filesystem, network, or container restriction requires a separately
  specified sandbox implementation; manifest declarations alone are not a
  sandbox.

## 11. Future extension

The plugin and task schemas are part of the current `/v1` contract in
`protocol/openapi.yaml`.
The implementation work follows:

1. Go Master: task routing, plugin/task API handlers, and result correlation;
2. TypeScript Worker: plugin runtime, job claim handling, result reporting;
3. Python REST Client: task and plugin methods;
4. Fake MCP plugin for end-to-end tests.

The first interoperable plugin profile is `mcp-stdio-v1`. A future transport
or content profile must update the current `/v1` contract and all in-tree
implementations together.
