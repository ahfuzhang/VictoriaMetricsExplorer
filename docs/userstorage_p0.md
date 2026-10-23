# Grafana User Storage：P0 接口验证记录

- 日期：2026-10-22
- 对应计划：[plan_v3.md](./plan_v3.md) 第 4.3、4.4、12 节（P0：接口与环境验证）
- 复验脚本：`tests/userstorage/contract.mjs`（契约）与 `tests/e2e/favorites.spec.ts`（端到端）

## 1. 结论

| 结论 | 依据 |
| --- | --- |
| 提交协议固定为 **merge patch + `metadata.resourceVersion`** | 过期版本的 PATCH 返回 409 `Conflict` 且不改任何 Key；无需改用 PUT |
| 同一资源内一次 PATCH 改多个 Key 是一个资源变更 | 一次请求删除 `a`、写入 `b`、`c`，版本只前进一次 |
| `null` 删除 map 成员，未列出的 Key 原样保留 | `other` Key 在所有修改后仍在 |
| 首次创建冲突为 409 `AlreadyExists` | 第二次 POST 同名资源被拒绝，不覆盖 |
| **可写的最低宿主版本：Grafana 12.3.0** | 12.1.10 上 8 个携带同一版本的并发 PATCH 有 2～5 个同时成功（丢失更新）；12.3.1、13.2.4 上始终只有 1 个成功 |
| 资源未创建与路由不存在可区分 | 见第 3 节两种 404 响应体 |
| 服务端不按大小拒绝 | 2 MiB、4 MiB 的值均返回 200；本插件自行执行 1 MiB 资源预算 |
| 写入后立即读取可见新版本 | GET 返回的 `resourceVersion` 等于 PATCH 响应中的值 |
| 用户隔离由服务端执行，不区分 Viewer/Editor/Admin | Viewer 读写他人资源 403，以他人名义创建 422，list 403；可创建自己的资源 |
| Grafana Admin 可读取任意用户的资源 | 与文档一致，不视为缺陷 |

`resourceVersion` 是 16 位十进制字符串（如 `1792659451467995`），插件按不透明字符串原样传回，不转数字。

## 2. 支持矩阵

| Grafana | 路由 | 条件写入 | 并发写入 | 插件行为 |
| --- | --- | --- | --- | --- |
| 13.2.4（docker `latest`） | 有 | 409 Conflict | 8 并发仅 1 成功 | 读写；契约与 12 项端到端全部通过 |
| 12.3.1 | 有 | 409 Conflict | 8 并发仅 1 成功（多次重复） | 读写；契约与 12 项端到端全部通过 |
| 12.1.10 | 有 | 409 Conflict（串行时） | **8 并发 2～5 个成功** | 只读：显示原因，Favorite 按钮禁用，原有浏览正常 |
| 11.6（`userStorageAPI` flag 开/关）、12.2.x | 未验证 | — | — | 只读（低于 12.3.0），不宣称兼容 |

版本判断见 `src/explorer/favorites/limits.ts` 的 `MIN_WRITABLE_GRAFANA_VERSION` 与 `grafanaUserStorageAdapter.ts` 的 `writeBlockedReason()`。若要放开 12.2 或带 flag 的 11.6，先用本文第 5 节的脚本在该版本上跑通并发检查，再调整该常量。

## 3. 响应样例（Grafana 13.2.4，12.3.1 相同）

资源名为 `<pluginId>:<userUid>`，URL 为 `/apis/userstorage.grafana.app/v0alpha1/namespaces/<namespace>/user-storage/<name>`；组织 1 的 namespace 为 `default`。

**资源未创建**（`loadFresh()` 返回 `null`）：

```json
{
  "kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
  "message": "user-storage.userstorage.grafana.app \"vmexplorer-p0test:cg1nbc12oo54wd\" not found",
  "reason": "NotFound",
  "details": { "name": "vmexplorer-p0test:cg1nbc12oo54wd", "group": "userstorage.grafana.app", "kind": "user-storage" },
  "code": 404
}
```

**路由不存在**（视为接口不可用）：

```json
{
  "kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
  "message": "the server could not find the requested resource",
  "reason": "NotFound", "details": {}, "code": 404
}
```

**过期版本**（PATCH，`versionConflict`）：

```json
{
  "kind": "Status", "status": "Failure",
  "message": "Operation cannot be fulfilled on user-storage.userstorage.grafana.app \"…\": the object has been modified; please apply your changes to the latest version and try again",
  "reason": "Conflict",
  "details": { "name": "…", "group": "userstorage.grafana.app", "kind": "user-storage" },
  "code": 409
}
```

**重复创建**（POST，`alreadyExists`）：同上结构，`reason` 为 `AlreadyExists`，`message` 以 `already exists` 结尾。

**PATCH 不存在的资源**（`resourceGone`）：与“资源未创建”相同的 404 `Status`。

**以他人名义创建**：422，`details.causes[0]` 为 `{ "reason": "FieldValueForbidden", "message": "Forbidden: name must match service:user_uid", "field": "metadata.name" }`。

**成功的创建/修改**返回完整对象，`metadata.resourceVersion` 为新版本，`spec.data` 为修改后的全部 Key：

```json
{
  "kind": "UserStorage",
  "apiVersion": "userstorage.grafana.app/v0alpha1",
  "metadata": {
    "name": "vmexplorer-p0test:cg1nbc12oo54wd", "namespace": "default",
    "resourceVersion": "1792659451467995", "generation": 1,
    "labels": { "service": "vmexplorer-p0test", "user": "cg1nbc12oo54wd" },
    "annotations": { "grafana.app/createdBy": "user:cg1nbc12oo54wd" }
  },
  "spec": { "data": { "a": "1", "other": "keep" } }
}
```

这些响应体已写入 `src/explorer/favorites/grafanaUserStorageAdapter.test.ts` 作为分类测试的夹具。

## 4. 未在 P0 覆盖、后续需要的验证

- 子路径部署（`root_url` 带路径）：请求经 `getBackendSrv()` 发送，与 SDK 相同，未在子路径实例上实测。
- 组织切换与匿名访问：匿名时插件不发请求（`isSignedIn` 为 false）；组织切换在 Grafana 中整页重载，未单独实测。
- Grafana 重启后的持久化：开发环境的 Grafana 使用 `grafana-data` 卷，`make run` 每次重建容器后收藏仍在（端到端测试期间多次重建），但未对外部数据库做专门验证。
- 请求体与代理上限：直连 Grafana 时 4 MiB 未被拒绝；经反向代理部署时以代理配置为准，插件的 1 MiB 预算远低于常见限制。

## 5. 复验方法

契约脚本创建并删除一个临时 Viewer，只操作 `vmexplorer-contract-test:*` 资源：

```sh
node tests/userstorage/contract.mjs http://admin:admin@localhost:3000
```

在其他版本上验证，可另起一个不挂数据卷的临时容器，避免与开发用 Grafana 的数据库混用：

```sh
docker run -d --rm --name grafana-check -p 3901:3000 -e GF_SECURITY_ADMIN_PASSWORD=admin grafana/grafana:12.3.1
node tests/userstorage/contract.mjs http://admin:admin@localhost:3901
```

Grafana 11.5～11.x 需开启 feature flag：`-e GF_FEATURE_TOGGLES_ENABLE=userStorageAPI`（插件端仍按第 2 节版本门限保持只读）。

端到端测试使用已安装的 Google Chrome，对运行中的 Grafana（`make run`）执行；测试会写入 `vmexplorer_e2e_*` 合成序列并在结束时删除，以临时 Viewer 身份登录并在结束时删除该用户及其资源：

```sh
make test-e2e                                   # GRAFANA_URL 默认 http://localhost:3000
GRAFANA_URL=http://localhost:3903 make test-e2e # 另一个挂载了 dist/ 与 provisioning/ 的实例
```
