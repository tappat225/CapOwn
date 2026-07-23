# 快速开始

<!-- SPDX-License-Identifier: Apache-2.0 -->

本页在一台管理机器上启动 Master 和 Dashboard，在另一台或同一台机器上注册 Worker，
最后通过 MCP 调用 Worker 的本地插件。演示使用本地 HTTP；面向公网时应先阅读
[生产部署](deployment.md)并启用 HTTPS。

## 前提条件

| 组件 | 要求 |
| --- | --- |
| Master | Docker Engine 与 Docker Compose V2；或 Go `>=1.23` |
| Dashboard | Docker；或 Node.js `>=22` |
| Worker | Node.js `>=20.18.0` 与 npm |
| MCP Host | 支持 Streamable HTTP 与 Bearer Token 的 MCP 客户端 |

Master 必须能被 Dashboard、Worker 和 MCP Host 访问。Worker 不需要也不应开放入站端口。

## 1. 启动 Master

从仓库根目录执行：

```bash
cd master
docker compose up -d --build
docker compose logs -f master
```

默认端口是 `9230`。只修改主机映射时：

```bash
MASTER_PORT=9320 docker compose up -d --build
```

健康检查：

```bash
curl http://localhost:9230/healthz
curl http://localhost:9230/v1/health
```

Compose 将主机的 `~/.capown/master`（Windows 为
`%USERPROFILE%\.capown\master`）挂载到容器 `/data`。首次运行会创建
`config.toml` 和 SQLite 数据库目录。

## 2. 启动并连接 Dashboard

```bash
docker compose -f dashboard/docker-compose.yml up -d --build
```

浏览器打开 `http://localhost:3000`，输入 Master 根地址，例如
`http://localhost:9230`。请填写**源地址**，不要包含 `/v1` 或 `/mcp`。

首次注册不需要邀请码，创建的第一个用户自动成为管理员。后续用户必须使用管理员创建的
一次性邀请码。登录后在“访问凭据”页面完成下面两项操作：

1. 创建一次性或限次 Worker 注册凭据；
2. 创建 Client Token，供 MCP Host、REST Client 或自动化程序使用。

明文注册链接、注册令牌、邀请码和 Client Token 都只会在创建时完整显示一次。立即安全
保存，不要提交到仓库或写进日志。

## 3. 注册并启动 Worker

在需要提供本地工具的机器上安装 Worker：

```bash
bash scripts/install-worker.sh
capown-worker register https://master.example.com/v1/worker-registrations/<token>
capown-worker start
capown-worker status
```

在 Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-worker.ps1
& "$HOME\.capown\bin\capown-worker.cmd" register `
  https://master.example.com/v1/worker-registrations/<token>
& "$HOME\.capown\bin\capown-worker.cmd" start
& "$HOME\.capown\bin\capown-worker.cmd" status
```

注册链接格式固定为：

```text
<master-origin>/v1/worker-registrations/<cown_register_token>
```

`register` 会生成或复用本机 Ed25519 身份，写入 Worker ID 和名称；注册令牌不会被
保存。启动后，Worker 持续发送心跳并通过长轮询领取任务。默认的 `filesystem` 插件
在第一次启动时被配置到 `~/.capown/worker/workspace`。

> Worker 安装脚本只安装应用和启动器，`capown-worker start` 启动后台进程，但不会创建
> 系统服务或开机自启。长期运行方式见
> [生产部署](deployment.md#worker-process-management)。

## 4. 确认 Worker 和插件

回到 Dashboard 的“Workers”页面，确认节点在线。打开节点详情可以查看主机信息、心跳、
已发现插件及其工具；“插件”页面可以跨 Worker 查看运行状态并启用或禁用插件。

命令行也可验证本机 Worker：

```bash
capown-worker status
capown-worker logs --no-follow
capown-worker config show
```

## 5. 连接 MCP Host

使用 Dashboard 生成的 Client Token：

```text
POST http://localhost:9230/mcp
Authorization: Bearer <client-token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

完成 `initialize` 后，MCP Host 可通过 `tools/list` 发现 `workers_list`、
`worker_get`、`plugin_list`、`plugin_call`、`task_get`、`task_wait` 和
`task_cancel`。详情与示例参见 [MCP 接入](mcp.md)。

## 6. 可选：使用 Python REST Client

创建 `~/.capown/client/config.toml`：

```toml
role = "client"
master_url = "http://localhost:9230"
client_token = "<client-token>"

[client]
soft_timeout = 30
```

再从仓库根目录调用：

```bash
python client/capown_client.py workers-list
python client/capown_client.py plugin-list <worker-name>
python client/capown_client.py plugin-call \
  --worker <worker-name> \
  --plugin-id filesystem \
  --tool-name <tool-name> \
  --arguments '{}'
```

Python Client 是 `/v1` REST 合约的轻量实现，不是另一套协议。它目前包含 Worker、
插件和任务查询，以及插件调用；插件安装、卸载和启停应使用 Dashboard 或直接遵照
OpenAPI 调用。

## 下一步

- 配置真实域名、TLS、CORS 和进程托管：[生产部署](deployment.md)
- 了解 Dashboard 的访问控制和日常管理：[产品使用](product-guide.md)
- 管理插件和理解信任边界：[插件与插件市场](plugins.md)
- 查看任务交付、取消和持久化边界：[系统架构](architecture.md)
