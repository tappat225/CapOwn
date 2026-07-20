# CapOwn Architecture

<!-- SPDX-License-Identifier: Apache-2.0 -->

CapOwn separates global control-plane responsibilities from execution on
remote machines. The Master owns admission, authorization, routing, delivery
leases, cancellation coordination, status, and result correlation. A Worker
owns its local plugin processes and executes plugin tools on its own machine.

## System layout

```text
                         +----------------------+
                         | MCP host / REST client|
                         +----------+-----------+
                                    |
                            /mcp or /v1 over HTTP
                                    |
                         +----------v-----------+
                         | Master (Go)           |
                         | auth, ownership       |
                         | queues, leases        |
                         | task/result state      |
                         +--+---------+----------+
                            |         |
                    SQLite  |         | Dashboard SSE
                            |         |
                         +--v---------v----------+
                         | authenticated Worker  |
                         | heartbeat + job claim |
                         | local MCP stdio       |
                         | plugins               |
                         +-----------------------+
```

Workers do not need inbound ports. They authenticate to the Master, report a
runtime heartbeat, long-poll for jobs, and report results over ordinary HTTP.
The Dashboard event stream is a separate northbound stream and is not a
Worker delivery channel.

## Components

| Component | Responsibility |
| --- | --- |
| Master | Go HTTP API, SQLite persistence, web and bearer authentication, Worker ownership, registration tokens, task queues, delivery leases, cancellation, result correlation, MCP endpoint, and Dashboard SSE. |
| Worker | TypeScript/Node lifecycle, Ed25519 identity, reconnect, runtime heartbeat, claim loop, cancellation handling, local plugin process management, and result reporting. |
| Client | Small Python standard-library HTTP client for REST task and plugin operations. It does not define a second protocol. |
| Protocol | OpenAPI and companion documents shared by all implementations. |
| Plugin | Local MCP-over-stdio process selected by a Worker manifest. The Master never starts or invokes plugin processes. |

## Worker lifecycle

1. `capown-worker register <registration-url>` generates or loads an Ed25519
   identity and registers the public key with `POST /v1/workers`.
2. The Worker requests a nonce from
   `POST /v1/workers/auth/challenges`, signs the exact UTF-8 nonce bytes, and
   creates a session with `POST /v1/workers/auth/sessions`.
3. The Worker sends its runtime and plugin snapshot with
   `PUT /v1/workers/{worker_id}/runtime`. This authenticated heartbeat also
   refreshes the Worker's liveness lease.
4. The Worker continuously calls
   `POST /v1/workers/{worker_id}/jobs/claim` with a bounded long-poll wait.
   This is the authoritative delivery path for task and cancellation jobs.
5. A task claim has an opaque `delivery_id`. The Worker confirms `running`
   before invoking a plugin and reuses that ID when reporting the result to
   `PUT /v1/tasks/{task_id}/result`.
6. When a session or connection fails, the Worker re-authenticates and resumes
   heartbeats and claims. The Master can requeue work whose delivery lease
   expires.

## Task flow

```text
Client -> POST /v1/tasks -> Master queue
                              |
                              | claim + delivery lease
                              v
                         Worker plugin
                              |
                              | PUT task result
                              v
Client <- GET /v1/tasks/{id} <- Master correlation
```

`?wait=true` on task dispatch lets the Master wait for a terminal result for a
bounded request. It does not change the delivery path. Cancellation follows
the same claim path: pending tasks can be canceled immediately; running tasks
receive a cancel job and remain running until the Worker reports a terminal
result.

## Authentication boundaries

- Web sessions (`cown_web_*`) are used by dashboard and web management APIs.
- Client bearer tokens authorize REST task operations and `/mcp`.
- Worker sessions (`cown_sess_*`) authorize runtime, claims, and result
  reporting for the bound Worker.
- Registration tokens (`cown_register_*`) are one-time or bounded-use inputs
  for Worker registration and are not used for normal API access.

The Master checks both token type and resource ownership. A Worker session is
bound to its Worker ID, and a client can address only Workers visible to its
authenticated owner.

## Repository boundaries

```text
master/    Go control plane and HTTP handlers
worker/    TypeScript Worker and local plugin runtime
client/    Python REST client
protocol/  Canonical cross-language contract
scripts/   Installation and version helpers
```

Implementation packages remain independently deployable. The Worker does not
import Master code, and the Master does not execute Worker plugins directly.
