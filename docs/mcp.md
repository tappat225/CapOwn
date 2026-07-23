# MCP 接入

<!-- SPDX-License-Identifier: Apache-2.0 -->

Master 在 `/mcp` 提供无状态的 MCP Streamable HTTP 接口，供 Codex 等 MCP Host 使用。
它与 REST 共用 Client Token、Worker 所有权、任务路由和结果关联，不会建立第二条 Worker
投递通道。

## 连接参数

```text
POST https://master.example.com/mcp
Authorization: Bearer <client-token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

只有 `client` 类型的 Bearer Token 可用。Web Session、管理员 Token、Worker Session 和
Worker 注册令牌都会被拒绝。端点无 MCP Session 状态，`GET /mcp` 不受支持；包括
`initialize`、`ping` 和 `tools/list` 在内的每个请求都必须携带 Token。

当请求带有 `Origin` 时，Master 会按 `public_url` 检查它；非浏览器 MCP Host 通常不发送
`Origin`。公网部署请使用 HTTPS，并设置正确的 `public_url`。

## 初始化

服务器支持 MCP 协议版本 `2025-03-26`：

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

随后可发送 `notifications/initialized`；通知返回 `202` 且无响应体。

## 工具

| 工具 | 用途 |
| --- | --- |
| `workers_list` | 列出当前 Client Token 可见的 Worker |
| `worker_get` | 按 Worker ID 或所属名称查看节点 |
| `plugin_list` | 获取目标 Worker 最近上报的插件快照 |
| `plugin_call` | 调用在线 Worker 的一个本地插件工具 |
| `task_get` | 查询任务状态和结果 |
| `task_wait` | 在受限时长内等待任务状态变化 |
| `task_cancel` | 请求取消待处理或运行中的任务 |

`plugin_call` 的 `worker` 参数可传精确的 `worker_id` 或当前用户所属的
`worker_name`。插件名、工具名和参数应先由 `plugin_list` 获取，不要假定所有 Worker 都有
相同工具。

## 调用示例

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
      "arguments": {"path": "/workspace/README.md"},
      "timeout_seconds": 60
    }
  }
}
```

这个请求只会创建 `plugin_call` 任务。Master 入队后等待 Worker claim；Worker 再启动其
本地插件进程完成调用。MCP Handler 不会直接运行插件。若等待窗口结束仍未完成，响应会带回
任务 ID 和当前状态，后续使用 `task_get` 或 `task_wait` 查询。

## curl 诊断

```bash
curl -fsS https://master.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <client-token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

MCP 错误采用 JSON-RPC 形状，并保留 CapOwn 可机器读取的任务和插件错误码。REST 端点、
完整输入输出和错误码以
[OpenAPI 合约](https://github.com/tappat225/capown/blob/master/protocol/openapi.yaml)为准。
