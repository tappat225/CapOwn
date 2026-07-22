# CapOwn Dashboard

CapOwn Dashboard 是一个静态 Next.js SPA。浏览器通过带版本的 `/v1` API
和经过认证的流式 SSE 事件直接连接 CapOwn Master。Dashboard 不提供后端、
数据库、代理或服务端 Token 存储。

## 开发

从主仓库根目录执行：

```bash
cd dashboard
npm ci
npm run dev
```

打开 `http://localhost:3000`，输入 Master 根地址，例如
`http://localhost:9230`。Dashboard 需要 Node.js `>=22`。

## 检查和构建

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

静态文件输出到 `out/`，可以部署到 Nginx、Caddy、对象存储静态网站，或
使用仓库内置的静态 Docker 服务。

## Docker

从主仓库根目录执行：

```bash
docker compose -f dashboard/docker-compose.yml up --build -d
```

默认主机端口是 `3000`，可以通过 `CAPOWN_DASHBOARD_PORT` 修改。容器只提供
静态文件，不保存 Dashboard 数据。

## Master CORS

由于浏览器直接请求 Master，必须在 Master 中配置精确的 Dashboard Origin：

```toml
[master]
allowed_dashboard_origins = ["http://localhost:3000"]
```

生产环境应填写真实的 HTTPS Origin，不要对公网 Master 使用通配配置。

## 浏览器存储

- Master 地址只保存在 `localStorage` 的 `capown_master_origin` 中。
- 当前 `cown_web_*` Session Token 只保存在 `sessionStorage` 中。
- Dashboard 不记录或持久化凭据、Bearer Token、注册 Token 和插件密钥。

版本规则请参阅主仓库的 [`VERSIONING.md`](../VERSIONING.md)。
