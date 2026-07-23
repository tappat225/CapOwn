# 配置参考

<!-- SPDX-License-Identifier: Apache-2.0 -->

配置中的 Master URL 一律是**源地址**，例如 `https://master.example.com`；客户端和
Worker 自行追加 `/v1` 或 `/mcp`，不要在 `master_url` 中写入路径。

## Master

默认文件是 `~/.capown/master/config.toml`。Docker Compose 中对应
`/data/config.toml`，也可以通过 `CAPOWN_MASTER_CONFIG` 指定。

```toml
role = "master"

[master]
host = "0.0.0.0"
port = 9230
db_path = "./data/master.db"
public_url = "https://master.example.com"
registry_path = ""
heartbeat_timeout = 60
session_ttl = 28800
allowed_dashboard_origins = ["https://dashboard.example.com"]
rate_limit = 10
max_body_bytes = 65536
log_level = "info"
max_challenge_store_size = 1024
max_session_store_size = 4096
max_dashboard_subscribers = 64
password_hash_concurrency = 2
```

| 环境变量 | 覆盖项 |
| --- | --- |
| `CAPOWN_MASTER_CONFIG` | 配置文件路径 |
| `CAPOWN_MASTER_HOST` | `host` |
| `CAPOWN_MASTER_PORT` | `port` |
| `CAPOWN_MASTER_DB_PATH` | `db_path` |
| `CAPOWN_MASTER_PUBLIC_URL` | `public_url` |
| `CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS` | 逗号分隔的 `allowed_dashboard_origins` |
| `CAPOWN_MASTER_REGISTRY_PATH` | `registry_path` |
| `CAPOWN_MASTER_LOG_LEVEL` | `log_level` |

`public_url` 应是 Worker、MCP Host 和浏览器实际使用的公开地址。配置它后，创建
Worker 注册凭据的响应会包含完整注册链接。`allowed_dashboard_origins` 为空时当前实现
不限制浏览器来源；公网部署请始终填精确 Origin。

当 `registry_path` 为空时，Master 依次查找：

1. `~/.capown/master/registry/registry.json`
2. `./registry/registry.json`
3. `../registry/registry.json`
4. Master 可执行文件旁的 `registry/registry.json`

## Worker

默认文件是 `~/.capown/worker/config.toml`：

```toml
role = "worker"
master_url = "https://master.example.com"

[worker]
reconnect_interval = 5
```

解析优先级：`--config` > `CAPOWN_WORKER_CONFIG` > `CAPOWN_CONFIG` > 默认路径。
身份文件默认为 `~/.capown/worker/identity.toml`，可用 `--identity` 或
`CAPOWN_WORKER_IDENTITY` 覆盖。身份文件包含 Ed25519 私钥和 Worker ID，应仅由 Worker
运行账户读取，不能复制到共享位置或版本控制。

旧版的 `execution_mode`、`container_name`、`workspace` 等 `[worker]` 配置键已被忽略。
新版没有内建容器或 Shell 执行模式；实际执行能力由插件决定。

## Python Client

默认文件是 `~/.capown/client/config.toml`：

```toml
role = "client"
master_url = "https://master.example.com"
client_token = "<client-token>"

[client]
soft_timeout = 30
```

可使用 `python client/capown_client.py --config <path> <command>` 选择其他文件。该文件
含有长期 Client Token，应设置为仅当前用户可读并排除于备份、日志和版本控制。

## Dashboard

Dashboard 没有服务器端配置文件。用户在登录页输入 Master Origin，浏览器将它保存在
`localStorage`；当前 `cown_web_*` Session 仅在 `sessionStorage` 中保存。CORS 由 Master
的 `allowed_dashboard_origins` 管理，而不是由 Dashboard 容器处理。

## 持久化路径

| 数据 | 默认位置 |
| --- | --- |
| Master 配置 | `~/.capown/master/config.toml` |
| Master SQLite | `~/.capown/master/data/master.db` |
| Master registry | `~/.capown/master/registry/registry.json` |
| Worker 配置 | `~/.capown/worker/config.toml` |
| Worker 身份 | `~/.capown/worker/identity.toml` |
| Worker 插件清单 | `~/.capown/worker/plugins.d/` |
| Worker 远程安装插件 | `~/.capown/worker/plugins/` |
| Worker 日志 | `~/.capown/worker/worker.log` |
| 默认 filesystem 工作目录 | `~/.capown/worker/workspace` |
