# VictoriaMetrics Explorer

在 Grafana 中浏览 Prometheus 和 VictoriaMetrics 指标，无需手写 PromQL。支持指标列表、标签筛选、Pod/Node 分组、图表和收藏查询。

## 数据源配置

在 Grafana 的 **Connections → Data sources** 中添加任意一种数据源：

| 数据源 | Grafana 类型 | 查询语言 |
| --- | --- | --- |
| Prometheus | `prometheus`（Grafana 内置） | PromQL |
| VictoriaMetrics | `victoriametrics-metrics-datasource`（需安装官方数据源插件） | PromQL / MetricsQL |

两种数据源可以同时存在，并在 Explorer 顶部的数据源选择器中切换。URL、认证、TLS 和 VictoriaMetrics 集群租户路径均配置在 Grafana 数据源中；Explorer 通过 Grafana 代理访问，无需重复配置。

Explorer 使用服务账号访问数据源。可启用 Grafana 的 `externalServiceAccounts` 和 `[auth] managed_service_accounts_enabled`（仅组织 1），或在应用的 **Configuration** 页面保存当前组织的服务账号 token。

应用配置的 `jsonData.datasourceUids` 可限制允许访问的数据源 UID；未配置时允许组织中上述两种类型的数据源。服务账号权限决定后端可访问的范围，前端选择器还会过滤当前用户不可见的数据源。配置示例见 [provisioning/plugins/app.yaml](provisioning/plugins/app.yaml)。

自动生成的查询根据数据源类型选择兼容语法。收藏中的手写表达式保留原文；包含 MetricsQL 专有语法的收藏切换到 Prometheus 后，需要改写为 PromQL。现有 histogram 视图面向经典 `_bucket`/`_count`/`_sum` 指标，尚不支持 Prometheus native histogram。

## 本地开发

安装项目要求的 Go 和 Node.js 版本，并安装前端依赖后，运行 `make run`。Docker Compose 会启动 Grafana、VictoriaMetrics 和 Prometheus，并自动配置两个数据源。Prometheus 会采集自身指标，可直接用于浏览验证。

验证命令：

```sh
go test -race ./...
npm run typecheck
npm test -- --runInBand
npm run build
```

可选：使用 Prometheus 发行包中的 `promtool` 验证生成的 PromQL 在真实查询引擎中的结果：

```sh
PROMTOOL_PATH=/path/to/promtool go test -tags=integration ./pkg/resource -run TestPrometheusZeroCounterQuery
```
