# CapOwn Dashboard

CapOwn Dashboard 是一个纯静态 SPA。浏览器直接连接用户指定的 CapOwn
Master，不再运行 Dashboard 服务端代理、SQLite、Cookie Session 或服务端审计。

## 工作方式

```text
浏览器
  ├── GET /v1/meta
  ├── 注册首个用户 / 登录
  ├── Authorization: Bearer cown_web_*
  └── fetch() SSE /v1/events
          |
          v
     CapOwn Master
```

Dashboard 不区分 Master 使用 Python 还是 Go，只要求对外提供相同的 `/v1`
协议。

## 开发运行

要求 Node.js 22+：

```bash
npm ci
npm run dev
```

浏览器访问 `http://localhost:3000`，输入 Master 根地址，例如
`http://localhost:9230`。Dashboard 会先请求 `/v1/meta`，然后根据
`initialized` 状态显示首用户注册或登录。

## 静态构建

```bash
npm run typecheck
npm test
npm run build
```

静态文件输出到 `out/`，可以部署到 Nginx、Caddy、对象存储静态网站或
其他静态文件服务器。SPA 路由需要回退到 `index.html`。

### Docker Compose

```bash
docker compose up --build -d
```

默认映射到宿主机 `3000`，可使用 `CAPOWN_DASHBOARD_PORT` 修改：

```bash
CAPOWN_DASHBOARD_PORT=4433 docker compose up --build -d
```

该容器只负责提供静态文件，不保存 Dashboard 数据，也不需要数据库或
Token 加密密钥。

## Master CORS 配置

由于浏览器直接访问 Master，Master 必须允许 Dashboard 的 Origin。以
CapOwn-next Master 为例：

```bash
CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS=http://localhost:3000
```

多个 Origin 使用逗号分隔。生产环境应填写实际 Dashboard HTTPS Origin，
不要使用宽泛的通配配置。Docker Compose 部署的 CapOwn-next Master 默认
允许 `http://localhost:3000` 和 `http://localhost:5173`。

Python Master 也必须配置等价的 CORS 白名单，并允许
`Authorization`、`Content-Type` 和 `Last-Event-ID` 请求头。

## 浏览器存储

- Master URL：`localStorage` 的 `capown_master_origin`
- 当前 Master Web Session：`sessionStorage` 的 `capown_web_token` 和
  `capown_web_session`

切换 Master 或退出登录时会清理当前 Session。生产部署应使用 HTTPS，避免
凭据和 Bearer Token 在不可信网络中传输。

## 目录

```text
src/
  app/                 静态页面和登录流程
  components/          Dashboard、导航和 Worker UI
  lib/master-client.ts 浏览器 Master 客户端、存储和 SSE 请求
next.config.ts         output: "export"
out/                    构建产物（不提交）
```
