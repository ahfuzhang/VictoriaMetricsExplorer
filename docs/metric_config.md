# Important Metrics YAML 配置

配置目录由 `VMX_METRIC_CONFIG_DIR` 指定，必须是插件进程可读的绝对目录。只加载第一层 `.yaml` / `.yml` 文件，允许文件符号链接以兼容 ConfigMap。未设置变量时禁用加载；显式指定的目录无法读取或任何文件校验失败时，插件启动失败。目录为空时加载空配置。修改配置后重启进程生效。

Grafana 12.4 起默认过滤插件子进程的环境变量，还需设置 `GF_PLUGINS_FORWARD_HOST_ENV_VARS=ahfuzhang-victoriametricsexplorer-app`（或 `[plugins] forward_host_env_vars` 中包含此插件 ID），让目录变量传入插件进程。当前 Compose 已配置。参见 [Grafana 官方说明](https://grafana.com/whats-new/2026-02-24-plugin-processes-no-longer-receive-all-host-environment-variables-by-default/)。

每个文件包含一个 YAML 文档、一个类别与多张图。类别 ID 在整个目录唯一，图表 ID 在类别内唯一。ID 使用小写字母开头，其后允许小写字母、数字、连字符；排序由 `order`（默认 100）和 ID 决定。

```yaml
apiVersion: 1
category:
  id: example
  title: Example
  order: 10
charts:
  - id: cpu
    title: CPU 使用率
    description: 汇总当前 Pod 范围内 CPU 使用量，单核为 100%，可超过 100%。
    language: promql
    match:
      modes: [byPod]
      metricNames: [process_cpu_seconds_total]
    rateWindow: 1m
    queries:
      - refId: A
        expr: |
          100 * sum(rate({{selector:process_cpu_seconds_total}}[{{rateWindow}}]))
        legend: CPU
    visualization:
      type: timeseries
      width: 24
      height: 300
      options:
        legend: {showLegend: true, displayMode: list, placement: bottom}
        tooltip: {mode: multi, sort: desc}
      fieldConfig:
        defaults:
          unit: percent
          min: 0
          decimals: 2
          custom:
            drawStyle: line
            lineWidth: 1
            fillOpacity: 0
            stacking: {mode: none, group: A}
        overrides: []
    summary:
      queryRef: A
      reducer: lastNotNull
```

`title`、`description`、非空 `match.metricNames`、非空 `queries` 和 `visualization` 为必填。`enabled` 默认 `true`；`language` 默认 `promql`，可设为 `metricsql`，后者只匹配 VictoriaMetrics 数据源。`match.modes` 当前只接受 `[byPod]`。同一图表依赖的指标必须全部存在；一个指标可以出现在多张图中。

查询字段：

| 字段 | 说明 |
| --- | --- |
| `refId` | 图表内唯一，以大写字母开头的字母数字标识 |
| `expr` | 表达式模板；所有指标选择器必须使用下述模板 |
| `legend` | 可选，支持 `generation-{{generation}}/min` 等结果标签插值 |
| `instant` | 默认 false；true 时通过 `/api/v1/query` 在所选时间范围终点求值 |
| `hidden` | 默认 false；true 时保留定义但不执行和展示此查询 |
| `axis` | 使用简写坐标轴格式时的 `left` / `right`，默认 left |

模板由后端通过 MetricsQL AST 解析、校验和绑定，支持：

- `{{selector:metric_name}}`：完整选择器，包含指标名、当前 Pod 分组和现有标签筛选，交集生效。没有选中分组时仍要求 Pod 标签非空。
- `{{rateWindow}}`：图表的 `rateWindow`，默认 `1m`，接受正整数加 `s` / `m` / `h`。
- `{{label:pod}}`、`{{label:namespace}}`、`{{label:cluster}}`、`{{label:node}}`：当前组织的标签映射，适用于聚合分组列表。

原 dashboard 的 `${ds}` 使用顶部选择的数据源；`$pod` 使用当前 Pod 范围；`customer_brand`、`customer_env`、`customer_cluster`、`namespace`、`job` 等变量约束随原变量移除，不沿用导出文件中的旧选值。现有标签筛选会传入图表查询；可先在普通指标上筛选，再点击 Important Metrics，也可在图表页清除筛选。

`image!~...`、`resource="cpu"` 等固定过滤条件写入可选的 `selectors`，表达式引用别名：

```yaml
selectors:
  cpuLimit:
    metricName: kube_pod_container_resource_limits
    matchers:
      - label: resource
        op: '='
        value: cpu
queries:
  - refId: A
    expr: sum({{selector:cpuLimit}})
```

上例是图表字段片段。`match.metricNames` 应包含实际指标名 `kube_pod_container_resource_limits`。匹配器操作符接受 `=`、`!=`、`=~`、`!~`；值由后端转义。所有指标引用必须恰好被 `match.metricNames` 覆盖。配置中不允许裸指标、未知模板变量或 Grafana dashboard 变量。

`visualization` 使用通用面板设置：

| 字段 | 说明 |
| --- | --- |
| `type` | `timeseries`、`stat` 或 `piechart`，对应 Grafana 面板插件 |
| `width` | 1–24 栅格宽度，省略或 0 表示整行；窄屏自动排为单列 |
| `height` | 面板高度，单位 px，最大 2000；省略或 0 使用 300 |
| `options` | Grafana 原生面板 options，例如图例、tooltip、stat reducer、pieType |
| `fieldConfig` | Grafana 原生 defaults / overrides，包含单位、坐标轴、颜色、阈值、堆积及曲线设置 |

原生 `fieldConfig` 和 `options` 由 Grafana 面板插件解释，因而新图表的具体设置直接放在 YAML 中。普通曲线通过 `custom.stacking.mode: none` 配置，堆积通过 `normal` 配置；双坐标通过 `byFrameRefID` / `byName` 字段覆盖中的 `custom.axisPlacement: right` 及对应 `unit` 配置。`percent` 接收 0–100 的数值，`percentunit` 接收 0–1 的比值，不能重复乘以 100。

同时支持计划文件的简写格式：`type: line / stacked / dual_axis` 加 `axes.left / axes.right`；每个轴包含 `unitId`、`label`、`min`、`max`、`decimals`。每条查询通过 `axis` 引用，前端转换为 Grafana 字段覆盖。堆积面积的填充可在 `fieldConfig.defaults.custom.fillOpacity` 中设置。优先使用原生格式完整保存 dashboard 设置。

可选 `summary` 只接受已有 `queryRef` 与 `reducer: lastNotNull`，显示该查询最近的有限采样值。如果返回多条序列，提示配置口径不符。stat 和 piechart 使用 `options.reduceOptions`，瞬时查询保留原 dashboard 的 `instant` 语义。

图表规划接口为 `POST .../explorer/v1/ds/{uid}/configured-charts`，请求和响应沿用压缩 protobuf。接口经过当前组织和数据源白名单检查，匹配结果不包含数据源凭据。图表滚动进入可见区域时加载，并共享数据源的前端并发上限；切换范围、刷新或离开页面时取消旧请求。查询失败和空数据各自显示，不转换为零值。

仓库的 7 个 `dotnet-*.yaml` 文件来自 `dotnet runtime 1-1791858064252.json` 的 7 个 Row，包含全部 45 个 Panel 和 83 条查询。面板标题、聚合、图例、字段覆盖和面板 options 均已迁移。这些查询已设为 `language: promql`，兼容 Prometheus 与 VictoriaMetrics。原 MetricsQL 中 41 处省略的 rate / increase 窗口已显式写成 `[{{rateWindow}}]`，相关图表在 YAML 中设置 `rateWindow: 1m`，使 `/min` 曲线的窗口明确；如果采集间隔较长，可调整该字段。原查询已有的显式窗口保持原值。

导入脚本默认输出 PromQL，并对直接包裹指标选择器的 `rate` / `increase` / `irate` 补上显式窗口。`--rate-window 5m` 可选择其他窗口；真正使用 MetricsQL 扩展的 dashboard 可用 `--language metricsql` 保留原表达式，并只在 VictoriaMetrics 数据源上匹配。不要仅因 Grafana datasource query group 为 `prometheus` 或使用 MetricsQL 解析器就将所有图表标记为 MetricsQL 专用。
