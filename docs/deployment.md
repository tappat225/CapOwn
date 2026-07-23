# 生产部署

<!-- SPDX-License-Identifier: Apache-2.0 -->

CapOwn 的常见拓扑是一台中心 Master、独立静态 Dashboard，以及若干仅出站连接的 Worker。
Master 建议使用 Docker Compose；Worker 部署在实际拥有本地资源的机器上。

## Master

### Docker Compose

```bash
cd master
docker compose up -d --build
docker compose logs -f master
```

Compose 将 `${MASTER_PORT:-9230}` 映射到容器固定的 `9230` 端口，并把
`${CAPOWN_MASTER_DIR:-$HOME/.capown/master}` 挂载到 `/data`。其中：

| 容器路径 | 内容 |
| --- | --- |
| `/data/config.toml` | 持久化 Master 配置 |
| `/data/data/master.db` | SQLite 数据库 |
| `/data/registry/registry.json` | Master 加载的插件目录 |

在中国大陆或受限网络，可替换**构建期**镜像和包源：

```bash
GO_IMAGE=registry.cn-hangzhou.aliyuncs.com/library/golang:1.23-alpine \
ALPINE_IMAGE=registry.cn-hangzhou.aliyuncs.com/library/alpine:3.19 \
ALPINE_MIRROR=mirrors.aliyun.com/alpine \
GOPROXY=https://goproxy.cn,direct \
docker compose up -d --build
```

这些变量不会传给运行中的 Master。常用操作：

```bash
docker compose restart
docker compose stop
docker compose start
docker compose down
```

### 本地安装

安装脚本会构建二进制、创建启动器和数据目录，但不会创建系统服务：

```bash
bash scripts/install-master.sh
~/.capown/bin/capown-master
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-master.ps1
& "$HOME\.capown\bin\capown-master.cmd"
```

两种脚本都支持 `--prefix <directory>`，适合隔离测试环境。

## Dashboard

Dashboard 是静态文件，必须与 Master 独立部署：

```bash
cd dashboard
npm ci
npm run build
```

将 `dashboard/out/` 部署到 Nginx、Caddy、对象存储静态站点，或使用自带容器：

```bash
docker compose -f dashboard/docker-compose.yml up -d --build
```

默认端口是 `3000`，可通过 `CAPOWN_DASHBOARD_PORT` 修改。浏览器直接请求 Master，
所以生产环境必须在 Master 配置精确的 Dashboard Origin：

```toml
[master]
public_url = "https://master.example.com"
allowed_dashboard_origins = ["https://dashboard.example.com"]
```

空数组在当前实现中表示不限制浏览器来源，只应在本机或可信私网使用。若通过环境变量临时
覆盖，使用逗号分隔的 `CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS`。

## 反向代理和 TLS

推荐在 Master 前终止 TLS，对外提供一个稳定 HTTPS Origin。Worker、MCP Host 和 Dashboard
都应使用此地址；同时设置 `CAPOWN_MASTER_PUBLIC_URL`，以便生成可用注册链接并校验 MCP
浏览器 Origin。

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name master.example.com;

    location /v1/events {
        proxy_pass http://127.0.0.1:9230;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 90s;
    }

    location / {
        proxy_pass http://127.0.0.1:9230;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
```

`/v1/events` 是 Dashboard SSE，需关闭代理缓冲。Worker 不使用 SSE：注册、认证、心跳、
claim、结果和取消都走普通的认证 HTTP 请求；不要从 classic 文档复制 Worker SSE 代理规则。

## Worker

```bash
bash scripts/install-worker.sh
capown-worker register https://master.example.com/v1/worker-registrations/<token>
capown-worker start
```

Worker 安装目录和可变状态分离。需要持续运行或开机自启时，请由部署环境的 systemd、
Windows Task Scheduler、supervisor 或容器编排托管 `capown-worker start --foreground`；
CapOwn 安装器不会替你创建该服务。进程的最低权限账户应只拥有预期工作目录和插件目录的
访问权。

### Worker 进程托管 {#worker-process-management}

systemd 单元的核心命令示例：

```ini
[Service]
User=capown
ExecStart=/home/capown/.capown/bin/capown-worker start --foreground
Restart=always
RestartSec=5
```

实际单元还应配置网络就绪依赖、日志策略、工作目录和环境变量。先在同一用户下手工执行
`capown-worker status` 与 `capown-worker start --foreground` 验证配置。

## 验收检查

```bash
curl -fsS https://master.example.com/healthz
curl -fsS https://master.example.com/v1/health
capown-worker status
capown-worker logs --no-follow
```

然后使用 Dashboard 检查 Worker 在线和插件快照，再用 Client Token 执行一次 MCP
`tools/list`。部署完成后继续阅读[配置参考](configuration.md)和
[故障排查](troubleshooting.md)。
