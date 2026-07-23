# CapOwn Dashboard

<!-- SPDX-License-Identifier: Apache-2.0 -->

CapOwn Dashboard 是独立部署的 Next.js 静态 SPA。浏览器直接访问 Master 的 `/v1`
API，并通过带 `Authorization` 的流式 fetch 消费 Dashboard SSE。它没有后端、数据库、
请求代理或服务器端 Token 存储。

## 当前页面

- 概览：Worker、插件健康度和管理事件；
- Workers：查看节点、心跳、插件快照，重命名或撤销节点；
- 插件：聚合插件状态并启用/禁用在线 Worker 的插件；
- 插件市场：读取 Master registry，并向在线 Worker 下发安装或重装任务；
- 访问凭据：创建和管理 Worker 注册凭据与 Client/MCP Token；
- 管理员：账户和一次性邀请管理。

完整产品说明见 [`../docs/product-guide.md`](../docs/product-guide.md)，生产部署见
[`../docs/deployment.md`](../docs/deployment.md)。

## 开发

```bash
cd dashboard
npm ci
npm run dev
```

打开 `http://localhost:3000`，输入 Master 根地址，例如
`http://localhost:9230`。Dashboard 需要 Node.js `>=22`。

## 检查与构建

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

静态文件输出到 `out/`。也可使用仓库内置容器：

```bash
docker compose -f dashboard/docker-compose.yml up --build -d
```

默认主机端口是 `3000`，可通过 `CAPOWN_DASHBOARD_PORT` 修改。

## Master CORS

浏览器直接请求 Master，因此需要配置精确 Dashboard Origin：

```toml
[master]
allowed_dashboard_origins = ["https://dashboard.example.com"]
```

本机可使用 `http://localhost:3000`。公网环境不要保留无限制的空列表。

## 浏览器存储

- Master Origin 保存在 `localStorage` 的 `capown_master_origin`；
- 当前 `cown_web_*` Session 只保存在 `sessionStorage`；
- Client Token、注册链接、邀请码和插件秘密不会由 Dashboard 持久化。

版本规则见根目录 [`VERSIONING.md`](../VERSIONING.md)。
