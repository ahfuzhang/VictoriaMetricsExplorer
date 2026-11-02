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

## Important Metrics

展开 **By Pod** 后，第二栏顶部会出现 **Important Metrics** 链接。选择 Pod 分组再点击该链接，可查看该分组匹配的 YAML 图表；直接点击链接则汇总所有带 Pod 标签的序列。点击普通指标名称可回到单指标浏览。

设置 Grafana 容器的环境变量 `VMX_METRIC_CONFIG_DIR=/etc/vmx/metrics`，并将图表目录只读挂载到该路径。Grafana 12.4+ 还需配置 `GF_PLUGINS_FORWARD_HOST_ENV_VARS=ahfuzhang-victoriametricsexplorer-app`。当前 Docker Compose 已配置转发并挂载仓库的 [config/metrics](config/metrics)，`make run` 会自动启用。目录内每个 `.yaml` / `.yml` 文件对应一个类别，进程启动时一次性严格加载，修改后需重启插件后端或 Grafana。未设置环境变量时不加载图表目录。

仓库包含从 `dotnet runtime 1` dashboard 拆出的 7 个类别、45 张图和 83 条查询，保留统计值、环形图、堆积、双坐标、单位、图例和字段覆盖设置。它们使用 `language: promql`，兼容 Prometheus 和 VictoriaMetrics；原查询中省略的 rate / increase 窗口已显式写为 YAML 中的 `rateWindow`（默认 `1m`）。图表依赖的指标必须全部出现在当前 Pod 范围内，缺少指标的图表不会展示。

查询和展示内容均由 YAML 定义，Go 负责解析、校验及绑定 Pod 范围，前端按配置调用 Grafana 面板渲染器。格式和模板说明见 [图表配置文档](docs/metric_config.md)。导入其他 Grafana v2 dashboard 时可运行（需要 PyYAML）：

```sh
python3 scripts/import_metric_dashboard.py /path/to/dashboard.json /path/to/metric-config-dir
```

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
