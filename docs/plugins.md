# 插件与插件市场

<!-- SPDX-License-Identifier: Apache-2.0 -->

CapOwn 的执行能力来自 Worker 本地 MCP-over-stdio 插件。Master 路由插件调用和管理任务，
但不会启动、连接或执行插件进程。插件随运行时心跳上报为快照，Dashboard 和 MCP Host 都
据此发现可用工具。

## 默认 filesystem 插件

Worker 第一次启动时会在以下位置创建启用的 `filesystem` 清单：

```text
~/.capown/worker/plugins.d/filesystem.json
```

默认工作目录是：

```text
~/.capown/worker/workspace
```

目录会自动创建。若已经存在有效的同名插件清单，Worker 不会覆盖；首次配置后即使手工删除
该清单，Worker 也不会自动重建。插件报告的工具名是运行时发现的结果，应通过 Dashboard
或 `plugin_list` 查询，而不是在客户端写死。

`filesystem` 是随 Worker 打包的 `bundled` 插件。它不能通过远程市场安装或卸载，但可在
在线 Worker 上通过 Dashboard 启用或禁用。

## 插件清单与本地配置

插件清单位于 `~/.capown/worker/plugins.d/<plugin_id>.json`，核心结构如下：

```json
{
  "schema_version": 1,
  "plugin_id": "example",
  "version": "1.0.0",
  "kind": "mcp",
  "transport": "stdio",
  "enabled": true,
  "command": ["node", "./plugins/example.js"],
  "permissions": {
    "network": "none",
    "read_roots": [],
    "write_roots": []
  }
}
```

命令是 argv 数组，Worker 不经过 shell 拼接。Worker 会清洗上报的插件元数据，不会把清单
环境变量中的秘密上报给 Master。

> `permissions` 是插件声明，不是操作系统级沙箱。当前 Worker 不会自动将文件系统、网络
> 或容器权限限制为这些字段。只部署受信任的插件，并用 Worker 主机账户、文件权限、网络
> 策略或独立沙箱提供真实隔离。

完整字段、生命周期、结果格式与错误码见
[插件协议](https://github.com/tappat225/capown/blob/master/protocol/plugin-protocol.md)。

## 插件中心

Dashboard 的“插件”页按插件 ID 聚合 Worker 快照，展示版本、工具、异常和覆盖范围。
对在线节点可以启用或禁用插件：

- 启用会通过 Worker 任务通道更新本地状态；
- 禁用会停止插件进程，并取消该插件正在执行的调用；
- 离线 Worker 不能立即更新，需要先恢复心跳和 claim 循环；
- 变更完成后以 Worker 下一次上报的插件快照为准。

## 官方 registry 与远程安装

Master 在启动时加载 `registry/registry.json`，并经 `GET /v1/plugins/catalog`
提供只读目录。对于 `source: registry` 的条目，Dashboard 可选择一个在线 Worker 安装或
重装。客户端只提交 `plugin_id` 和可选 `version`，Master 负责：

1. 验证插件与版本存在；
2. 拒绝 `bundled` 来源；
3. 从目录固定 `package_url`、`sha256` 和清单模板；
4. 将 `plugin_install` 任务入队。

Worker 接到任务后下载 HTTPS 包、校验 SHA-256、解压到
`~/.capown/worker/plugins/<plugin_id>/`、渲染 `{{install_dir}}` 和
`{{workspace}}` 模板、写入插件清单并启动插件。安装包 URL、哈希和清单不能由客户端
覆写。

卸载通过 `plugin_uninstall` 任务停止进程、删除清单与安装目录。未知 ID 可用于清理本地
残留，但 `bundled` 插件始终不可远程卸载。

当前仓库提交的默认 registry 只有 `filesystem`，且它是 `bundled`；因此插件市场的远程
安装通路已具备，但默认没有可安装的第三方包。将新包加入目录前，先阅读
[registry 规范](https://github.com/tappat225/capown/blob/master/registry/SPEC.md)。

## 调用与结果

MCP 的 `plugin_call` 或 REST 的 `plugin_call` 任务都遵循同一条路径：客户端 -> Master
任务队列 -> Worker claim -> 本地 stdio 插件 -> Worker 上报结果 -> Master 关联结果。
插件调用可被取消，输出受大小限制并被视为不可信数据。任务模型详见[系统架构](architecture.md)。
