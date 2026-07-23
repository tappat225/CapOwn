# CapOwn 文档

<!-- SPDX-License-Identifier: Apache-2.0 -->

CapOwn 是面向 AI Agent 的自托管远程执行控制平面。它把用户和 Agent 的工具调用
发送到指定 Worker，再由 Worker 的本地 MCP 插件接触文件、数据库、内网服务或硬件。
Worker 只需主动访问 Master，不必暴露入站端口。

![CapOwn 架构图](assets/capown-architecture.png)

## 从这里开始

| 目标 | 文档 |
| --- | --- |
| 在本机跑通 Master、Dashboard、Worker 和 MCP | [快速开始](getting-started.md) |
| 了解 Dashboard、凭据和日常操作 | [产品使用](product-guide.md) |
| 理解组件边界、任务流和安全模型 | [系统架构](architecture.md) |
| 管理本地插件和插件市场 | [插件与插件市场](plugins.md) |
| 让 Codex 等 MCP Host 接入 | [MCP 接入](mcp.md) |
| 部署到服务器并配置 TLS 反代 | [生产部署](deployment.md) |
| 查询所有配置项和持久化路径 | [配置参考](configuration.md) |
| 处理连接、认证、插件和任务问题 | [故障排查](troubleshooting.md) |

## 当前能力边界

CapOwn MVP 已实现用户与管理员、邀请注册、Client Token、Worker 注册、Ed25519
身份认证、心跳与离线判定、claim-based 任务交付、取消、结果关联、Dashboard SSE、
MCP-over-HTTP，以及 Worker 本地 MCP-over-stdio 插件的发现和管理。

当前没有通用 Shell、文件或容器执行任务。仓库附带的 `filesystem` MCP 插件提供受
工作目录约束的文件工具；其他能力必须由插件明确提供。Master 只做控制和路由，绝不
直接启动 Worker 插件。

## 权威来源

公开 HTTP 线协议以
[OpenAPI 合约](https://github.com/tappat225/capown/blob/master/protocol/openapi.yaml)
为唯一事实来源。产品版本、协议版本和发布标签相互独立；当前提交中的版本可查看根目录
`version.json`。
