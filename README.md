# CapOwn

<!-- SPDX-License-Identifier: Apache-2.0 -->

<div align="center">

**把远程设备变成 AI Agent 可发现、可管理、可调用的执行节点**

[文档](https://docs.capown.net/) · [快速开始](https://docs.capown.net/getting-started/) · [部署指南](https://docs.capown.net/deployment/) · [MCP 接入](https://docs.capown.net/mcp/)

</div>

![CapOwn 架构图：Agent 和运维端经 Master 调度仅出站连接的 Worker，实际执行发生在 Worker 本地 MCP 插件中](docs/assets/capown-architecture.png)

CapOwn 是面向 AI Agent 的自托管控制平面。Master 负责用户、凭据、Worker
归属、任务路由和结果关联；Worker 主动连接 Master，并在所在设备上通过本地
MCP 插件执行工具。Worker 不需要公网地址，也不需要开放入站端口。

> CapOwn 不是 AI Agent、VPN 或远程桌面。它为 Codex 等支持 MCP 或 HTTP
> 调用的客户端提供跨设备工具调度能力。当前项目处于 MVP 阶段，协议版本为
> `0.3.0`，部署前请阅读[安全边界](docs/architecture.md#安全边界)。

## 适合什么场景

| 场景 | CapOwn 提供的能力 |
| --- | --- |
| Agent 需要访问另一台机器的本地资源 | 将工具调用路由到目标 Worker 的本地 MCP 插件 |
| 设备位于 NAT 或防火墙后 | Worker 仅发起出站 HTTP/HTTPS 请求，无需开放入站端口 |
| 多位用户共享一个控制平面 | 用户、Token、Worker 和任务按归属隔离，管理员统一管理 |
| 需要可视化运维 | Dashboard 管理 Worker、凭据、插件、邀请和账户 |
| MCP Host 需要远程工具入口 | Master 在 `/mcp` 提供带 Client Token 鉴权的 Streamable HTTP 接口 |

## 当前 MVP

- **Master（Go）**：HTTP API、SQLite 持久化、用户与邀请、Web Session、Client
  Token、Worker 注册与 Ed25519 认证、任务队列、交付租约、取消与结果关联。
- **Worker（TypeScript/Node.js）**：注册、本地身份、心跳、长轮询领取任务、取消、
  MCP-over-stdio 插件生命周期及结果上报。
- **Dashboard（Next.js 静态 SPA）**：概览、Worker 管理、Client Token 与注册链接、
  插件中心和插件市场，以及管理员账户与邀请管理。
- **MCP 与 REST**：MCP 提供 Worker/插件发现、插件调用和任务管理；Python Client
  提供对应的轻量 REST 命令行与库接口。
- **插件体系**：首次启动自动配置受工作目录限制的 `filesystem` 插件；支持目录驱动
  的插件安装、卸载、启用和禁用任务。

CapOwn **没有**内建 Shell、文件或容器任务。实际能力来自 Worker 本地插件。
清单中的权限字段用于描述预期边界，当前 Worker 不提供操作系统级沙箱，因此插件应视为
本机可信代码。

## 五分钟开始

### 1. 启动 Master

```bash
cd master
docker compose up -d --build
```

Master 默认监听 `http://localhost:9230`，配置和 SQLite 数据保存在
`~/.capown/master`。检查服务：

```bash
curl http://localhost:9230/healthz
curl http://localhost:9230/v1/health
```

### 2. 启动 Dashboard

```bash
docker compose -f dashboard/docker-compose.yml up -d --build
```

打开 `http://localhost:3000`，填写 Master 地址 `http://localhost:9230`。首次注册的
用户自动成为管理员。然后在“访问凭据”页面创建 Worker 注册链接。

### 3. 安装并注册 Worker

Worker 需要 Node.js `>=20.18.0`：

```bash
bash scripts/install-worker.sh
capown-worker register http://localhost:9230/v1/worker-registrations/<token>
capown-worker start
capown-worker status
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-worker.ps1
& "$HOME\.capown\bin\capown-worker.cmd" register `
  http://localhost:9230/v1/worker-registrations/<token>
& "$HOME\.capown\bin\capown-worker.cmd" start
```

安装脚本不会创建 systemd 或 Windows 服务。生产环境的进程托管方式见
[部署指南](docs/deployment.md)。

### 4. 连接 MCP Host

在 Dashboard 创建 Client Token，然后配置：

```text
URL: http://localhost:9230/mcp
Authorization: Bearer <client-token>
```

每个请求都需要 `Content-Type: application/json` 和
`Accept: application/json, text/event-stream`。完整工具列表和示例见
[MCP 接入](docs/mcp.md)。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `master/` | Go 控制平面和公开 HTTP/MCP 接口 |
| `worker/` | Node.js Worker 与本地 MCP 插件运行时 |
| `dashboard/` | 独立部署的静态管理界面 |
| `client/` | Python 标准库 REST Client |
| `protocol/` | 规范化协议；`openapi.yaml` 是线协议唯一事实来源 |
| `registry/` | 官方插件目录及格式规范 |
| `docs/` | 中文产品与部署文档 |
| `scripts/` | 本地安装、卸载和版本同步脚本 |

## 文档

- [文档首页](docs/index.md)
- [快速开始](docs/getting-started.md)
- [产品使用](docs/product-guide.md)
- [系统架构](docs/architecture.md)
- [插件与插件市场](docs/plugins.md)
- [MCP 接入](docs/mcp.md)
- [生产部署](docs/deployment.md)
- [配置参考](docs/configuration.md)
- [故障排查](docs/troubleshooting.md)
- [开发与验证](docs/development.md)
- [OpenAPI 合约](protocol/openapi.yaml)

## 开发检查

```bash
(cd master && go test ./... && go vet ./...)
(cd worker && npm run typecheck && npm test && npm run build)
(cd dashboard && npm run format && npm run lint && npm run typecheck && npm test && npm run build)
npx --yes swagger-cli validate protocol/openapi.yaml
node scripts/version.mjs check
mkdocs build --strict
```

版本源、组件版本和发布标签的关系见 [VERSIONING.md](VERSIONING.md)。

## License

本仓库遵循各文件中的 SPDX 标识和根目录许可证约定。
