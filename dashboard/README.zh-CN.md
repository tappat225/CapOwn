# CapOwn Dashboard

Dashboard 现在是纯静态 SPA。浏览器直接访问用户指定的 CapOwn Master，
Dashboard 本身不再提供 API 代理、SQLite、Cookie Session 或服务端审计。

## 使用流程

1. 打开 Dashboard，输入 Master 根地址。
2. Dashboard 请求 `/v1/meta`。
3. Master 尚未初始化时，创建首个管理员；否则直接登录。
4. 登录后的 `cown_web_*` Token 只保存在当前浏览器标签页的
   `sessionStorage` 中。
5. Worker 列表和状态通过带 `Authorization` Header 的浏览器请求及 SSE
   直接从 Master 获取。

Dashboard 兼容 Python Master 与 Go Master，前提是两者遵守同一套 `/v1`
协议。

## 开发

```bash
npm ci
npm run dev
```

访问 `http://localhost:3000`，然后输入 Master 地址，例如
`http://localhost:9230`。

## 构建与部署

```bash
npm run typecheck
npm test
npm run build
```

构建产物位于 `out/`，可以直接交给 Nginx、Caddy 或对象存储静态网站。
部署时需要将未知路径回退到 `index.html`。

也可以使用 Docker：

```bash
docker compose up --build -d
```

默认端口是 `3000`，可通过 `CAPOWN_DASHBOARD_PORT` 修改。容器只提供
静态文件，不保存 Dashboard 数据。

## Master CORS

浏览器直连要求 Master 允许 Dashboard 的 Origin。CapOwn-next Master 可
使用：

```bash
CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS=http://localhost:3000
```

多个地址用逗号分隔。生产环境应使用 Dashboard 的真实 HTTPS Origin。
Master 还需要允许 `Authorization`、`Content-Type` 和 `Last-Event-ID`。

## 浏览器存储位置

- `localStorage.capown_master_origin`：最近使用的 Master 地址
- `sessionStorage.capown_web_token`：当前 Master Web Session Token
- `sessionStorage.capown_web_session`：当前用户和过期时间

退出登录会清理当前 Session。生产部署应使用 HTTPS。
