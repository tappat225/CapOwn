# 开发与验证

<!-- SPDX-License-Identifier: Apache-2.0 -->

CapOwn 是由独立部署组件组成的单仓库。修改任何可观察行为前，先更新
`protocol/openapi.yaml`；Worker、Dashboard 和 Python Client 都必须据此对齐。当前开发阶段
仅使用 `/v1`，不要新增 `/v2` 或兼容分支。

## 环境与检查

从对应组件目录运行：

```bash
# Master（Go 1.23+）
cd master
go test ./...
go vet ./...
go build ./cmd/capown-master

# Worker（Node.js >=20.18.0）
cd ../worker
npm ci
npm run typecheck
npm test
npm run build

# Dashboard（Node.js >=22）
cd ../dashboard
npm ci
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

从仓库根目录验证协议与版本：

```bash
npx --yes swagger-cli validate protocol/openapi.yaml
node scripts/version.mjs sync-worker
node scripts/version.mjs sync-dashboard
node scripts/version.mjs check
```

## 文档站点

MkDocs 使用 Material 主题，中文文档源位于 `docs/`，导航位于根目录 `mkdocs.yml`：

```bash
python -m pip install -r docs/requirements.txt
mkdocs serve
mkdocs build --strict
```

本地预览默认地址为 `http://127.0.0.1:8000/`。`--strict` 会将断链、无效配置等问题变为
构建失败；提交前应运行它。文档中涉及协议字段、路由和错误码时必须链接或对照 OpenAPI，
不能以 classic 仓库的 Python 实现作为权威来源。

## 版本规则

根目录 `version.json` 是 Master、Worker、Dashboard 和协议版本的唯一提交版本源。Git 标签
表示仓库发布快照，不等同于每个组件的安装版本。详情见
[VERSIONING.md](https://github.com/tappat225/capown/blob/master/VERSIONING.md)。

## 贡献边界

- Master 不执行插件，Worker 不导入 Master 实现，Dashboard 只通过公开协议访问 Master。
- 新任务类型、插件运输、路由、JSON 字段、状态码、认证和 SSE 语义都需要先审查协议变更。
- 重点测试认证、路径构造、序列化、SSE、心跳、claim、取消和重连。
- 不提交构建产物、数据库、真实配置、依赖目录或任何密钥。
