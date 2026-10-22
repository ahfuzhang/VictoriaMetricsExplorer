# 用户个性化收藏与菜单存储实施计划 v3

- 更新日期：2026-10-22
- 前一版：[plan_v2.md](./plan_v2.md)；初稿：[plan_storage.md](./plan_storage.md)
- 适用项目：VictoriaMetrics Explorer Grafana App Plugin
- 状态：设计与实施计划。标注“已从源码确认”的事项来自 Grafana v12.4.13 源码阅读，仍需在第一阶段用运行实例复验；本文没有把待验证的接口能力视为已经实现。

## 0. 相对 v2 的变更

| 变更 | 内容 |
| --- | --- |
| 版本管理 | Protobuf 不再保存任何版本号或操作回执：删除 `MutationReceipt`、`Tree.revision`、`tree_uid`、`content_revision`、内容 `revision` 与 `operation_id`。并发控制只依赖 Grafana 资源的 `metadata.resourceVersion` |
| 变更检测 | 判断某个收藏入口是否被其他窗口修改，改为比较基础快照与最新快照中该内容 Key 的原始字符串 |
| 多窗口冲突 | 新增第 7.4 节：条件写入 + 在最新数据上重放操作 + 判定操作是否已生效，解决多窗口同时写入导致的 ID 重复、覆盖与重复追加 |
| 响应丢失 | 回执流程改为“重新读取后按 7.4 的规则核对”，见 7.5 |
| 术语 | `NODE_KIND_NODE` 改为 `NODE_KIND_FAVORITE`，`SavedNodeContent` 改为 `FavoriteContent`，正文统一称“收藏入口”；字段编号重新连续排列 |
| 多条查询语句 | 从 `SavedQuery` 中拆出 `QueryStatement`：一次 Favorite 保存一条查询，其中可包含 1～10 条查询语句，每条语句有自己的表达式、数据源、单位与图形类型；第四栏按顺序为每条语句显示一个图形区 |
| 查询语句的生成来源 | `QueryStatement` 新增 `source_scope`（By Name / By Pod / By Node）、`source_scope_value`（指标名前缀、pod 前缀或 node 名称）与 `source_filters`（过滤标签）；只用于展示，不参与回放 |
| 矛盾修正 | 普通模式第一栏不再保留旧收藏入口；明确无数据源时收藏界面的挂载位置；空收藏入口也写内容 Key |
| 补充细节 | 收藏模式下数据源选择器的行为、保存界面只编辑一条查询、新增收藏入口编辑界面、`auto` Step 规则、两种 404 的区分、资源名构造、遗漏的文件、旧数据导入去重 |
| 已从源码确认 | 权限不区分 Viewer/Editor/Admin；资源名格式；服务端只统计大小、不拒绝 |

## 1. 目标与关键决策

实现 **Grafana 服务器端的用户个性化存储**：每个用户可以管理自己的目录树，在收藏入口中保存多个完整查询；这些数据持久化到 Grafana 服务器使用的数据库，在其他浏览器登录同一 Grafana 实例后从服务器重新读取。

保留初稿的核心要求：React 前端调用 Grafana User Storage API；菜单与收藏内容分开保存；用 Protobuf 定义业务数据；采用 `Protobuf → gzip → Base64` 编码；支持目录、收藏入口及其拖动管理。前端负责界面、编码和发送请求，Grafana 服务端负责认证、授权与数据库持久化。用户存储不经过本 App 的 Go 后端；执行收藏中的查询仍复用现有 Go 查询接口。

### 1.1 存储位置与职责

```text
React 页面内存中的编辑状态
  → Protobuf → gzip → Base64
  → HTTP 请求：Grafana User Storage API（携带资源版本前提）
  → Grafana 服务端 → Grafana 使用的持久化数据库

再次打开 App
  → 从 Grafana User Storage API 读取服务器数据
  → Base64 解码 → gzip 解压 → Protobuf 解码
  → 在 React 页面中显示
```

**Grafana 服务端数据是唯一持久化来源。** 菜单、文件夹、收藏入口、PromQL、名称、单位、数据源绑定和自增 ID 计数器全部随对应业务消息存储在服务器端。资源版本由 Grafana 维护，不写入业务消息。部署必须为 Grafana 数据库配置持久化，Grafana 进程或容器重启后仍可读取。

浏览器仅保留当前页面生命周期内的内存状态，用于展示、编辑和减少重复解码；这不构成保存。该功能不得把数据写入 localStorage、sessionStorage、IndexedDB、Cache Storage 或其他浏览器持久化介质，也不得在服务器不可用时回退到这些介质。编辑草稿未提交前只在内存中，刷新或关闭页面可能丢失，界面必须明确其未保存状态。

“保存成功”仅指 Grafana 服务端已确认提交；客户端编码完成、更新 React 状态、写入内存缓存都不能触发成功提示。清空浏览器数据、切换设备不影响已经保存的收藏。

### 1.2 关键决策

| 事项 | 决策 | 原因 |
| --- | --- | --- |
| 持久化位置 | 仅存储到 Grafana 服务器使用的数据库 | 用户数据应随 Grafana 用户身份恢复，不依赖原浏览器 |
| 收藏对象 | 一次 Favorite 保存一条查询：可读名称 + 1～10 条查询语句；每条语句保存表达式、数据源、单位及必要显示配置 | 只有指标名不足以还原用户的查询；一个图表可能由多条查询语句组成 |
| 树节点 | 文件夹与收藏入口使用显式类型；只有文件夹可包含子节点 | 避免把查询集合误当成目录 |
| ID | 树内自增 ID 只在最新数据上分配，条件提交成功才算分配完成 | 多个窗口不能各自读旧值后写回 |
| 并发控制 | 只用 Grafana `metadata.resourceVersion` 做条件写入；Protobuf 不存版本或回执 | 服务端版本已能拒绝过期写入，业务层再存一份只会增加同步负担 |
| 冲突处理 | 收到 409 后重新读取，在最新数据上重放同一操作；能判定已生效则直接完成 | 多窗口同时修改时既不覆盖也不重复 |
| 写入边界 | 同一个 User Storage 资源内，一次条件请求提交菜单和所有相关内容 Key | 两次 `setItem()` 不能构成事务 |
| 前端 SDK | 不使用 `usePluginUserStorage().setItem()` | 已安装 SDK 存在静默本地回退、缓存和缺少条件写入的问题 |
| 接入方案 | 封装前端 REST adapter，调用 Grafana 服务端 User Storage API；先验证资源版本冲突语义 | 前端直接发起请求，数据由 Grafana 服务端持久化 |
| 多查询展示 | 首版在第二栏列出收藏入口内的查询，第四栏按顺序显示所选查询的全部查询语句；不自动执行整个入口 | 支持多查询保存，同时控制请求量和四栏改造范围 |
| 运行上下文 | 每条查询语句绑定保存时的数据源；时间范围与 Step 使用当前工具栏 | 避免换数据源后执行到错误环境，避免保存过期时间窗口 |
| 旧收藏 | 可选的一次性导入来源；用户选择后读取旧列表并提交到服务器，不再写入或维护旧列表 | 兼容已有历史数据，不延续浏览器存储方案 |
| 不支持环境 | 原有指标浏览可继续使用，个性化保存明确失败或不可用 | 不提供任何浏览器持久化回退 |

目录管理、多个查询、单位配置、再次打开收藏与多窗口并发处理均属于首版闭环。

### 1.3 术语

| 术语 | 含义 |
| --- | --- |
| 树节点 | 菜单中的任意条目（`TreeNode`），即文件夹或收藏入口 |
| 文件夹 | `kind = NODE_KIND_FOLDER`，只能包含子树节点，没有内容 Key |
| 收藏入口 | `kind = NODE_KIND_FAVORITE`，没有子节点，对应一个内容 Key，内含 0～20 条查询 |
| 查询 | `SavedQuery`，一次 Favorite 保存的结果：可读名称 + 1～10 条查询语句 |
| 查询语句 | `QueryStatement`，一条可执行的 PromQL/MetricsQL 及其数据源、单位与图形配置 |
| 生成来源 | 查询语句生成时第一栏的浏览方式（By Name / By Pod / By Node）、对应的前缀或 node 名称，以及第三栏已选的过滤标签 |
| 资源 | Grafana 中名为 `<pluginId>:<userUid>` 的 User Storage 对象；本功能所有 Key 都在其 `spec.data` 中 |
| 资源版本 | 资源的 `metadata.resourceVersion`，由 Grafana 在每次修改后更新 |
| 基础快照 | 打开编辑界面时读取的资源快照，代表“用户开始编辑时看到的数据” |
| 最新快照 | 提交前刚从服务器读取的资源快照，用于计算要提交的结果 |

## 2. 当前代码基线与接入点

以当前工作区文件为依据，不假定它们与 Git 已提交版本相同。

| 文件或配置 | 已有行为 | 本功能需要处理的差异 |
| --- | --- | --- |
| `src/explorer/components/Explorer.tsx` | `vm_explorer_favorites` 在 localStorage 中保存 `string[]`；`MetricScope` 包含 `favorites` | 移除 `favorites` scope 和旧 Key 的日常读写；旧 Key 只在显式导入时读取 |
| `src/explorer/components/MetricList.tsx` | `favorites` scope 按旧指标名列表过滤 | 随旧收藏日常入口一起移除 |
| `src/explorer/components/DetailPanel.tsx` | 未被任何文件引用；仍读写 `vm_explorer_favorites` | 删除该文件 |
| `src/explorer/components/TreeView.tsx` | 第一栏底部为 `Workspace / Favorites` | 移除 Favorites 项；在最后增加可折叠的用户菜单和 Settings 入口 |
| `src/explorer/components/ChartPanel.tsx` | Favorite 按钮切换指标名收藏；组件内部持有最终 `plan.query`、单位和图形类型；只收到 `podGroup`/`node`，不知道 By Name 前缀 | 保存入口必须取得当前请求对应的最终查询快照；生成来源由 Explorer 的 `MetricScope` 与 `SelectedFilters` 提供 |
| 同上 | 折线图通过 `lineSeries(frames).slice(0, 1)` 只显示第一条序列 | 手写查询可能返回多条序列，收藏渲染器不能静默丢弃其余序列 |
| `src/explorer/api/index.ts` | `queryChartData()` 已支持传入表达式、时间范围和 Step，但丢弃响应中的实际 Step 与 meta | 可复用查询请求；需要保留实际 Step、截断等响应信息 |
| `pkg/resource/query_range.go` | 接收完整表达式；限制查询文本为 16 KiB；结果最多保留 1000 条序列；Step 为空或非法时取 1m，点数超过 maxDataPoints 时升到下一档整齐步长 | 前端按 UTF-8 字节数验证；必须显示截断状态；收藏回放的 `auto` 直接利用此行为（见 8.1） |
| `pkg/resource/handlers.go` | chart-plan 的 `auto` Step 依据单个指标的采样间隔计算 | 依赖指标选择器，任意 PromQL 无法复用 |
| `src/app/components/App.tsx` | 管理数据源、时间范围、Step；只在 `capabilities && selectedDS` 同时存在时挂载 Explorer | 否则分支改为渲染“仅收藏”布局；收藏模式下数据源选择器只读（见 3.5） |
| `src/explorer/api/proto.ts` | Go Resource API 使用 Protobuf + zstd | 用户存储单独使用 gzip，不修改现有查询协议 |
| `Makefile` | `make proto` 只生成现有 explorer、cache 消息 | 为用户存储新增仅 TypeScript 的生成步骤 |
| `src/plugin.json` | App 插件，声明最低 Grafana `>=11.6.0`，有 Go 后端 | 不套用目录中残留的 panel-only 模板假设 |
| `package.json` / 已安装依赖 | `@grafana/runtime` 声明 `^12.3.1`，本机安装版本为 `12.4.13`；Protobuf 使用 `@bufbuild/protobuf` / `protoc-gen-es` v2 | npm 版本不能代替实际 Grafana 宿主版本验证 |
| `.config/bundler/externals.ts` | Grafana runtime/data/ui 由宿主提供 | 打包成功不代表最低宿主版本上相关接口一定可用 |
| `docker-compose.yml` | 使用 Grafana `latest` | 验证时用明确镜像版本，避免接口行为随环境变化 |
| 前端测试配置 | 有 Jest 配置，但当前 `package.json` 未声明 Jest、jsdom、SWC Jest、Testing Library 等完整依赖 | 实施前先补齐可执行的测试环境，不把现有 `npm test` 当成已可用 |

## 3. 范围与产品行为

### 3.1 首版必须完成

1. 登录用户从 Grafana 服务器加载菜单，向服务器保存修改，并在清空浏览器数据或更换设备后恢复。
2. 文件夹与收藏入口的创建、重命名、排序和跨层级移动。
3. 删除收藏入口；仅允许删除没有任何子节点的文件夹。
4. 从第四栏 Favorite 打开保存界面，把当前图表保存为一条查询（可包含多条查询语句），放入新建的收藏入口，或追加到已有收藏入口、替换其中一条查询。
5. 一个收藏入口保存多条查询；在收藏入口编辑界面（3.6）中编辑每条查询的名称及其查询语句（表达式、单位、数据源、图形类型），新增、排序、删除查询与查询语句。
6. 从菜单打开收藏入口、选择查询并执行，显示实际数据或独立错误状态。
7. 持久化失败、多窗口并发冲突、损坏数据、接口不可用均有可恢复路径。
8. 提供用户主动选择的旧收藏一次性导入，导入结果只保存到 Grafana 服务器。

### 3.2 本次不包含

团队共享、权限分享、生成 Grafana Dashboard、自动后台同步离线队列、查询模板变量编辑器、跨 Grafana 实例同步、完整版本历史、任意文件导入、服务端 watch 实时推送，以及一键并行渲染整个收藏入口。

不保存查询结果、数据源凭据、API Token 或浏览器身份信息。Protobuf 与 gzip 用于结构化和压缩，Base64 用于字符串传输；这条链路不提供加密。

### 3.3 目录与收藏入口规则

- 菜单根是不可删除的虚拟容器，不占自增 ID；其 `children` 可以包含文件夹和收藏入口。
- 文件夹可以包含文件夹或收藏入口；自身没有内容 Key。
- 收藏入口没有子节点。创建收藏入口时，在同一次提交中写入它的内容 Key；内容可包含 0～20 条查询。管理界面允许创建空收藏入口（内容 Key 存在、查询为 0 条），空入口显示引导；从 Favorite 保存的新收藏入口至少有一条查询。**内容 Key 缺失属于数据错误**（见 10.1），不当作空入口。
- 文件夹只要存在任意子节点就不允许删除，即使子节点是空文件夹或空收藏入口；不提供递归删除。
- 同一父节点下的名称经去首尾空白及 Unicode NFC 规范化后不得完全相同，大小写不同视为不同名称；不同父节点允许重名。
- 文件夹不能移动到自身或任意后代；收藏入口不能成为放置目标。跨父级移动后重新验证同名与深度限制。
- 子节点数组顺序就是显示顺序，不同时维护第二份 `order` 或父指针。操作中的位置用“父节点 ID + 前一个兄弟节点 ID”表达，不用数组下标，以便在最新数据上重放（见 7.4.4）。
- 重命名、移动和排序不改变 ID；删除后不回收 ID。当前选中节点属于 UI 状态，不作为 ID 分配计数器。

### 3.4 保存界面（从 Favorite 打开）

保存界面采用可滚动的 Drawer 或 Modal，分为“位置”和“查询”两部分，布局窄时改为上下排列。打开时从服务器重新读取一次，作为本次编辑的基础快照（见 7.3）。

**位置部分：** 展示相同的目录树，支持新建文件夹、新建收藏入口、选择已有收藏入口。选择文件夹只表示创建位置，不能直接把查询写入文件夹。

**查询部分：** 只编辑本次要保存的**一条**查询：一个名称，加上 1～10 条查询语句。每条查询语句包含多行表达式、单位和数据源；高级区域显示图形类型、热图的两个单位与当前上下文说明。

- 进入界面时，用当前 `ChartPlan` 预填第一条查询语句：最终表达式（包含已经生成的 Pod、Node、标签过滤和 rate/increase/irate 计算）、经 `units.ts` 转换的单位、图形类型、当前数据源和来源指标名，以及生成来源：第一栏的浏览方式（By Name / By Pod / By Node）、对应的前缀或 node 名称、第三栏已选的过滤标签（取值规则见 5.3）。查询名称默认取指标名。
- “添加查询语句”新增一条语句，数据源默认与上一条相同、单位 `none`、图形 timeseries，由用户手写表达式；手写语句没有生成来源。
- 生成来源在界面中只读显示；用户修改表达式后仍保留，标注为“生成来源”，不代表回放条件。
- 查询语句可排序、删除，至少保留一条；顺序就是第四栏图形区的显示顺序。

**目标为已有收藏入口时：** 下方只读列出该入口已有的查询（名称、查询语句数），并选择保存方式：

- 追加到末尾（默认）：新查询使用新生成的 UUID。
- 替换所选查询：必须显式选择一条已有查询；保存后该位置的查询内容被替换，沿用被替换查询的 UUID。
- 该入口已有 20 条查询时，“追加”不可选，只能替换或另选位置。

已有查询的编辑、排序与删除不在此界面进行，统一在 3.6 的收藏入口编辑界面完成。

保存界面内新增的目录、收藏入口和编辑的查询先放入页面内存草稿；点击保存后整体提交到 Grafana 服务器。取消关闭不产生服务器目录，也不写入浏览器存储。存在未保存修改时，关闭界面需由用户选择丢弃或继续编辑。

加载新 ChartPlan 期间、没有当前请求对应的查询时禁用 Favorite。查询已生成但数据执行失败时仍允许保存定义，错误不会被解释为保存失败。打开保存界面后固定快照，不因后台刷新或工具栏变化覆盖用户草稿。

### 3.5 打开收藏与四栏布局

| 栏位 | 普通浏览模式 | 收藏浏览模式 |
| --- | --- | --- |
| 第一栏 | Pod、Node、Metric，最下方为用户菜单 | 同左；当前收藏入口高亮 |
| 第二栏 | 指标列表 | 当前收藏入口的查询列表，按保存顺序显示 |
| 第三栏 | 标签过滤 | 所选查询的名称及各查询语句的表达式、单位、数据源与生成来源（如“By Pod · api-server · namespace = prod”）；“编辑”按钮打开 3.6 的编辑界面 |
| 第四栏 | 自动生成的图表 | 按顺序执行所选查询的每条查询语句，每条语句一个图形区 |

点击用户菜单中的收藏入口进入收藏模式；点击 Pod、Node、Metric 回到普通模式。进入收藏入口默认选择第一条查询；空入口不发请求。切换查询、时间范围、Step 或点击 Refresh 时重新执行当前查询。收藏模式不调用指标 Facets，也不把第三栏旧的标签过滤附加到已保存表达式上。

每条查询语句绑定自己的 `datasource_uid`，同一查询内的不同语句也可以使用不同数据源。

**第四栏的多语句显示：** 所选查询的查询语句按保存顺序纵向排列，每条语句一个图形区，各自使用自己的数据源、单位和图形类型；区域标题显示表达式摘要（有来源指标名时显示指标名）。每个图形区独立显示加载、无数据、截断和错误状态，一条语句失败不影响其他语句。

**数据源选择器（App 工具栏）：** 收藏模式下，Explorer 通过回调把当前模式和所选查询各语句的数据源告诉 App。App 把选择器置为禁用：全部语句使用同一数据源时显示其名称（数据源已删除时显示 `datasource_name_hint` 并标注不可用），使用多个数据源时显示“多个数据源”；并提示“收藏查询使用保存时绑定的数据源，请在编辑界面更换”。此时**不修改** App 的 `selectedDS`，因此不会触发能力探测，也不会重置普通浏览的选择状态。时间范围、Step、Refresh 在收藏模式下照常生效。退出收藏模式后选择器恢复显示 `selectedDS`。

**无可用数据源或能力探测失败时：** App 现有逻辑不挂载 Explorer。v3 在该分支保留原有提示，并在其下方渲染“仅收藏”布局：第一栏只有用户菜单，第二～四栏与收藏模式相同，复用同一组组件（`SavedModeColumns`）。收藏的每条查询语句自带 `datasource_uid`，执行时不依赖 `selectedDS` 与能力探测；所绑定数据源不可用时在该语句的图形区显示错误。

数据源删除或无权限时，仍可查看、编辑、移动和删除收藏，并提示选择新的有权限数据源。收藏的加载与管理不受数据源能力探测失败影响。退出收藏模式时恢复普通浏览的选择状态，避免 `datasourceUID` effect 将收藏选择意外清空。

### 3.6 收藏入口编辑界面

- **入口：** 第三栏的“编辑”按钮；Settings 管理界面中收藏入口的“编辑查询”操作。
- **内容：** 列出该入口的全部查询，可排序、删除。每条查询可编辑名称，并编辑其查询语句：表达式、单位、数据源、图形类型和热图单位；查询语句可新增、排序、删除，至少保留一条。可新增手写查询，它带一条初始语句（默认 timeseries、单位 `none`，数据源默认为当前 `selectedDS`，没有时取列表中第一条语句的数据源）。可对单条查询语句“试运行”。
- **生成来源：** 每条语句的浏览方式、前缀或 node 名称、过滤标签只读显示，不可编辑；修改表达式不会清除它们。新增的手写语句没有生成来源。
- **提交：** 打开时从服务器重新读取，作为基础快照；所有修改先放在内存草稿中，点击保存后作为一次 `editFavoriteQueries` 操作提交（见 7.4.4）；取消即丢弃草稿。
- 收藏入口的名称在 Settings 管理界面中修改，不在此界面修改。

## 4. Grafana User Storage 的能力与接入方案

### 4.1 已确认的事实

官方文档说明 User Storage 将用户数据保存到 Grafana 数据库，在 Grafana 12.0 起 GA，11.5 起可通过 `userStorageAPI` feature flag 使用。文档也说明 SDK 在服务未开启时可能回退到 localStorage；**本计划不采用这一回退行为**。其服务端数据面向当前用户，且不是加密存储。[官方说明](https://grafana.com/developers/plugin-tools/how-to-guides/add-user-storage)

**SDK 行为**（本地 `node_modules/@grafana/runtime/dist/esm/utils/userStorage.mjs`，对应[上游 v12.4.13 源码](https://github.com/grafana/grafana/blob/v12.4.13/packages/grafana-runtime/src/utils/userStorage.tsx)）：

- 公开 Hook 只提供 `getItem` / `setItem`，没有删除、批量提交、刷新缓存或条件写入接口。
- 多个业务 Key 位于同一个资源的 `spec.data: Record<string, string>` 中。
- `setItem` 在请求失败时把值写入 localStorage 并正常返回；`getItem` 读的是模块级缓存。
- SDK 的内存锁只在单个页面内有效，不构成跨窗口或服务端并发控制；它的 PATCH 不带 `resourceVersion`，是无条件写入。

因此，不能用“`await setItem()` 返回”或再次调用缓存中的 `getItem()` 判断远端持久化成功。

**服务端行为（已从源码确认，v12.4.13 的 [register.go](https://github.com/grafana/grafana/blob/v12.4.13/pkg/registry/apis/userstorage/register.go)、[strategy.go](https://github.com/grafana/grafana/blob/v12.4.13/pkg/registry/apis/userstorage/strategy.go)）：**

- 授权只要求已登录用户：对名称与自己匹配的资源可执行 get、patch、update、delete；create 在校验阶段检查名称；list、watch 被拒绝。**不区分 Viewer、Editor、Admin 角色。**
- Grafana 服务器管理员（Grafana Admin）可以访问任何用户的资源。
- 资源名必须是 `<service>:<user_uid>`，按冒号拆分后恰好两段。本插件 ID `ahfuzhang-victoriametricsexplorer-app` 不含冒号。
- 服务端只把对象的 JSON 大小记录到直方图（注释写“目标小于 3MB”），**不拒绝任何大小**。实际上限来自请求体限制、代理和数据库，需要实测。
- 注册函数本身不检查 feature flag；路由是否存在仍由宿主版本与配置决定，需要按 4.4 探测。

### 4.2 推荐实现：隔离的前端 REST adapter

通过 Grafana `getBackendSrv()` 使用当前用户会话访问 User Storage API。组件只访问应用自己的 Repository，不散落拼装 URL，不导入 runtime 私有的 `UserStorage` 类。

**资源名与 URL：**

- `pluginId` 取插件上下文的 `meta.id`，即 `ahfuzhang-victoriametricsexplorer-app`。
- `userUid` 与 SDK 的取法完全一致：`config.bootData.user.uid`；它为空字符串时用 `String(config.bootData.user.id)`。取法不一致会导致服务端返回 403。
- `config.bootData.user.isSignedIn` 为 false（匿名）时直接判定不可用，不发请求。
- 资源名为 `${pluginId}:${userUid}`，资源 URL 为：

```text
/apis/userstorage.grafana.app/v0alpha1/namespaces/{config.namespace}/user-storage/{pluginId}:{userUid}
```

这是需要锁定版本与集成测试的适配细节，并非承诺此路径在所有 Grafana 版本中永远稳定。请求与 SDK 一样经 backendSrv 发送，子路径部署在 P0 验证。

**请求格式**（与 SDK 保持一致，额外携带版本前提）：

| 动作 | 请求 |
| --- | --- |
| 读取 | `GET .../user-storage/{name}` |
| 首次创建 | `POST .../user-storage/`，body `{ metadata: { name, labels: { user: userUid, service: pluginId } }, spec: { data } }`。服务端不校验 labels，保留它们只为与 SDK 一致 |
| 修改 | `PATCH .../user-storage/{name}`，`Content-Type: application/merge-patch+json`，body `{ metadata: { resourceVersion }, spec: { data: changes } }`；`changes` 中值为 `null` 的 Key 被删除 |
| 备选修改 | 若 P0 证明 merge patch 不检查 `resourceVersion`，改用 `PUT .../user-storage/{name}` 提交完整对象（含 `metadata.resourceVersion` 与完整 `spec.data`）。二选一，由 P0 结果写死，不在运行时切换 |

- 所有请求设置 `showErrorAlert: false`，由 adapter 自行设置超时（建议 15 秒）。
- `commit()` 在运行时断言 `expectedResourceVersion` 非空。本插件任何代码都不得对该资源发送不带版本前提的写入，也不得调用 `usePluginUserStorage().setItem()`，否则会绕过 7.4 的并发控制。

页面内存缓存的作用域必须包含 namespace、资源名；切换用户或组织时废弃旧会话的内存缓存、草稿和在途响应。每次新页面会话都从服务器初始化，不能从浏览器持久化数据初始化收藏。

下面的接口只用于组织前端调用服务器的代码：`UserStorageSnapshot` 表示“一次从服务器读回来的数据及其版本”，`UserStorageAdapter` 表示“读取、首次创建、修改服务器数据的方法”。它们不负责浏览器持久化，也不是新增的服务器接口。

```ts
// 一次读取 Grafana User Storage 资源得到的快照。
// 页面可以暂存在内存中；真正持久化的数据仍在 Grafana 数据库中。
interface UserStorageSnapshot {
  // Grafana 返回的整个资源版本，修改时原样带回服务器。
  // 若另一个窗口已修改资源，服务器会拒绝旧版本提交，避免覆盖其修改。
  // 这是不透明字符串，不自行加 1，也不转换为 JS number。
  resourceVersion: string;

  // 服务器资源的 Key → 字符串值映射。
  // 本功能的 Key 如 favorites.menu.v1、favorites.node.v1.2；
  // 对应值是 Protobuf → gzip → Base64 后的字符串。
  // 资源还可能包含其他 Key，修改时必须保留。
  data: Record<string, string>;
}

// 前端访问 Grafana User Storage API 的统一入口。
// 方法内部发 HTTP 请求；不使用 localStorage 等浏览器存储。
interface UserStorageAdapter {
  // 重新请求服务器，读取当前资源，不能直接返回旧的页面缓存。
  // 仅在 API 可用且该用户资源尚未创建时返回 null；其他失败抛出 UserStorageError。
  loadFresh(): Promise<UserStorageSnapshot | null>;

  // 资源不存在时创建整个资源。
  // 若资源已被其他窗口创建，抛出 alreadyExists，不能覆盖；成功返回服务器确认的快照。
  create(data: Record<string, string>): Promise<UserStorageSnapshot>;

  // 在已有资源上一次性提交菜单、收藏内容等相关 Key 的变更。
  commit(
    // 本次修改依据的资源版本，取自本轮提交循环刚读取的最新快照。
    expectedResourceVersion: string,

    // 只列出要改变的 Key：字符串表示新增/替换，null 表示删除该 Key。
    // 未列出的 Key 保持不变；菜单和对应内容必须在同一次请求中提交。
    changes: Record<string, string | null>
  ): Promise<UserStorageSnapshot>;
}

// adapter 抛出的错误分类，提交循环（7.4.3）据此决定是否重试。
type UserStorageErrorKind =
  | 'unavailable'      // API 路由不存在，或匿名用户
  | 'unauthenticated'  // 401：会话过期
  | 'forbidden'        // 403：资源名与用户不匹配或无权限
  | 'versionConflict'  // 409，reason=Conflict：resourceVersion 已过期
  | 'alreadyExists'    // 409，reason=AlreadyExists：首次创建时资源已被其他窗口创建
  | 'resourceGone'     // PATCH/PUT 时 404：资源在读取后被删除
  | 'rejected'         // 400/413/422：请求本身不合法或过大，不重试
  | 'throttled'        // 429：服务器未执行，可退避后重试
  | 'uncertain';       // 超时、断连、5xx：服务器可能已提交，也可能没有
```

注意两个 `null` 的含义不同：`loadFresh()` 返回 `null` 表示整个用户资源尚未创建；`changes` 中某个 Key 的值为 `null` 表示删除这个 Key。不得通过 DELETE 整个 User Storage 资源来删除一个收藏入口。adapter 不提供任何浏览器存储实现或回退实现。

### 4.3 第一阶段必须验证的契约

Grafana 的该资源使用 Kubernetes generic registry，具有对象 metadata 和 `spec.data`，这为“单资源条件更新”提供了实现依据。授权、资源名与大小行为已从源码确认（4.1），但**条件写入只阅读了源码，没有对运行实例执行写入验证**。[资源类型](https://github.com/grafana/grafana/blob/v12.4.13/pkg/apis/userstorage/v0alpha1/types.go)、[存储注册](https://github.com/grafana/grafana/blob/v12.4.13/pkg/registry/apis/userstorage/storage.go)

在隔离测试用户和固定 Grafana 版本上验证：

1. GET 返回 `metadata.resourceVersion`；成功修改后获得新的版本值。
2. 首次 POST 创建；两个客户端并发 POST 同名资源时，后到者得到 409 且 `reason` 为 `AlreadyExists`，不能覆盖。
3. 一次 PATCH 修改两个内容 Key 与菜单 Key，服务端作为一个资源变更提交。
4. 携带过期 `metadata.resourceVersion` 的 merge patch 被拒绝，得到 409 且 `reason` 为 `Conflict`。若 merge patch 不检查版本，验证带版本的 PUT，再由 adapter 固定使用其中一种。
5. 条件失败时没有任何 Key 被部分更新；`null` 能删除 map 成员。
6. 保留所有不属于本功能的 Key；普通用户访问他人资源被拒绝；Grafana Admin 可访问（文档说明，不作为缺陷）。
7. 匿名、用户/组织切换、Grafana 子路径和 API 关闭场景；记录“资源不存在”与“路由不存在”两种 404 的实际响应体。
8. 实际请求体与资源体大小上限、代理限制、读取一致性（写入后立即 GET 是否读到新版本）。
9. 保存后清空浏览器站点数据并重新登录，验证内容仍从服务器恢复；在另一个独立浏览器读取相同内容。
10. 重启使用持久化数据库的 Grafana 测试实例，验证菜单、收藏内容与自增 ID 计数器仍然存在。
11. 两个独立浏览器上下文同时新建收藏入口：一个直接成功，另一个先得到 409，再经 7.4 的重放成功；两者 ID 不同，内容都保留。

Kubernetes API 中 `resourceVersion` 可用于避免丢失更新，但不能据此跳过 Grafana 目标版本的实测。[API 并发语义](https://kubernetes.io/docs/reference/using-api/api-concepts/#updates-to-existing-resources)

若目标环境无法提供上述条件提交能力，不得用“先读再写”、浏览器锁、时间戳或重试包装伪装成等价实现。应在第一阶段调整存储设计或兼容范围；在条件明确前，个性化写入保持不可用，原有查询功能继续工作。无需为此新增 Go 持久化接口。

### 4.4 版本兼容策略

- 保留已有插件最低版本声明，普通浏览功能继续按原范围运行；个性化存储依能力开启。
- 首先固定一个 Grafana 12.x 验证基线；对实际使用的更新宿主再增加验证记录。安装的 SDK 版本只作为源码参考。
- Grafana 11.6 的开启/关闭 feature flag 两种情况都纳入兼容测试。若通过验证，记录为支持；否则显示该功能不可用，不宣称已兼容。
- 不静态依赖较新宿主独有的 Hook 导出，避免整个 App 在旧宿主加载失败。
- **区分两种 404**：
  - 资源未创建：HTTP 404，且响应体是 Kubernetes `Status`（`kind: "Status"`、`reason: "NotFound"`、`details.group: "userstorage.grafana.app"`、`details.name` 等于资源名）。`loadFresh()` 返回 `null`。
  - 其他 404（没有 `Status` 响应体或 group 不符）视为 API 不可用；可再请求发现接口 `GET /apis/userstorage.grafana.app/v0alpha1` 确认，返回的资源列表包含 `user-storage` 才算可用。
  - 两种响应体的实际形状在 P0 记录后写入测试夹具。读取失败不得转换成空树并自动覆盖。

## 5. 数据模型与 Key 设计

### 5.1 业务 Key

保留两类 Key，命名独立于 HTTP API 版本和文档版本：

```text
favorites.menu.v1
favorites.node.v1.<nodeId>
```

`<nodeId>` 是收藏入口 ID 的十进制字符串。`v1` 表示首个存储格式主版本，本计划名称 v3 不意味着存储格式从 v3 起步。目录只存在于菜单；每个收藏入口对应一个内容 Key；单条查询不是一个独立存储 Key。

这些 Key 是 Grafana 服务器端同一 User Storage 资源中的 map 成员，不是浏览器存储 Key，也不代表独立数据库行。拆分 Key 能减少变更和解码范围，但 GET 仍返回整个 map；容量与性能评估必须按整个服务端资源计算。

### 5.2 Protobuf 定义

新增 `proto/explorer/user_storage.proto`，用 `protoc-gen-es` 生成到 `src/generated/explorer/user_storage_pb.ts`；仅生成 TypeScript。下面定义的是“保存到 Grafana 服务器的数据长什么样”。前端将这些结构编码后写入 User Storage，读取时再还原成同样的结构。

结构之间的关系是：**Tree 保存整个菜单；TreeNode 保存菜单上的一个文件夹或收藏入口；收藏入口通过 ID 找到 FavoriteContent；FavoriteContent 内包含多条 SavedQuery；每条 SavedQuery 是一次 Favorite 保存的结果，内含 1～10 条 QueryStatement。** 业务消息中不存放任何版本号或提交记录，并发控制由资源版本负责（第 7 节）。

| 结构 | 回答的问题 | 保存位置 |
| --- | --- | --- |
| `Tree` | 用户有哪些目录和收藏入口？下一个树节点 ID 是多少？ | `favorites.menu.v1` 的值 |
| `TreeNode` | 这个条目叫什么、是文件夹还是收藏入口、下面有哪些条目？ | 嵌在 `Tree.children` 或其他文件夹的 `children` 中 |
| `FavoriteContent` | 打开这个收藏入口后，可以选择哪些查询？ | `favorites.node.v1.<nodeId>` 的值 |
| `SavedQuery` | 一次 Favorite 保存了什么？叫什么名字、包含哪些查询语句？ | 嵌在 `FavoriteContent.queries` 中 |
| `QueryStatement` | 这条查询语句执行什么表达式、用哪个数据源、怎样显示、从哪里生成？ | 嵌在 `SavedQuery.statements` 中 |
| `SavedLabelFilter` | 语句生成时选了哪些过滤标签？ | 嵌在 `QueryStatement.source_filters` 中 |

Protobuf 的 `message` 字段声明中，`= 1`、`= 2` 等是**字段编号**，不是字段默认值；`enum` 中等号右边则是枚举值。`repeated` 表示列表。`schema_version` 的实际初始值 1 需要创建消息时设置。

```protobuf
syntax = "proto3";
package explorer.userstorage.v1;

// 区分菜单条目是“文件夹”还是“存放查询的收藏入口”。
enum NodeKind {
  NODE_KIND_UNSPECIFIED = 0; // 未设置，不能作为合法节点保存。
  NODE_KIND_FOLDER = 1;      // 文件夹：只有子节点，没有内容 Key。
  NODE_KIND_FAVORITE = 2;    // 收藏入口：没有子节点，通过 ID 关联内容 Key。
}

// 再次打开已保存查询时，使用哪一种图形显示查询结果。
enum VisualizationKind {
  VISUALIZATION_KIND_UNSPECIFIED = 0; // 未设置；保存前需明确图形类型。
  VISUALIZATION_KIND_TIMESERIES = 1;  // 时间序列折线图。
  VISUALIZATION_KIND_STAT = 2;        // 数值展示，首版取各序列最后一个非空值。
  VISUALIZATION_KIND_HEATMAP = 3;     // 热图，查询结果需要符合桶标签结构。
}

// 查询语句是从第一栏的哪种浏览方式生成的。
enum SourceScope {
  SOURCE_SCOPE_UNSPECIFIED = 0; // 没有浏览来源：手写语句或旧收藏导入。
  SOURCE_SCOPE_BY_NAME = 1;     // By Name：按指标名前缀浏览，含 All metrics。
  SOURCE_SCOPE_BY_POD = 2;      // By Pod：按 pod 前缀（工作负载）浏览。
  SOURCE_SCOPE_BY_NODE = 3;     // By Node：按 node 浏览。
}

// 整个用户菜单，编码后保存到服务器的 favorites.menu.v1。
// 负责导航结构与树节点 ID 分配，不直接存储 PromQL。
message Tree {
  // 数据格式版本：用于判断当前程序能否读取、修改此格式；初始填 1。
  // 这是格式版本，不是数据修订号。
  uint32 schema_version = 1;

  // 历史上已分配的最大树节点 ID，文件夹与收藏入口共用这个计数器。
  // 空树为 0，下一节点使用当前值 + 1；删除节点后也不减小。
  uint64 max_tree_node_id = 2;

  // 根目录下的菜单条目，列表顺序就是显示顺序；文件夹内部继续递归。
  repeated TreeNode children = 3;
}

// 菜单上的一个条目：文件夹或收藏入口。
// 此结构嵌在菜单树中，不单独创建服务器 Key。
message TreeNode {
  // 树内唯一的自增 ID；移动、重命名后不变，删除后不复用。
  // 若为收藏入口，例如 ID=2，其内容 Key 为 favorites.node.v1.2。
  uint64 id = 1;

  // 第一栏菜单显示的名称，例如“服务监控”或“接口延迟”。
  string name = 2;

  // 决定此条目能否包含子节点，以及是否关联内容 Key。
  NodeKind kind = 3;

  // 只有文件夹可以有子节点；收藏入口必须为空。
  repeated TreeNode children = 4;
}

// 一个收藏入口对应的查询集合。
// 编码后保存到 favorites.node.v1.<node_id>，可以包含多条 PromQL。
message FavoriteContent {
  // 数据格式版本，初始填 1；用途与 Tree.schema_version 相同。
  uint32 schema_version = 1;

  // 对应收藏入口的 TreeNode.id，必须与所在 Key 中的 ID 一致，用于自检。
  uint64 node_id = 2;

  // 该收藏入口内的全部查询；列表顺序就是第二栏的显示顺序。可以为空。
  repeated SavedQuery queries = 3;

  // 最近修改时间，Unix 毫秒，仅用于展示；不能用于冲突判断。
  int64 updated_at_ms = 4;
}

// 一条收藏的查询：一次点击 Favorite 保存的结果，嵌在 FavoriteContent.queries 中。
// 一个图表可能由多条查询语句组成，因此这里只保存名称与语句列表。
// 不保存本次执行得到的时间序列数据。
message SavedQuery {
  // 查询自身的 UUID，用来精确定位要修改、删除或排序的查询。
  // 在打开编辑界面时生成，重试与重放过程中保持不变；
  // 7.4 用它判断一次追加是否已经生效。
  string id = 1;

  // 用户可读名称，例如“接口延迟分位数”，显示在第二栏查询列表和第四栏标题中。
  string name = 2;

  // 本查询包含的查询语句，1～10 条；列表顺序就是第四栏图形区的显示顺序。
  repeated QueryStatement statements = 3;
}

// 一条可以重新执行的查询语句，嵌在 SavedQuery.statements 中。
// 每条语句独立执行，在第四栏独立显示一个图形区。
message QueryStatement {
  // 最终执行的完整 PromQL/MetricsQL 文本，包含已确定的过滤条件。
  // 例如 histogram_quantile(0.99, sum(rate(...[5m])) by (le))。
  string expression = 1;

  // 执行查询时使用的 Grafana 数据源 UID，避免换页面后查到其他环境。
  // 同一 SavedQuery 中的不同语句可以使用不同数据源。
  string datasource_uid = 2;

  // 保存时的数据源名称，仅作为显示提示，尤其用于数据源已删除的情况。
  // 不能按此名称寻找数据源；真正寻址必须使用 datasource_uid。
  string datasource_name_hint = 3;

  // 普通折线图或数值图的 Grafana 单位 ID，例如 bytes、s、percentunit。
  // 只影响数字格式化，不改变表达式或原始值。
  string unit_id = 4;

  // 此语句使用折线图、数值图还是热图，重新打开时按此设置显示。
  VisualizationKind visualization = 5;

  // 可选的来源指标名，帮助用户了解语句最初从哪个指标生成。
  // 用户手工新建时可为空；回放始终执行 expression，不从此字段重建。
  string source_metric = 6;

  // 语句生成时第一栏使用的浏览方式：By Name、By Pod 或 By Node。
  // 手写语句为 SOURCE_SCOPE_UNSPECIFIED。
  SourceScope source_scope = 7;

  // 与 source_scope 配合的取值：
  //   BY_NAME → 指标名前缀，空字符串表示 All metrics；
  //   BY_POD  → pod 前缀，即 By Pod 下的工作负载分组名；
  //   BY_NODE → node 名称。
  // 只保存前缀或名称，不保存当时属于该分组的 pod 列表。
  string source_scope_value = 8;

  // 语句生成时第三栏已选的过滤标签。
  // 同一标签的多个值之间为“或”，不同标签之间为“与”；按标签名和值排序后保存。
  // 只记录来源：这些条件已体现在 expression 中，回放时不再附加。
  repeated SavedLabelFilter source_filters = 9;

  // 仅热图使用：桶边界的单位，例如延迟桶的 s。
  // 非热图留空；它与桶中的计数或速率单位不同。
  string heatmap_bucket_unit_id = 10;

  // 仅热图使用：桶内数值（颜色所代表数值）的单位，例如次数或次数/秒。
  // 保存 Grafana 单位 ID；非热图留空。
  string heatmap_value_unit_id = 11;
}

// 一个过滤标签及其已选值，嵌在 QueryStatement.source_filters 中。
// 语义与 explorer.proto 的 LabelFilter 相同，但单独定义、不 import，
// 避免查询 API 的改动影响已经存储的数据。
message SavedLabelFilter {
  // 标签名，例如 job、namespace。
  string name = 1;

  // 已选的标签值，至少一个。
  repeated string values = 2;
}
```

例如，用户创建“服务监控”文件夹（ID=1），其中有“接口延迟”收藏入口（ID=2），入口内保存两条查询：“P95/P99 延迟”含两条查询语句，“请求速率”含一条：

```text
服务器 Key：favorites.menu.v1
  Tree
    max_tree_node_id = 2
    children
      TreeNode(id=1, name="服务监控", kind=FOLDER)
        children
          TreeNode(id=2, name="接口延迟", kind=FAVORITE)

服务器 Key：favorites.node.v1.2
  FavoriteContent(node_id=2)
    queries
      SavedQuery(id="…", name="P95/P99 延迟")
        statements
          QueryStatement(expression="histogram_quantile(0.95, ...)", unit_id="s", visualization=TIMESERIES,
                         source_scope=BY_POD, source_scope_value="api-server",
                         source_filters=[namespace ∈ {prod}])
          QueryStatement(expression="histogram_quantile(0.99, ...)", unit_id="s", visualization=TIMESERIES,
                         source_scope=BY_POD, source_scope_value="api-server",
                         source_filters=[namespace ∈ {prod}])
      SavedQuery(id="…", name="请求速率")
        statements
          QueryStatement(expression="sum(rate(http_requests_total[5m]))", unit_id="reqps", visualization=TIMESERIES)
```

上图为省略部分字段后的逻辑示意，实际服务器值仍是编码后的字符串。点击“接口延迟”时，通过 ID=2 读取并解码对应内容，第二栏列出“P95/P99 延迟”和“请求速率”；选中“P95/P99 延迟”后，第四栏按顺序显示两个图形区，每条语句使用自己的数据源和表达式执行。

### 5.3 数据约束

- `schema_version` 初始为 1。
- `max_tree_node_id` 表示曾分配的最大 ID；新增文件夹和收藏入口都递增。同一次操作创建多个树节点时连续分配；删除不降低计数。ID 只在 7.4 的重放步骤中、基于最新快照分配。
- `protoc-gen-es` v2 默认把 `uint64` 生成为 `bigint`；DOM、map key 和日志中的 ID 转为十进制字符串，禁止转换为 `number` 后再参与计算。
- 树中的 ID 必须非零且全局唯一，并且不超过 `max_tree_node_id`；计数达到 uint64 上限时拒绝新增，不允许回绕。
- 树中每个收藏入口都必须有对应内容 Key，内容的 `node_id` 必须等于 Key 中的 ID；文件夹不得有内容 Key。
- 文件夹的 `children` 可非空；收藏入口 `children` 必须为空。未知 kind 进入只读错误状态，不猜测其含义。
- 每条 `SavedQuery` 至少 1 条、最多 10 条 `QueryStatement`；每条语句的 `expression` 与 `datasource_uid` 不能为空。
- 生成来源：`source_scope` 为 UNSPECIFIED 时，`source_scope_value` 与 `source_filters` 必须为空；BY_POD、BY_NODE 时 `source_scope_value` 不能为空；BY_NAME 时可为空（表示 All metrics）。`source_filters` 中标签名不重复，每个标签至少一个值且值不重复。

生成来源从 Explorer 当前状态取值：

| 第一栏选择（`MetricScope`） | `source_scope` | `source_scope_value` |
| --- | --- | --- |
| By Name → All metrics（`{ kind: 'all' }`） | `SOURCE_SCOPE_BY_NAME` | 空字符串 |
| By Name → 某个前缀（`{ kind: 'group', group }`） | `SOURCE_SCOPE_BY_NAME` | `group`，即指标名前缀 |
| By Pod → 某个工作负载（`{ kind: 'pod', group, pods }`） | `SOURCE_SCOPE_BY_POD` | `group`，即 pod 前缀；不保存 `pods` |
| By Node → 某个节点（`{ kind: 'node', node }`） | `SOURCE_SCOPE_BY_NODE` | `node`，即 node 名称 |
| 手写语句、旧收藏导入 | `SOURCE_SCOPE_UNSPECIFIED` | 空字符串 |

`source_filters` 来自 Explorer 的 `SelectedFilters`（标签 → 已选值）：去掉没有选值的标签，按标签名、值排序后保存。
- 菜单不重复存储查询名称、表达式或数量；树节点名称只在树中维护，防止重命名需要同步多份标题。
- **不存储任何版本号、修订号或操作回执。** “是否被其他窗口修改过”通过资源版本与内容 Key 原始字符串的比较判断（7.4）。
- UUID 使用 `crypto.randomUUID()` 生成；`updated_at_ms` 只用于展示，不作为锁或冲突顺序依据。
- 不改变已发布字段编号，不复用删除字段编号；protobuf-es v2 默认保留 unknown fields，领域对象与 PB 消息相互转换时必须带上它们，避免“PB → 简化对象 → PB”写回时丢失未来字段。
- 遇到高于当前可写版本的数据只读并提示升级，禁止旧客户端重新编码覆盖。

## 6. 编码、容量与校验

### 6.1 编解码流程

业务值使用统一 codec，树与内容均采用同一处理链：

```text
领域校验 → Protobuf 二进制 → gzip → 标准 Base64 → HTTP API → Grafana 数据库
Grafana 数据库 → HTTP API → Base64 严格解码 → 有上限的 gzip 解压 → Protobuf 解码 → 领域校验
```

格式版本由 Key 与消息内 `schema_version` 共同管理，不在 Base64 前额外拼接非 Base64 前缀。首选浏览器原生 Compression Streams，检查 `CompressionStream` 与 `DecompressionStream` 是否存在；支持范围内确有缺口时只增加一个经过验证的 gzip 实现。Web Worker 由实际性能测试决定，首版不预设必须引入。

分块处理字节数组与 Base64，避免对大数组调用展开形式的 `String.fromCharCode(...bytes)`。解压时逐块读取并累计输出字节，超过上限立即中止；测试损坏 gzip 与超大膨胀数据。仅在解压完成后检查长度不足以控制内存峰值。

已有 Resource API 的 zstd 编解码保持独立，不复用其编码头或解压器。

### 6.2 首版建议限制

以下是应用自定的限制。已从源码确认 Grafana 服务端不按大小拒绝请求（4.1），所以这些限制必须由前端执行；第一阶段再用真实请求体上限校准，统一放在 `limits.ts` 中。

| 对象 | 建议限制 | 处理方式 |
| --- | --- | --- |
| 树中全部节点 | 500 个，文件夹和收藏入口合计 | 超出时拒绝新增，仍允许查看、删除 |
| 层级 | 虚拟根深度 0，最深实际节点深度 8 | 创建与移动时检查整个子树深度 |
| 文件夹/收藏入口/查询名称 | 1～128 个 Unicode 码点 | 不截断后写入，明确提示 |
| 每个收藏入口的查询数 | 最多 20 条 | 保存前验证 |
| 每条查询的查询语句数 | 1～10 条 | 保存前验证 |
| 单条表达式 | 最多 16 KiB UTF-8 | 与现有后端限制一致 |
| 解压后的菜单 | 最多 256 KiB | 超出进入只读诊断，不自动清空 |
| 解压后的单个收藏内容 | 最多 512 KiB | 编码前、解码时均检查 |
| 单个 Base64 值 | 最多 768 KiB | 解码前检查，避免大输入分配 |
| 整个资源候选 JSON | 最多 1 MiB，含已有其他 Key | 计入 Base64、Key、metadata 等开销 |
| 单次加载解压总量 | 最多 8 MiB | 内容按需解码，页面内存缓存采用有界 LRU |

Base64 长度约为压缩字节数的 `4 × ceil(n / 3)`；压缩效果差的数据仍可能超限。节点数和查询数是独立上限，不承诺所有上限能同时达到。超过容量时不得丢弃查询、自动截断树或绕过限制。

## 7. 一致性、并发与保存流程

### 7.1 并发模型

本版不在 Protobuf 中保存版本或回执，依据是：

- **并发控制交给资源版本。** 每次修改都携带 `metadata.resourceVersion`；只要资源在读取后被别人改过，Grafana 就拒绝这次写入，什么都不改。业务层再存一份修订号是重复的。
- **API 正常运行时可靠，但仍会返回非成功结果。** 409 冲突是条件写入有意产生的结果；此外还有 401 会话过期、网络超时和 5xx。这些通过 7.4、7.5 的提交循环处理，不需要业务层版本号或回执。

### 7.2 一次业务操作，一次资源提交

Repository 接收领域操作，组件不得自行按顺序调用多个 Key 的保存方法。首版操作如下（定义与重放规则见 7.4.4）：

`createFolder`、`createFavorite`、`appendQuery`、`replaceQuery`、`editFavoriteQueries`、`renameNode`、`moveNode`、`deleteFavorite`、`deleteFolder`。

Settings 管理界面的一次“应用”是一个操作批次：多个操作按草稿中的顺序依次执行，合成一次提交。

新建收藏入口并保存查询时，同一条件请求包含：更新后的菜单（含自增计数器）与新的内容 Key。编辑收藏内容只改对应内容 Key，不改菜单。删除收藏入口时同时移除菜单引用和内容 Key。这样的原子性以第 4.3 节验证通过为前提。

### 7.3 标准提交步骤

1. 打开编辑界面时 `loadFresh()`，记录基础快照（资源版本 + 原始 `data`）与身份作用域，创建独立草稿。草稿中新建的树节点使用临时 ID（`tmp-<uuid>`，永不持久化），新查询在此时生成 UUID。
2. 用户点击保存后做字段、结构和大小校验；禁用保存按钮直到本次提交结束，防止重复点击。
3. 执行 7.4.3 的提交循环：读取最新快照 → 在最新数据上重放操作 → 条件提交。
4. 成功后用响应中的新快照更新页面内存缓存，按“临时 ID → 正式 ID”映射恢复选中与展开状态；此时才显示“已保存到 Grafana 服务器”，并通知同浏览器的其他窗口（7.4.6）。
5. 失败时保留草稿并显示具体原因（冲突、未登录、过大等）；不写入浏览器存储，不显示保存成功，刷新或关闭页面前提醒草稿尚未提交。

### 7.4 多窗口版本冲突的解决方案

#### 7.4.1 问题

同一用户可能在多个窗口中同时打开 App：同一浏览器的多个标签页，或不同浏览器、不同设备。每个窗口在内存中持有自己读取时的快照。如果各自在旧快照上修改后直接写回，会出现：

- **自增 ID 重复：** A、B 都读到 `max_tree_node_id = 5`，各自新建一个收藏入口，都分配 ID 6。
- **后写覆盖先写：** 菜单是一个 Key，后写的窗口会用自己的整棵树替换先写窗口的新节点；`favorites.node.v1.6` 也被后写者覆盖，先写的查询静默丢失。
- **重复追加：** 一次超时的提交实际已生效，再次提交时又追加了一份同样的查询。

merge patch 只按 Key 合并，菜单作为一个整体字符串仍会被覆盖，所以按 Key 拆分不能解决上述问题。

#### 7.4.2 三条规则

1. **所有写入都是条件写入。** 每次提交都携带资源版本；Grafana 发现版本已变化就返回 409，且不做任何修改。这保证“在旧快照上算出的结果”永远无法写入数据库。
2. **保存操作，而不是结果。** Repository 保存用户的意图（例如“在文件夹 1 中、节点 3 之后，新建名为‘错误率’的收藏入口，内含查询 q1”），而不是算好的整棵树。收到 409 后重新读取，把同一操作在最新数据上重新计算一遍再提交。自增 ID 只在这一步、基于最新的 `max_tree_node_id` 分配。
3. **重放前先判断操作是否已生效。** 查询有稳定的 UUID，名称在同一父节点下唯一。如果最新数据已经满足操作意图（例如要追加的查询 UUID 已存在），直接视为成功，不再写入。这条规则同时解决超时后的重复提交（7.5）。

#### 7.4.3 提交循环

```ts
// 一次用户保存 = 一次 commitOperations 调用；ops 是按顺序执行的领域操作。
// base 是打开编辑界面时的基础快照，用来判断“用户看到的内容”之后是否被别人改过。
async function commitOperations(ops: Operation[], base: UserStorageSnapshot | null) {
  let lastError: UserStorageErrorKind | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) { // MAX_ATTEMPTS = 4
    const latest = await adapter.loadFresh();                   // 每轮都重新读取
    const plan = replay(ops, base, latest);                     // 纯函数，规则见 7.4.4
    if (plan.kind === 'alreadyApplied') {
      return { snapshot: latest, idMap: plan.idMap };
    }
    if (plan.kind === 'conflict') {
      throw new FavoritesConflict(plan.reason, latest);         // 交给用户处理，保留草稿
    }
    try {
      const snapshot = latest
        ? await adapter.commit(latest.resourceVersion, plan.changes)
        : await adapter.create(plan.data);
      return { snapshot, idMap: plan.idMap };
    } catch (err) {
      lastError = classify(err);
      switch (lastError) {
        case 'versionConflict': // 其他窗口先提交了
        case 'alreadyExists':   // 其他窗口先创建了资源
        case 'resourceGone':    // 资源在读取后被删除
        case 'throttled':
        case 'uncertain':       // 可能已提交；下一轮读取后由 replay 判定是否已生效
          await backoff(attempt); // 100～400 ms × attempt，带随机抖动
          continue;
        default:
          throw err;            // unauthenticated、forbidden、rejected 等不重试
      }
    }
  }
  // 多轮仍未成功：最后一次是 uncertain 时显示“提交结果待确认”，否则提示稍后重试。
  throw lastError === 'uncertain' ? new FavoritesUncertain() : new FavoritesBusy();
}
```

- `replay(ops, base, latest)` 是纯函数：输入操作、基础快照和最新快照，输出 `apply`（要提交的 `changes` 与 ID 映射）、`alreadyApplied` 或 `conflict`。它不发请求，可以完整单元测试。
- 批次中所有操作都已生效时，结果为 `alreadyApplied`；任一操作冲突时整个批次不提交，结果为 `conflict` 并指出第一个冲突的操作；其余情况为 `apply`，已生效的操作不产生变更，但仍提供 ID 映射。
- `latest` 为 `null`（资源不存在）时，在空树上重放：创建类操作走 `create()`，引用已有节点的操作会因节点不存在而冲突。
- `FavoritesUncertain` 状态下的“重新核对”按钮再次调用同一个 `commitOperations`，这是安全的（7.5）。

#### 7.4.4 各操作的重放规则

位置参数为 `{ parentId, afterId }`：`parentId` 为根、已有 ID 或本批次的临时 ID；`afterId` 为前一个兄弟节点 ID，`null` 表示放在最前。`afterId` 指向的节点在最新数据中已不在该父节点下时，放到父节点末尾，不视为冲突，因为顺序只影响显示。所有名称比较都先做去首尾空白与 NFC 规范化。

| 操作 | 在最新数据上必须满足的前提 | 判定为已生效 | 前提不满足时 |
| --- | --- | --- | --- |
| `createFolder(位置, 名称, 临时ID)` | 父节点存在且为文件夹或根；无同名兄弟；深度、总数在上限内 | 无法精确判定（文件夹没有可识别的内容） | 同名兄弟已存在：冲突，提供“使用已有文件夹”或“改名”；父节点不存在：冲突 |
| `createFavorite(位置, 名称, 临时ID, 查询[])` | 同上 | 同名兄弟是收藏入口，且其内容包含本操作的全部查询 UUID：已生效，临时 ID 映射到该入口 | 同名但不含这些 UUID：冲突，提供“追加到已有入口”或“改名”；查询为 0 条的空入口同名时按 `createFolder` 处理 |
| `appendQuery(入口ID, 查询)` | 入口存在且为收藏入口；内容可解码；追加后不超过 20 条 | 内容中已有该查询 UUID | 入口已删除：冲突，可另选位置；已满 20 条：冲突 |
| `replaceQuery(入口ID, 查询UUID, 新查询)` | 该 UUID 的查询存在，且与基础快照中的这条查询相同 | 该 UUID 的查询已等于新查询 | 查询已删除或已被其他窗口修改：冲突，展示服务器版本 |
| `editFavoriteQueries(入口ID, 新查询列表)` | 该入口内容 Key 的原始字符串与基础快照相同 | 最新内容解码后的查询列表与新列表完全相同 | 已被其他窗口修改：冲突，展示服务器版本，可“在最新版本上重新编辑”或“另存为新收藏入口” |
| `renameNode(ID, 新名称)` | 节点存在；当前名称仍是基础快照中的名称；无同名兄弟 | 名称已等于新名称 | 已被其他窗口改成别的名字，或出现同名兄弟：冲突 |
| `moveNode(ID, 目标位置)` | 节点与目标父节点存在；目标是文件夹或根；不是自身或后代；目标父节点下无同名；深度在上限内 | 已位于目标父节点且紧随 `afterId` | 任一前提不满足：冲突，提示结构已变化 |
| `deleteFavorite(ID)` | 内容 Key 的原始字符串与基础快照相同 | 节点已不存在 | 内容已被修改：冲突，展示最新查询数并要求重新确认删除 |
| `deleteFolder(ID)` | 文件夹没有任何子节点 | 节点已不存在 | 出现了子节点：冲突，拒绝删除 |

补充说明：

- `appendQuery` 不关心其他窗口对同一入口其他查询的修改，直接追加到最新列表末尾；两个窗口同时向同一入口追加，两条查询都会保留。
- 不同收藏入口、不同文件夹上的修改互不影响，重放总能自动完成。
- ID 分配：重放时按操作顺序为新建节点依次分配 `latest.max_tree_node_id + 1`、`+ 2`……，同时更新计数器，并记录“临时 ID → 正式 ID”映射；后续操作中引用的临时 ID 按映射解析。临时 ID 不得出现在提交的数据中，校验函数负责拒绝。
- 判断内容是否被他人修改时，比较的是基础快照与最新快照中同一内容 Key 的原始 Base64 字符串：只要没有人写过这个 Key，字符串就完全相同。
- 冲突处理界面永远不提供“强制覆盖服务器数据”。

#### 7.4.5 示例

**示例 1：两个窗口同时新建收藏入口（ID 重复）**

```text
t0  窗口 A、B 都已读取：resourceVersion=100，max_tree_node_id=5
t1  A 新建“接口延迟”：在 RV=100 的树上分配 ID 6 → PATCH(RV=100) → 成功，RV=101
t2  B 新建“错误率”：在 RV=100 的树上分配 ID 6 → PATCH(RV=100) → 409 Conflict，服务器数据不变
t3  B 重新读取：RV=101，max_tree_node_id=6，树中已有 6=接口延迟
t4  B 在新树上重放“新建 错误率”：父节点仍在、无同名 → 分配 ID 7 → PATCH(RV=101) → 成功，RV=102
t5  B 通知同浏览器其他窗口；A 收到后重新读取，看到 7=错误率
```

**示例 2：两个窗口首次保存（资源尚不存在）**

```text
t0  A、B 读取均得到 404 NotFound（资源未创建）
t1  A POST 创建，含 ID 1 → 成功，RV=1
t2  B POST 创建，含 ID 1 → 409 AlreadyExists
t3  B 重新读取：RV=1，max_tree_node_id=1
t4  B 在新树上重放，分配 ID 2 → PATCH(RV=1) → 成功
```

**示例 3：两个窗口同时向同一收藏入口追加查询**

```text
t0  A、B 都已读取：RV=200，入口 6 = [q1]
t1  A 追加 q2 → PATCH(RV=200) → 成功，RV=201，入口 6 = [q1, q2]
t2  B 追加 q3 → PATCH(RV=200) → 409
t3  B 重新读取：入口 6 = [q1, q2]；q3 的 UUID 不在其中 → 追加到末尾
t4  PATCH(RV=201) → 成功，入口 6 = [q1, q2, q3]
```

**示例 4：两个窗口同时编辑同一收藏入口的查询列表**

```text
t0  A、B 都打开入口 6 的编辑界面，基础快照中该内容 Key 的字符串为 S1
t1  A 删除 q1 并保存 → 成功，内容 Key 变为 S2
t2  B 修改 q1 的名称并保存 → 409 → 重新读取发现内容 Key 为 S2 ≠ S1
t3  B 判定冲突：保留草稿，展示服务器当前列表 [q2, q3]，
    由用户选择“在最新版本上重新编辑”或“另存为新收藏入口”
```

#### 7.4.6 减少冲突与界面提示

- **页面内串行：** 同一页面的写入进入串行队列，避免自己和自己冲突；服务端条件写入仍然必需。
- **同浏览器窗口通知：** 用 BroadcastChannel，频道名为 `vmexplorer-favorites:<namespace>:<资源名>`。提交成功后广播 `{ resourceVersion }`。收到广播且版本与本地不同时：
  - 没有打开的草稿：重新读取并刷新菜单与当前收藏入口；
  - 有打开的草稿：不改草稿和基础快照，显示提示“收藏已在其他窗口中修改，保存时会自动合并；无法合并时会请你处理”。
  - 浏览器不支持 BroadcastChannel 时跳过，不影响正确性。
- **跨浏览器、跨设备：** 窗口获得焦点或 `visibilitychange` 变为可见时，若距上次读取超过 5 秒则重新读取；打开保存、编辑、管理界面时重新读取；最终由提交时的条件写入兜底。不轮询，不接入 watch。
- **自动合并成功：** 只显示“已保存”，界面直接展示最新数据（例如分配到的 ID 不同、位置被放到末尾）。
- **冲突：** 弹出说明，写明冲突原因、服务器当前版本（内容冲突时并排展示查询列表）和可选处理方式；草稿保留。
- **多轮仍冲突（`FavoritesBusy`）：** 提示“收藏正在被其他窗口频繁修改，请稍后重试”，提供重试按钮。

### 7.5 响应丢失与超时

HTTP 超时、断连或 5xx 不代表提交一定失败，也不代表一定成功。提交循环把它们归为 `uncertain`，退避后重新读取并重放：

- 原请求已生效：重放时 7.4.4 的“已生效”判定成立（查询 UUID 已存在、名称已更新、节点已删除等），直接视为成功。
- 原请求未生效：按正常流程再提交一次。
- 原请求仍在服务端排队：它与重试请求带的是同一个资源版本前提，最多一个成功；另一个得到 409，下一轮读取后判定为已生效。

因此超时后重试不会产生重复查询。例外是 `createFolder` 和空收藏入口：它们没有可识别的内容，超时后若发现同名节点已存在，无法区分是自己上次的提交还是其他窗口创建的，按冲突提示用户，并说明“可能是刚才的提交已生效”。

多轮后仍为 `uncertain`（例如断网）：显示“提交结果待确认”，保留草稿，提供“重新核对”按钮。不建立浏览器持久化离线队列或草稿备份；重试所需的信息只存在于当前页面内存。关闭或刷新页面后以服务器状态为准，不承诺恢复未提交草稿。

### 7.6 页面内存缓存与服务器变更

首次加载从服务器取得资源，只解码菜单，打开收藏入口时再解码相应内容。内容的页面内存缓存以“身份作用域 + 树节点 ID + 内容 Key 原始字符串”为键，原始字符串不变就不必重新解码；页面关闭即失效，不写入任何浏览器存储。支持显式刷新。

带草稿的界面收到远端变化时只提示，不覆盖输入（7.4.6）。会话切换、收藏入口切换后的旧异步响应都必须通过 generation/request key 检查丢弃。

## 8. 查询回放与显示语义

### 8.1 表达式与时间

- 保存的是最终可执行文本，回放时每条查询语句各调用一次已有 `query-range`，不再次调用 `chart-plan` 重建表达式。
- 生成来源（`source_scope`、`source_scope_value`、`source_filters`）只用于展示，不参与回放：不据此重新生成表达式，也不把 `source_filters` 再附加到表达式上。
- 保存时生成的具体 `rate(...[5m])` 窗口等属于表达式内容；修改工具栏 Step 不会自动改写它。这与普通浏览不同（chart-plan 会随 Step 调整窗口），需在第三栏说明中注明。
- 首版不支持 Grafana Dashboard 模板变量插值；对 `$__interval`、`$__rate_interval`、`$variable` 给出需要替换为实际表达式的提示，不能悄悄传给上游或通过 `eval` 展开。
- 时间范围始终使用当前工具栏。相对范围在真正执行前重新计算，手动 Refresh 必须推进 `now`，不能沿用旧的绝对起止时间。
- **Step：** 工具栏为 `auto` 时，收藏回放向 `query-range` 传空字符串。后端会取 1m；若时间范围内点数超过 1000（`CHART_MAX_DATA_POINTS`），则升到下一档整齐步长（`niceSteps`）。界面显示响应中的实际 Step。chart-plan 按指标采样间隔推算 Step 的逻辑依赖单个指标选择器，不适用于任意表达式；首版不为此修改 Go 代码。用户选择了具体 Step 时原样传递，后端仍可能为控制点数而升档，以响应为准。
- 提交前在前端验证查询定义的结构；“试运行”是显式动作。查询无数据、数据源临时无权限或上游不通不应阻止向 Grafana 服务器保存有效定义；语法错误由试运行反馈并保留文本。User Storage 的登录、写入权限和服务器提交仍是保存成功的必要条件。

### 8.2 单位

存储 Grafana unit ID，使用 Grafana 单位选择器或明确映射；UI 可显示中文/英文名称，但不把显示文案作为持久化协议。

| 含义 | 建议 unit ID | 说明 |
| --- | --- | --- |
| 无单位 | `none` | 原始数值 |
| 字节 | `bytes` | 与十进制 `decbytes` 区分 |
| 秒 / 毫秒 | `s` / `ms` | 由表达式原始值的单位决定 |
| 百分比 0～100 | `percent` | 例如 25 显示为 25% |
| 比率 0～1 | `percentunit` | 例如 0.25 显示为 25% |

单位只决定格式化，不隐式乘除原始数据。原 `ChartPlan.unit` 的 `bytes/s`、`s/min`、`%` 等必须经适配转换，不能直接假定都是 Grafana unit ID。现有 `ChartPanel.tsx` 中的 `grafanaUnit()` 与 `splitRateUnit()` 是转换逻辑的参考，抽取到 `units.ts` 后两边共用；速率单位与自定义后缀在支持的宿主上验证。

保存热图时，桶边界的单位与桶计数/速率的单位是两个维度：分别保存 `heatmap_bucket_unit_id` 与 `heatmap_value_unit_id`。不能用“延迟单位”去格式化计数，也不能仅凭来源指标名决定单位。

### 8.3 图形与多序列

- 每条查询语句沿用保存时的 `visualization`，手写新语句默认 timeseries。
- timeseries 显示该语句返回的全部受限序列及可辨识图例；禁止复用现有 `.slice(0, 1)` 路径而静默丢数据。
- 首版可设每个图形区显示上限 100 条序列并明确提示；后端 1000 条上限和响应字节限制仍生效。前端显示上限不能声称降低了已发生的上游查询成本。
- stat 使用清晰的归约规则，首版为每条序列的 last non-null；多序列逐项显示，不擅自求和。
- heatmap 要求符合现有桶标签结构；不满足时提示形状不兼容并允许切换 timeseries。来源图形是提示，不能保证编辑后的表达式仍是直方图。
- 现有 histogram/stat 附加表格由 `chart-plan` 生成，收藏回放首版不伪造或复用旧表格；只展示当前查询结果支持的图形。完整复原分析表格属于后续明确扩展。
- 任何 min/max/avg/sum 都只针对本次返回样本，按序列计算并说明含义；sum 不是时间积分或计数器增量。

### 8.4 请求与错误

为收藏新增返回 `{ frames, meta, step }` 的查询封装，保留原 `queryChartData()` 兼容包装，或同步修改现有调用者。必须显示 `meta.truncated`、有效时间范围及实际 Step，不能只取 frames 丢弃诊断信息。

默认只执行当前选中查询，即按顺序执行它的全部查询语句；试运行与正式查询共用调度器，最多 2 个在途请求。切换查询时优先取消旧查询的全部在途请求；若当前封装暂不支持网络取消，至少丢弃旧响应并禁止它覆盖新图。单位或名称的纯展示变化无需重新查询。

401/403、数据源失效、PromQL 错误、无数据、被截断和网络超时分别展示。保存成功与执行成功是两种独立状态，不互相覆盖。

## 9. 菜单管理与可访问性

Settings 打开目录管理界面，使用同一套树模型和校验函数。支持新建文件夹/空收藏入口、重命名、删除、拖动排序与修改层级；收藏入口提供“编辑查询”，打开 3.6 的编辑界面。目录操作先进入草稿，点击“应用”后作为一个操作批次提交（7.2），取消恢复原树。

拖动具备明确的 before/inside/after 放置反馈；inside 只对文件夹有效。按稳定 ID 而非数组下标追踪拖动项，拒绝拖入自身、后代、超过深度或名称冲突的位置。拖动结果记录为 `moveNode(ID, { parentId, afterId })`。提交时基于最新树重放并再次验证，拖动时验证通过并不能保证保存时仍合法。

提供“移动到…”、上移和下移等键盘可用的替代操作。树使用 `tree/treeitem/group` 语义，支持展开、折叠、方向键和 Enter；设置按钮有可读名称；Modal 具有焦点约束和关闭后焦点恢复。删除收藏入口时明确展示其查询数量并确认；文件夹非空时直接解释不能删除。

第一栏折叠不阻塞从服务器初始化；展开后显示最新状态。展开、折叠和选中节点等临时 UI 状态只存在于页面内存；如以后要求跨会话恢复这些偏好，也必须扩展服务端模型保存。本次不新增浏览器偏好存储。已有列宽的 localStorage 实现属于现有布局功能，不用于保存任何收藏数据，也不作为本方案的持久化机制。

## 10. 异常、损坏与旧数据迁移

### 10.1 状态与恢复

| 状态 | 用户看到的行为 | 禁止行为 |
| --- | --- | --- |
| 首次使用、API 可用且资源/菜单不存在 | 展示空菜单与创建入口 | 页面加载时主动创建空远端资源 |
| API 不可用或匿名 | 服务器端收藏保存不可用，说明登录或版本条件 | 使用任何浏览器存储保存或回退，无论是否按身份隔离 |
| 读取失败 | 显示重试，允许保留已加载快照只读 | 视为空菜单后写回 |
| 保存失败（401/403/过大等） | 保留草稿，显示原因与重试或修正方法 | 提前关闭界面、显示 Saved |
| 多窗口冲突且无法自动合并 | 保留草稿，展示服务器当前版本与可选处理方式（7.4.6） | 强制覆盖服务器数据 |
| 保存响应不确定 | 自动重新读取并核对（7.5）；仍无法确认时显示“提交结果待确认”和“重新核对” | 直接追加第二份查询 |
| 菜单损坏或版本过新 | 整个收藏区域只读，允许导出原始值诊断 | 自动重置菜单或降低 ID 计数 |
| 某个收藏内容损坏 | 只标记该入口错误；其他入口可读 | 把空内容覆盖原值 |
| 收藏入口的内容 Key 缺失 | 只标记该入口错误，允许删除该入口或显式重建空内容 | 当作空入口静默写回 |
| 内容 `node_id` 与 Key 中的 ID 不符 | 标记不一致，停止该入口写入 | 随意选择一份作为正确版本 |
| 存在未被树引用的内容 Key | 报告诊断，保留原始数据 | 每次启动自动垃圾回收 |

损坏的收藏内容允许用户显式删除，删除前可导出原始值。菜单整体损坏时提供备份说明和单独的确认重置流程：先导出原始资源，再在一次条件提交中删除全部 `favorites.` 前缀的 Key 并写入新的空菜单（`max_tree_node_id = 0`）；不得删除其他 Key。其他窗口基于旧版本的写入会因资源版本变化被拒绝，之后按 7.4 在新菜单上重放或冲突。

日志仅记录操作类型、大小、耗时、错误类别和版本状态，不打印完整 PromQL、标签值或 Base64 内容。普通用户隔离由 Grafana API 执行，不用前端隐藏菜单代替授权；“仅自己可见”不承诺防止 Grafana 管理员或数据库管理员访问（已从源码确认 Grafana Admin 可访问任何用户的资源）。

### 10.2 旧 `vm_explorer_favorites` 的可选一次性导入

旧实现把指标名写入浏览器。新实现替换这条存储路径，不再读取旧列表作为日常收藏来源，也不继续更新旧 Key。以下流程仅用于用户主动导入已有历史数据；新用户不依赖它。

旧值只包含指标名，且未按用户、组织或数据源隔离。因此不能一登录就把它认定为当前用户的服务器收藏，也不能自动上传。

1. 在管理界面提供“导入旧浏览器收藏”入口；仅在用户点击后读取旧 Key。旧 Favorites 的日常浏览入口（`TreeView` 中的 Favorites 项、`MetricList` 的 `favorites` scope）与保存路径一并移除。
2. 用户确认这些条目属于自己，并选择当前可用的数据源及待迁移条目；若没有旧数据，显示空状态，不创建任何内容。
3. 为每个指标创建一条查询，名称同指标名，只含一条查询语句：表达式等于该指标名、单位为 none、图形为 timeseries、`source_metric` 为该指标名；旧数据没有记录浏览方式与过滤标签，生成来源为 UNSPECIFIED；明确说明这不会恢复旧的标签、聚合、rate 或热图语义。需要自动图表语义的条目可在原浏览页面重新 Favorite。
4. 按每个收藏入口最多 20 条分组，放入“旧收藏导入”目录；导入前检查总体容量。该目录已存在时，默认使用它（便于去重），也允许用户改名新建；不能覆盖。
5. **去重：** 导入前读取“旧收藏导入”目录下已有收藏入口的查询；若某条查询只含一条语句，且其“表达式 + 数据源 UID”与待导入条目相同，即视为重复并跳过，在结果中列出跳过数量。
6. 每批作为 `createFavorite` 操作按 7.4 提交到 Grafana 服务器；查询 UUID 在用户确认导入时生成，重试与重放中保持不变。失败不删除原始列表，已成功批次显示明确进度。
7. 不把导入进度或迁移提示状态写入浏览器；当前操作进度只存在内存。迁移成功不自动清空原始 Key，允许用户自行清理；原始数据留存仅是对历史数据的保护，不会成为新功能的数据来源。

新 Favorite 按钮始终向 Grafana 服务器提交新模型，不再修改旧指标列表。第一栏最后一项是从服务器加载的用户菜单；刷新、重新登录、跨设备读取均只使用服务器保存的内容。

## 11. 模块划分与文件修改范围

建议集中新增 `src/explorer/favorites/`，避免将存储协议和树算法继续堆入 ChartPanel 或 Explorer。

```text
proto/explorer/user_storage.proto
src/generated/explorer/user_storage_pb.ts
src/explorer/favorites/
  types.ts                      # 领域类型、操作、错误类型
  limits.ts                     # 名称、容量、层级、查询数限制
  codec.ts                      # Protobuf / gzip / Base64
  validation.ts                 # 树、内容与表达式基本校验（含拒绝临时 ID）
  treeOperations.ts             # 创建、删除、移动、排序的纯函数
  replay.ts                     # 7.4.4 的重放与“已生效”判定，纯函数
  grafanaUserStorageAdapter.ts  # 资源名、请求格式、错误分类、条件提交
  repository.ts                 # 7.4.3 的提交循环、串行队列、页面内存缓存
  crossWindow.ts                # BroadcastChannel 通知、焦点/可见性刷新
  FavoritesProvider.tsx         # 生命周期、身份隔离、状态与 hooks
  queryExecution.ts             # Step、请求调度、过期响应和结果 metadata
  units.ts                      # ChartPlan 单位到持久化单位的转换
  legacyMigration.ts            # 显式读取旧收藏、去重并一次性导入服务器
  components/
    FavoritesTree.tsx
    SaveFavoriteDialog.tsx      # 3.4，从 Favorite 打开
    EditFavoriteDialog.tsx      # 3.6，编辑收藏入口的全部查询
    ManageFavoritesDialog.tsx   # 第 9 节，Settings
    ConflictNotice.tsx          # 7.4.6 的冲突与“待确认”提示
    SavedModeColumns.tsx        # 第二～四栏；Explorer 收藏模式与“仅收藏”布局共用
    QueryStatementEditor.tsx    # 单条查询语句的编辑表单，保存与编辑界面共用
    SavedQueryList.tsx
    SavedQueryDetails.tsx
    SavedQueryPanel.tsx         # 第四栏：按顺序渲染每条查询语句的图形区
```

| 现有文件 | 计划改动 |
| --- | --- |
| `App.tsx` | 在数据源条件分支外挂载 Provider；不挂载 Explorer 的分支渲染“仅收藏”布局；收藏模式下数据源选择器只读显示所选查询的数据源，不修改 `selectedDS` |
| `Explorer.tsx` | 用明确的 browse/saved 模式区分状态并回调通知 App；把当前 `MetricScope` 与已选过滤标签传给保存界面，作为生成来源；移除 `favorites` scope 与旧 localStorage 收藏读写；保留列宽行为 |
| `TreeView.tsx` | 移除 Favorites 项；集成从服务器加载的用户菜单和 Settings 入口 |
| `MetricList.tsx` | 移除 `favorites` scope 相关的过滤与空状态文案 |
| `DetailPanel.tsx` | 删除（未被引用，且仍写 `vm_explorer_favorites`） |
| `ChartPanel.tsx` | Favorite 传递当前查询快照；抽取可复用图形组件与单位转换，保留普通浏览原有行为 |
| `api/index.ts`、必要时 `api/proto.ts` | 保留查询 metadata 与实际 Step，扩展取消能力与旧接口兼容包装；不新增存储路由 |
| `TimeRangeControl.tsx` / `App.tsx` | 在需要时修正相对范围 Refresh 的实际起止时间计算 |
| `Makefile` | 为新 proto 添加仅 TS 生成步骤，不为其生成 Go PB |
| `package.json` / lockfile | 补齐测试依赖；仅在验证需要时增加 gzip 或树拖动依赖 |
| 根目录 Jest 配置、E2E 配置 | 扩展测试设置，不直接修改 `.config` 脚手架文件 |
| 开发 Compose 配置与说明 | 增加固定 Grafana 版本的验证方式及 11.6 feature flag 说明 |

原则上不修改 `pkg/app`、`pkg/cache`、`pkg/vmclient` 或 Go 持久化结构。现有查询安全限制如发现缺陷另行列出范围，不能以新增收藏为由悄悄引入后端存储子系统。

## 12. 实施阶段与交付门槛

按依赖顺序推进，不先完成界面再发现存储协议不成立。各阶段交付可以独立评审；前一阶段的未决技术前提不能用占位成功状态掩盖。

| 阶段 | 工作内容 | 交付与完成条件 |
| --- | --- | --- |
| P0：接口与环境验证 | 固定 Grafana 版本；验证第 4.3 节；补齐可运行的前端测试基线；确认真实请求体上限与 gzip 支持 | 记录 API 样例、409/404 响应体、冲突/删除/隔离实测结果及支持矩阵；确定唯一提交协议（merge patch 或 PUT）。若条件写不成立，先修订方案 |
| P1：模型与基础层 | proto、生成、codec、限制、树纯函数、`replay`、adapter、Repository 提交循环 | 自动测试覆盖编码、ID、结构、7.4.4 全部重放规则、条件提交、超时核对；UI 无关层可独立验证 |
| P2：最小产品闭环 | Provider、服务器菜单加载、Favorite 保存、打开收藏入口、选择查询、单位与基本图形、跨窗口通知 | 清空浏览器数据后和另一个独立浏览器均能从服务器读取；两个窗口同时保存不丢数据、不重复 ID；正常查询与收藏查询互不串状态 |
| P3：完整管理与迁移 | 收藏入口编辑界面、目录拖动、重命名/删除、空目录规则、冲突提示界面、旧收藏迁移、键盘替代操作 | 初稿全部管理需求可用；失败或取消不留下半个目录或丢失旧数据 |
| P4：故障与兼容验收 | 多客户端冲突、API 不可用、损坏数据、容量、多序列与热图、宿主矩阵、子路径、无数据源布局 | 验收表全部通过；文档写明支持范围、限制和恢复方法 |

工期以 P0 结果为准，主要不确定性是 Grafana 条件写接口的宿主差异、现有图形组件的多序列改造与测试环境缺口，不预先给出缺乏依据的精确日期。

## 13. 测试与验收清单

### 13.1 自动化测试

**模型与 codec：** 中文/emoji/换行、空树/空收藏入口、多个查询与多条查询语句、语句数为 0 或超过 10 被拒绝、uint64 超过 JS 安全整数范围、最大深度、未知版本、损坏 Base64/gzip/PB、解压上限、未知字段保留、单位语义与名称规范化。

**树操作：** ID 不重复且不回收、跨目录移动、排序稳定、禁止环、移动后深度超限、同名冲突、仅空文件夹可删、删除内容与菜单同步、新建收藏入口必写内容 Key、取消草稿无远端副作用。

**重放（`replay`）：** 7.4.4 表中每个操作的“前提满足 / 已生效 / 冲突”三种结果；`afterId` 消失时放到末尾；批次中部分已生效、部分冲突的组合；临时 ID 映射与拒绝持久化临时 ID；基于最新 `max_tree_node_id` 连续分配。

**Repository 与 adapter：** 用一个实现了资源版本语义的假服务器驱动两个 Repository 实例，覆盖：首次并发创建（AlreadyExists 后重放）、过期版本被拒绝后重放成功、同入口并发追加两条都保留、同入口并发编辑冲突并保留草稿、超时但实际已提交（重试判定已生效且不重复）、超时且原请求延迟落库（最多一个成功）、多轮冲突后 `FavoritesBusy`、多轮 uncertain 后 `FavoritesUncertain`、不覆盖其他业务 Key、401/403/404/409/413/429/5xx 分类、两种 404 的区分、`commit()` 拒绝空版本。

**跨窗口：** BroadcastChannel 收到新版本时无草稿则刷新、有草稿则只提示；焦点与可见性刷新的节流。

**服务器唯一持久化：** 隔离测试收藏模块，监控 localStorage、sessionStorage、IndexedDB 和 Cache Storage 的读写；正常初始化、保存、失败重试与 API 不可用时均不得写入或从这些介质恢复收藏。仅可选旧数据导入允许用户触发后读取旧 Key。页面刷新后必须重新请求服务器；失败草稿只保留内存，不能在新会话中通过浏览器存储恢复。

**组件与查询：** 当前 plan 快照预填第一条查询语句、`MetricScope` 各取值到生成来源的映射、过滤标签去空与排序、修改表达式后生成来源保留、回放不附加 `source_filters`、添加/排序/删除查询语句且至少保留一条、多语句按顺序回放且各自独立显示错误、追加与替换区分、满 20 条时禁用追加、全部保存状态、数据源消失、收藏模式数据源选择器只读且不改 `selectedDS`、无数据源时“仅收藏”布局、切换身份丢弃在途响应、浏览/收藏模式切换、多序列不丢失、实际 Step/截断提示、`auto` Step 传空字符串、单位不改变原值、相对时间 Refresh、失败查询可保存、键盘操作。

测试 Mock 只能验证应用逻辑，不能证明 Grafana 原子性和隔离。上述关键协议须在真实 Grafana 测试实例中再次执行；多客户端测试必须使用独立浏览器上下文，并覆盖 A/B 普通用户隔离与组织切换。

### 13.2 端到端验收

- [ ] 从第四栏保存当前最终表达式，过滤和 rate 模式与画面一致。
- [ ] 分别从 By Name 前缀、All metrics、By Pod、By Node 保存，第三栏显示正确的浏览方式、前缀或 node 名称与过滤标签。
- [ ] 同一收藏入口追加两条不同查询，刷新并在另一浏览器登录后名称、表达式、单位及顺序一致。
- [ ] 一次 Favorite 保存含两条查询语句（不同单位或不同数据源）的查询，再次打开后第四栏按顺序显示两个图形区，各自的单位与数据源正确。
- [ ] 保存后清空全部浏览器站点数据，重新登录后仍能从 Grafana 服务器恢复菜单、查询及配置。
- [ ] 重启使用持久化数据库的 Grafana 实例后，已保存的菜单、收藏内容和自增 ID 计数器保持完整。
- [ ] 打开收藏入口，第二栏选择不同查询，第四栏分别得到正确数据源和图形；工具栏数据源选择器只读显示所选查询的数据源。
- [ ] 无数据源或某个数据源不可用时仍能打开“仅收藏”布局与管理界面并操作目录。
- [ ] 文件夹与收藏入口可重命名、排序和跨层级移动，保存后 ID 稳定。
- [ ] 非空文件夹不能删除；删除收藏入口后对应内容 Key 同时消失。
- [ ] 修改过程取消不产生远端目录；编辑已存在收藏入口失败时原内容仍完整。
- [ ] 两个独立浏览器同时新增收藏入口：ID 不重复，两者都保留。
- [ ] 两个窗口同时向同一收藏入口追加查询：两条都保留，顺序为提交顺序。
- [ ] 两个窗口同时编辑同一收藏入口：后保存者看到冲突提示，草稿保留，服务器数据未被覆盖。
- [ ] 同浏览器两个标签页：一个保存后，另一个无草稿时自动刷新，有草稿时只提示。
- [ ] 模拟写入成功但响应丢失，自动核对后不会产生重复收藏入口或查询。
- [ ] 正常保存、服务器不可用和权限不足时均不写入任何浏览器持久化介质；只有服务端确认后才显示保存成功。
- [ ] 普通用户 A/B 的菜单互不可见；切换组织或用户无旧缓存闪现。
- [ ] 手写多序列查询不会只显示第一条；截断、多序列上限有提示。
- [ ] 秒、毫秒、字节、0～1 百分比及 0～100 百分比显示正确。
- [ ] 热图保存区分桶单位与值单位；编辑为非直方图后有明确兼容提示。
- [ ] 损坏一个收藏内容不会清空整棵树；未知版本只读。
- [ ] 旧收藏仅在用户主动导入时读取；需显式选择身份归属与数据源，导入结果保存到服务器，重复导入会跳过已有条目，失败不删除原列表。
- [ ] 原 Pod/Node/Metric 浏览、标签过滤、图形类型切换、复制/Explore 链接、列宽与折叠无回归。
- [ ] 浅色/深色主题、窄屏、长名称、深层树与键盘导航可用。

### 13.3 实施后的检查命令

补齐测试依赖后执行：

```sh
make proto
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build
```

另外运行新增的真实 Grafana 集成/E2E 套件，记录准确版本和环境。`make proto` 后检查生成文件差异，避免无关 schema/toolchain 漂移混入。若实际改动涉及现有 Go 查询路径或公共协议，再执行对应 Go 测试及必要的全量回归；仅新增本文不需要运行应用构建或业务测试。

## 14. 风险与发布判断

| 风险 | 后果 | 应对与发布条件 |
| --- | --- | --- |
| SDK 静默本地回退 | 用户误以为跨设备保存成功 | 不使用 SDK 写入；明确远端 adapter、真实响应确认；不通过则不可发布写入 |
| Grafana 数据库未配置持久化 | 重启或重建容器后丢失已保存数据 | 部署检查与重启恢复测试，不用浏览器存储弥补 |
| 条件提交未验证或不被支持 | 自增 ID 重复、树或查询被覆盖 | P0 硬性完成并发/原子测试；不成立则写入保持不可用 |
| 多窗口同时写入 | ID 重复、后写覆盖先写 | 条件写入 + 在最新数据上重放（7.4）；两个独立浏览器的并发验收 |
| 超时后重试 | 重复追加查询 | 稳定查询 UUID + “已生效”判定（7.5）；不可判定时交给用户 |
| 有代码绕过 adapter 无条件写入 | 并发控制失效 | 禁止使用 `setItem()`；`commit()` 断言版本非空；代码评审检查 |
| 直接使用 alpha HTTP 路径 | Grafana 升级后接口变化 | 单点适配、固定测试矩阵、能力失败时保留原有浏览 |
| 保存接口 Key 分离但物理资源整体加载 | 资源膨胀与慢加载 | 前端执行整体配额、延迟解码、实测体积/延迟 |
| 回放继续依赖自动 chart-plan | 用户编辑后的查询被改写 | 保存文本直接执行，来源信息仅供显示 |
| 复用单序列图形 | 隐藏查询结果或错误归约 | 独立收藏渲染语义、多序列测试 |
| 数据源/组织切换 | 查询发往错误环境、缓存串用 | 保存 UID、身份作用域隔离、收藏模式数据源选择器只读显示当前绑定 |
| 迁移旧数据时猜测上下文 | 错误查询或他人本地收藏被上传 | 用户确认、明确原始指标表达式语义、去重、保留源数据 |

发布完成的标准不是“弹窗能保存一次”，而是：**初稿要求的树管理和查询保存全部可用；再次打开可以正确执行；跨设备持久化有实测证据；多窗口并发、失败和损坏不会静默丢失或重复数据。**

本计划仍需实施阶段验证的事项已经收敛为：Grafana 条件提交协议（merge patch 是否检查 `resourceVersion`）及 409/404 响应体、支持的宿主版本与组织行为、实际请求体上限、子路径部署、浏览器 gzip 能力、单位选择组件可用性。其余产品默认行为已在本文确定，不应在编码时再零散猜测。
