# 产品使用

<!-- SPDX-License-Identifier: Apache-2.0 -->

Dashboard 是 CapOwn 的日常管理入口。它是静态单页应用，浏览器直接调用 Master 的
`/v1` API 并使用经认证的流式 fetch 接收 Dashboard SSE 事件；Dashboard 本身没有
后端、数据库或 Token 代理。

## 登录与账户

首次连接到尚未初始化的 Master 时，Dashboard 显示注册入口，第一位用户会成为管理员。
初始化后，普通用户必须输入管理员创建的一次性邀请码。Web 登录产生 `cown_web_*`
Session，关闭浏览器会话后需要重新登录。

管理员可在“邀请”页面创建、复制和撤销邀请码；在“账户”页面查看、创建、修改、禁用或
永久注销用户。注销账户会连同其 Token、注册链接和 Worker 一并撤销，属于不可逆操作。

## 概览与 Worker

“概览”页汇总在线 Worker、插件状态和近期管理事件。“Workers”页提供：

- 查看当前登录用户拥有的节点；管理员的账户管理权限不会自动扩大此列表的所有权范围；
- 查看 Worker ID、名称、操作系统、运行模式、心跳时间和插件快照；
- 重命名节点；
- 撤销节点。撤销后的节点立即断开，需要新的注册链接才能重新接入；
- 查看每个节点上插件的状态、已发现工具和报错信息。

Worker 的在线状态由运行时心跳决定，不由 Dashboard 页面是否打开决定。Worker 断网、
Master 重启或心跳超时都会使节点离线；恢复连接后 Worker 会重新认证、上报插件快照并继续
领取任务。

## 访问凭据

“访问凭据”页分为两类：

| 凭据 | 用途 | 生命周期 |
| --- | --- | --- |
| Worker 注册凭据 | 让一台新 Worker 加入当前用户 | 可配置过期时间和使用次数；明文只在创建时返回 |
| Client Token | 供 MCP Host、REST API 和 Python Client 鉴权 | 长期有效，直到禁用或撤销；明文只在创建时返回 |

注册链接在 Master 配置 `public_url` 后会以可直接执行的 URL 返回；没有配置时，仍可将
令牌拼到 `<master-origin>/v1/worker-registrations/<token>` 使用。不要把任何明文凭据
放进源代码、Issue、截图或日志。

Client Token 可被临时禁用并重新启用，也可以永久撤销。禁用或撤销后，使用它的 MCP/REST
请求将不再通过认证。

## 插件中心与市场

“插件”页聚合所有可见 Worker 的插件快照，显示版本、工具、运行状态和覆盖范围。对于在线
Worker，可以启用或禁用插件；禁用会停止插件进程，并取消正在执行的调用。

“插件市场”读取 Master 加载的官方 registry。对于 `source: registry` 的条目，Dashboard
可选择在线 Worker 下发安装或重装任务；Master 从目录中固定下载地址、SHA-256 和清单，
Worker 才执行下载和安装。当前仓库自带目录只包含 `filesystem` 这个 `bundled` 插件，
它由 Worker 首次启动时本地配置，不能通过市场远程安装或卸载。

详细流程、限制和安全要求见 [插件与插件市场](plugins.md)。

## 浏览器存储与退出

| 数据 | 保存位置 | 说明 |
| --- | --- | --- |
| Master 根地址 | `localStorage` 的 `capown_master_origin` | 便于下次连接同一 Master |
| 当前 Web Session | `sessionStorage` 的 `capown_web_token` | 当前浏览器会话结束后清除 |
| Client Token、注册链接、插件密钥 | 不持久化 | 只在创建时展示给操作者 |

退出会撤销当前 Web Session 并清除浏览器中的会话数据。Dashboard 的 CORS 配置和静态部署
方式见 [生产部署](deployment.md#dashboard)。
