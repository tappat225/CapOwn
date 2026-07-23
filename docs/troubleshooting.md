# 故障排查

<!-- SPDX-License-Identifier: Apache-2.0 -->

先确定故障位于哪一层：Master 健康、Dashboard 浏览器访问、Worker 注册/心跳、插件运行，
还是 MCP/任务调用。不要在诊断输出中粘贴完整 Token、注册链接或身份文件。

## Master 无法访问

```bash
curl -i http://localhost:9230/healthz
curl -i http://localhost:9230/v1/health
cd master && docker compose logs -f master
```

检查端口映射、容器状态、`CAPOWN_MASTER_DIR` 是否指向预期的持久化目录，以及数据库目录
是否可写。反向代理场景还需确认 HTTPS 证书、上游地址和 `CAPOWN_MASTER_PUBLIC_URL`。

## Dashboard 无法登录或请求被浏览器拦截

- 登录页中的 Master 地址必须是 Origin，不能附加 `/v1`。
- 确认 Master 可从浏览器访问 `GET /v1/meta`。
- 跨域部署时，将完整 Dashboard Origin 写入 `allowed_dashboard_origins`，例如
  `https://dashboard.example.com`；协议、主机和端口都必须精确一致。
- 清除过期的浏览器 Session 后重新登录。Dashboard Session 仅保留在当前浏览器会话。
- 管理员才能创建邀请、管理账户和跨所有者运维；普通用户只能操作自己的资源。

## Worker 注册失败

```bash
capown-worker status
capown-worker config show
capown-worker logs --no-follow
```

注册链接必须是
`<origin>/v1/worker-registrations/<cown_register_token>`，且不能含查询串、片段或基本认证。
检查注册令牌是否过期、使用次数是否耗尽、Worker 是否能解析并访问 Master，以及本机时间
是否明显错误。重新注册前必须停止已运行的 Worker。

注册链接或令牌泄露后，立即在 Dashboard 撤销对应的 Worker 注册凭据并创建新的，而不是仅
更改 Worker 名称。

## Worker 离线

Worker 正常运行时会周期性发送心跳并长轮询 claim：

```bash
capown-worker status
capown-worker logs --lines 200
```

检查 `master_url`、DNS、出口防火墙、TLS 信任、Worker 身份文件可读性和 Master 的
`heartbeat_timeout`。Master 重启会清空 Worker Session，Worker 应自动重新认证；如果没有
恢复，先以前台模式运行以观察日志：

```bash
capown-worker stop
capown-worker start --foreground
```

## 插件未出现、报错或无法调用

- 确认 Worker 在线，并等待一次运行时心跳刷新插件快照。
- 在 Dashboard 的 Worker 详情或“插件”页查看插件状态和清洗后的错误文本。
- 检查本机 `plugins.d/` 清单、命令依赖、插件工作目录和 Worker 日志。
- 被禁用的插件不能调用；先在 Dashboard 启用它。离线 Worker 无法接收状态更新。
- `filesystem` 默认仅面向 `~/.capown/worker/workspace`；使用实际插件上报的工具名和参数。
- registry 安装失败时检查包 URL 是否为 HTTPS、SHA-256 是否匹配、Worker 是否能下载，以及
  目录条目不是 `bundled`。

## MCP 返回 401、403 或没有预期工具

- 使用 Client Token，不要使用 Web Session、管理员 Token、Worker Session 或注册令牌。
- 每次请求都必须有 `Authorization: Bearer <client-token>`。
- 使用 `Accept: application/json, text/event-stream` 和 JSON Content-Type。
- `tools/list` 列出的只是 CapOwn 的固定 MCP 工具；实际插件工具先由 `plugin_list` 获取，
  再通过 `plugin_call` 调用。
- `worker_not_found` 或 `forbidden` 通常表示 Token 不拥有目标 Worker；管理员视图不改变
  MCP Client Token 的资源归属。

## 任务长期 pending 或取消无效

任务只有在目标 Worker 在线并领取后才会运行。检查 Worker 的连接和 claim 日志；Dashboard
SSE 与任务投递无关。运行中的取消同样通过 Worker claim 交付，Worker 或插件无法及时处理
取消时，任务会在最终结果上报前保持运行态。

Master 的任务队列和交付租约在当前版本驻留内存，Master 重启不提供长期任务历史或恢复承诺。
把需要长期留存的审计和业务结果存放在调用方系统中。
