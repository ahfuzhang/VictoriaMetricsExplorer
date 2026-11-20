// Package metricconfig 加载只读的图表定义。指标名、查询表达式和可视化设置都写在 YAML 中，
// 本包只负责校验配置并绑定查询模板。
package metricconfig

import (
	"bytes"
	json "encoding/json/v2"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/VictoriaMetrics/metricsql"
	"go.yaml.in/yaml/v3"
)

// EnvDir 是指定图表配置目录的环境变量名。值必须是绝对路径；为空表示不启用配置化图表。
// 该变量由 Grafana 生成：grafana.ini 中 [plugin.<插件 ID>] 段的 vmx_metric_config_dir
// 会以 GF_PLUGIN_VMX_METRIC_CONFIG_DIR 的形式只转发给本插件进程。因此不需要把插件加入
// [plugins] forward_host_env_vars —— 那会把 Grafana 进程的全部环境变量（含管理员密码、
// OAuth client secret 等）都暴露给插件。
const EnvDir = "GF_PLUGIN_VMX_METRIC_CONFIG_DIR"

// File 对应一个 YAML 配置文件：一个文件描述一个分类及其下的全部图表。
type File struct {
	// APIVersion 是配置格式的版本号，目前只支持 1。
	APIVersion int `yaml:"apiVersion"`
	// Category 是本文件描述的分类，分类 ID 在所有配置文件之间必须唯一。
	Category Category `yaml:"category"`
	// Charts 是该分类下的图表列表，不能为空；校验通过后按 Order、ID 排序。
	Charts []Chart `yaml:"charts"`
}

// Category 描述一个图表分类，界面上按分类对图表分组展示。
type Category struct {
	// ID 是分类的唯一标识，须匹配 idPattern（小写字母开头，只含小写字母、数字和 '-'）。
	ID string `yaml:"id"`
	// Title 是分类标题，必填。
	Title string `yaml:"title"`
	// Description 是分类的说明文字，可选。
	Description string `yaml:"description"`
	// Order 是分类的排序权重，越小越靠前；未设置时按 100 处理，权重相同再按 ID 排序。
	Order *int `yaml:"order"`
}

// Chart 描述一张图表，包括匹配条件、查询模板和可视化设置。
type Chart struct {
	// ID 是图表标识，在同一个文件内唯一，须匹配 idPattern。
	ID string `yaml:"id"`
	// Title 是图表标题，必填。
	Title string `yaml:"title"`
	// Description 是图表的说明文字，必填。
	Description string `yaml:"description"`
	// Enabled 表示是否启用图表；nil 视为启用，显式设为 false 时图表永远不会被匹配。
	Enabled *bool `yaml:"enabled"`
	// Order 是图表在分类内的排序权重，规则与 Category.Order 相同。
	Order *int `yaml:"order"`
	// Language 是查询语言，取值 "promql"（默认）或 "metricsql"；
	// metricsql 图表只在数据源支持 MetricsQL 时展示。
	Language string `yaml:"language"`
	// Match 是图表的匹配条件，决定图表在什么数据下展示。
	Match Match `yaml:"match"`
	// RateWindow 是替换模板占位符 {{rateWindow}} 的时间窗口，如 "30s"、"1m"、"1h"；默认 "1m"。
	RateWindow string `yaml:"rateWindow"`
	// Selectors 是选择器别名到选择器定义的映射，模板中以 {{selector:别名}} 引用；
	// 未在此处定义的别名会被当作同名指标、且不带额外匹配器。
	Selectors map[string]Selector `yaml:"selectors"`
	// Queries 是图表的查询列表，不能为空。
	Queries []Query `yaml:"queries"`
	// Visualization 是图表的可视化设置。
	Visualization Visualization `yaml:"visualization"`
	// Summary 是可选的汇总值设置；为 nil 时不展示汇总值。
	Summary *Summary `yaml:"summary"`
}

// Match 定义图表的匹配条件：只有当前数据中存在全部 MetricNames 时，图表才会展示。
type Match struct {
	// Modes 是图表适用的浏览模式，目前只支持 ["byPod"]；为空时默认取 ["byPod"]。
	Modes []string `yaml:"modes"`
	// MetricNames 是图表依赖的指标名列表：不能为空、不能重复，并且每个都必须被某条查询引用。
	MetricNames []string `yaml:"metricNames"`
}

// Selector 定义一个具名的指标选择器，绑定时展开成带标签过滤条件的 metric selector。
type Selector struct {
	// MetricName 是选择器对应的指标名，必须出现在 Match.MetricNames 中。
	MetricName string `yaml:"metricName"`
	// Matchers 是在上下文过滤条件（pod、namespace 等）之外额外追加的标签匹配器。
	Matchers []Matcher `yaml:"matchers"`
}

// Matcher 是一个标签匹配条件，例如 area="heap"。
type Matcher struct {
	// Label 是标签名，须是合法的 Prometheus 标签名，且不能是 __name__。
	Label string `yaml:"label"`
	// Op 是匹配操作符，只能是 "="、"!="、"=~"、"!~" 之一。
	Op string `yaml:"op"`
	// Value 是匹配值；操作符为正则匹配（=~、!~）时必须是合法的正则表达式。
	Value string `yaml:"value"`
}

// Query 描述图表中的一条查询。
type Query struct {
	// RefID 是查询的引用 ID，须大写字母开头且在图表内唯一；Summary.QueryRef 通过它引用查询。
	RefID string `yaml:"refId"`
	// Expr 是查询表达式模板，支持 {{rateWindow}}、{{label:角色}}、{{selector:别名}} 三种占位符；
	// 表达式中的每个指标选择器都必须写成 {{selector:别名}}，不允许直接写原始选择器。
	Expr string `yaml:"expr"`
	// Legend 是曲线的图例模板，前端会用序列的标签值替换其中的 {{标签名}}。
	Legend string `yaml:"legend"`
	// Axis 是曲线所在的 Y 轴，取值 "left"（默认）或 "right"。
	Axis string `yaml:"axis"`
	// Instant 为 true 时执行即时查询（instant query），否则执行区间查询（range query）。
	Instant bool `yaml:"instant"`
	// Hidden 为 true 时前端不执行、也不绘制这条查询。
	Hidden bool `yaml:"hidden"`
}

// Visualization 是图表的可视化设置。Options 和 FieldConfig 直接采用 Grafana 原生的 schema，
// 因此后端和前端都不需要内置任何面板专属设置或指标专属的渲染规则。
type Visualization struct {
	// Type 是图表类型，取值 line、stacked、dual_axis、timeseries、stat、piechart 之一。
	Type string `yaml:"type" json:"type"`
	// Height 是图表高度（像素），范围 0..2000；0 表示使用前端默认高度 300。
	Height int `yaml:"height" json:"height,omitempty"`
	// Width 是图表宽度（一行共 24 栏），范围 0..24；0 表示占满整行。
	Width int `yaml:"width" json:"width,omitempty"`
	// Axes 是 Y 轴设置，键只能是 "left" 或 "right"；与 FieldConfig 至少要设置一个。
	// 设置了 Axes 时，查询用到的每一侧 Y 轴都必须在这里有定义。
	Axes map[string]Axis `yaml:"axes" json:"axes,omitempty"`
	// Options 是 Grafana 面板原生的 options，原样透传给前端。
	Options map[string]any `yaml:"options" json:"options,omitempty"`
	// FieldConfig 是 Grafana 面板原生的 fieldConfig，只允许 defaults 和 overrides 两个字段。
	FieldConfig map[string]any `yaml:"fieldConfig" json:"fieldConfig,omitempty"`
}

// Axis 描述一侧 Y 轴的显示设置。
type Axis struct {
	// UnitID 是 Grafana 的单位 ID（如 bytes、percent），必填。
	UnitID string `yaml:"unitId" json:"unitId"`
	// Label 是坐标轴标题，可选。
	Label string `yaml:"label" json:"label,omitempty"`
	// Min 是坐标轴最小值，可选；必须是有限数，且与 Max 同时设置时须小于 Max。
	Min *float64 `yaml:"min" json:"min,omitempty"`
	// Max 是坐标轴最大值，可选；必须是有限数。
	Max *float64 `yaml:"max" json:"max,omitempty"`
	// Decimals 是显示的小数位数，可选，范围 0..10。
	Decimals *int `yaml:"decimals" json:"decimals,omitempty"`
}

// Summary 描述图表标题旁展示的汇总值。
type Summary struct {
	// QueryRef 是汇总所基于的查询的 RefID，必须引用一条已存在的查询；该查询只能返回一条序列。
	QueryRef string `yaml:"queryRef" json:"queryRef"`
	// Reducer 是汇总方式，目前只支持 "lastNotNull"（取最后一个非空的有限值）。
	Reducer string `yaml:"reducer" json:"reducer"`
}

// Catalog 是加载后的全部图表配置。
type Catalog struct {
	// Enabled 表示是否启用配置化图表，即配置目录是否非空。
	Enabled bool
	// Files 是已通过校验的配置文件，按分类的 Order、ID 排序。
	Files []File
}

var (
	// idPattern 校验分类 ID 和图表 ID：小写字母开头，只含小写字母、数字和 '-'。
	idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	// namePattern 校验指标名和选择器别名，规则与 Prometheus 指标名一致。
	namePattern = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)
	// labelPattern 校验标签名，规则与 Prometheus 标签名一致。
	labelPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
	// refPattern 校验查询的 RefID：大写字母开头，只含字母和数字。
	refPattern = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)
	// windowPattern 校验 RateWindow：正整数加 s、m、h 单位。
	windowPattern = regexp.MustCompile(`^[1-9][0-9]*[smh]$`)
	// tokenPattern 匹配查询模板中的 {{...}} 占位符，子匹配为占位符名称。
	tokenPattern = regexp.MustCompile(`\{\{([^{}]+)\}\}`)
)

// Load 从 dir 目录读取所有 .yaml/.yml 文件（不递归子目录），逐个解码、校验并按分类排序。
// dir 为空时返回未启用的空 Catalog；dir 必须是绝对路径。
// 每个文件必须且只能包含一个 YAML 文档，不允许出现未知字段，分类 ID 不能重复。
// 加载是原子的：只要出错就不会返回部分加载的 Catalog。
func Load(dir string) (*Catalog, error) {
	c := &Catalog{Enabled: dir != ""}
	if dir == "" {
		return c, nil
	}
	if !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("%s must be an absolute directory path", EnvDir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", dir, err)
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || (filepath.Ext(entry.Name()) != ".yaml" && filepath.Ext(entry.Name()) != ".yml") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		var f File
		dec := yaml.NewDecoder(bytes.NewReader(data))
		dec.KnownFields(true)
		if err := dec.Decode(&f); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		var extra any
		if err := dec.Decode(&extra); err != io.EOF {
			return nil, fmt.Errorf("%s: expected exactly one YAML document", path)
		}
		if err := f.validate(); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if seen[f.Category.ID] {
			return nil, fmt.Errorf("%s: duplicate category.id %q", path, f.Category.ID)
		}
		seen[f.Category.ID] = true
		c.Files = append(c.Files, f)
	}
	slices.SortFunc(c.Files, func(a, b File) int { return ordered(a.Category.Order, a.Category.ID, b.Category.Order, b.Category.ID) })
	return c, nil
}

// ordered 是分类和图表共用的排序比较函数：先按排序权重升序（nil 视为 100），
// 权重相同时按 ID 的字典序。返回值约定与 strings.Compare 相同。
func ordered(a *int, aid string, b *int, bid string) int {
	av, bv := 100, 100
	if a != nil {
		av = *a
	}
	if b != nil {
		bv = *b
	}
	if av < bv {
		return -1
	}
	if av > bv {
		return 1
	}
	return strings.Compare(aid, bid)
}

// validate 校验单个配置文件：版本号必须为 1，分类 ID 和标题必填，图表列表非空，
// 图表 ID 在文件内不重复，并逐个校验图表。校验通过后会就地把 Charts 按 Order、ID 排序。
func (f *File) validate() error {
	if f.APIVersion != 1 || !idPattern.MatchString(f.Category.ID) || strings.TrimSpace(f.Category.Title) == "" || len(f.Charts) == 0 {
		return fmt.Errorf("apiVersion must be 1; category.id, category.title and nonempty charts are required")
	}
	seen := map[string]bool{}
	for i := range f.Charts {
		c := &f.Charts[i]
		if seen[c.ID] {
			return fmt.Errorf("duplicate chart.id %q", c.ID)
		}
		seen[c.ID] = true
		if err := c.validate(); err != nil {
			return fmt.Errorf("chart %q: %w", c.ID, err)
		}
	}
	slices.SortFunc(f.Charts, func(a, b Chart) int { return ordered(a.Order, a.ID, b.Order, b.ID) })
	return nil
}

// validate 校验单张图表，并就地填充默认值（Language、Match.Modes、RateWindow、Query.Axis）。
// 校验内容包括：基本字段、匹配条件、选择器、每条查询模板能否用占位上下文渲染成功、
// 每个依赖指标都被查询引用、可视化设置与 Y 轴的一致性，以及汇总设置。
func (c *Chart) validate() error {
	if !idPattern.MatchString(c.ID) || strings.TrimSpace(c.Title) == "" || strings.TrimSpace(c.Description) == "" {
		return fmt.Errorf("id, title and description are required")
	}
	if c.Language == "" {
		c.Language = "promql"
	}
	if c.Language != "promql" && c.Language != "metricsql" {
		return fmt.Errorf("language must be promql or metricsql")
	}
	if len(c.Match.Modes) == 0 {
		c.Match.Modes = []string{"byPod"}
	}
	if len(c.Match.Modes) != 1 || c.Match.Modes[0] != "byPod" {
		return fmt.Errorf("match.modes must be [byPod]")
	}
	if c.RateWindow == "" {
		c.RateWindow = "1m"
	}
	if !windowPattern.MatchString(c.RateWindow) {
		return fmt.Errorf("rateWindow must be a positive duration with s, m or h")
	}
	if len(c.Match.MetricNames) == 0 || len(c.Queries) == 0 {
		return fmt.Errorf("match.metricNames and queries must not be empty")
	}
	want := map[string]bool{}
	for _, n := range c.Match.MetricNames {
		if !namePattern.MatchString(n) || want[n] {
			return fmt.Errorf("invalid or duplicate match.metricNames entry %q", n)
		}
		want[n] = true
	}
	for alias, s := range c.Selectors {
		if !namePattern.MatchString(alias) || !want[s.MetricName] {
			return fmt.Errorf("selectors.%s must reference a match.metricNames entry", alias)
		}
		for _, m := range s.Matchers {
			if !labelPattern.MatchString(m.Label) || m.Label == "__name__" || !slices.Contains([]string{"=", "!=", "=~", "!~"}, m.Op) {
				return fmt.Errorf("selectors.%s: invalid matcher", alias)
			}
			if strings.Contains(m.Op, "~") {
				if _, err := regexp.Compile(m.Value); err != nil {
					return fmt.Errorf("selectors.%s: %w", alias, err)
				}
			}
		}
	}
	refs, used, sides := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for i := range c.Queries {
		q := &c.Queries[i]
		if !refPattern.MatchString(q.RefID) || refs[q.RefID] {
			return fmt.Errorf("queries: invalid or duplicate refId %q", q.RefID)
		}
		refs[q.RefID] = true
		if q.Axis == "" {
			q.Axis = "left"
		}
		if q.Axis != "left" && q.Axis != "right" {
			return fmt.Errorf("query %s: invalid axis", q.RefID)
		}
		sides[q.Axis] = true
		_, names, err := c.Render(*q, Context{Labels: map[string]string{"pod": "pod", "node": "node", "namespace": "namespace", "cluster": "cluster"}, Selector: func(metric string, _ []Matcher) (string, error) { return metric, nil }})
		if err != nil {
			return fmt.Errorf("queries.%s.expr: %w", q.RefID, err)
		}
		for _, n := range names {
			used[n] = true
		}
	}
	for n := range want {
		if !used[n] {
			return fmt.Errorf("match.metricNames %q is not referenced by queries", n)
		}
	}
	v := &c.Visualization
	if !slices.Contains([]string{"line", "stacked", "dual_axis", "timeseries", "stat", "piechart"}, v.Type) {
		return fmt.Errorf("visualization.type is unsupported")
	}
	if v.Height < 0 || v.Height > 2000 || v.Width < 0 || v.Width > 24 {
		return fmt.Errorf("visualization height must be 0..2000 and width 0..24")
	}
	if len(v.Axes) == 0 && len(v.FieldConfig) == 0 {
		return fmt.Errorf("visualization requires axes or fieldConfig")
	}
	if err := validateFieldConfig(v.FieldConfig); err != nil {
		return err
	}
	if _, err := json.Marshal(v); err != nil {
		return fmt.Errorf("visualization must contain JSON-compatible settings: %w", err)
	}
	for side, a := range v.Axes {
		if (side != "left" && side != "right") || a.UnitID == "" {
			return fmt.Errorf("visualization.axes: invalid axis or missing unitId")
		}
		if a.Decimals != nil && (*a.Decimals < 0 || *a.Decimals > 10) {
			return fmt.Errorf("visualization.axes.%s.decimals must be 0..10", side)
		}
		for _, n := range []*float64{a.Min, a.Max} {
			if n != nil && (math.IsNaN(*n) || math.IsInf(*n, 0)) {
				return fmt.Errorf("axis bounds must be finite")
			}
		}
		if a.Min != nil && a.Max != nil && *a.Min >= *a.Max {
			return fmt.Errorf("axis min must be less than max")
		}
	}
	if len(v.Axes) > 0 {
		for side := range sides {
			if _, ok := v.Axes[side]; !ok {
				return fmt.Errorf("visualization.axes.%s is missing", side)
			}
		}
	}
	if v.Type == "dual_axis" && (!sides["left"] || !sides["right"]) {
		return fmt.Errorf("dual_axis requires queries on both axes")
	}
	if (v.Type == "line" || v.Type == "stacked") && sides["right"] {
		return fmt.Errorf("%s only supports the left axis", v.Type)
	}
	if c.Summary != nil && (!refs[c.Summary.QueryRef] || c.Summary.Reducer != "lastNotNull") {
		return fmt.Errorf("summary requires an existing queryRef and reducer lastNotNull")
	}
	return nil
}

// validateFieldConfig 校验 Grafana fieldConfig 的外层结构：只允许 defaults（对象）和
// overrides（列表）；每个 override 必须带非空 matcher.id，properties 中每项必须带非空 id。
// 面板内部的属性名仍由 Grafana 定义，这里只保证结构在交给渲染器之前是合法的；
// 重复的键已经在 YAML 解码时被拒绝。config 为 nil 时直接通过。
func validateFieldConfig(config map[string]any) error {
	if config == nil {
		return nil
	}
	for k := range config {
		if k != "defaults" && k != "overrides" {
			return fmt.Errorf("visualization.fieldConfig: unknown field %q", k)
		}
	}
	if value, ok := config["defaults"]; ok {
		if _, ok := value.(map[string]any); !ok {
			return fmt.Errorf("visualization.fieldConfig.defaults must be an object")
		}
	}
	if value, ok := config["overrides"]; ok {
		overrides, ok := value.([]any)
		if !ok {
			return fmt.Errorf("visualization.fieldConfig.overrides must be a list")
		}
		for i, value := range overrides {
			override, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf("visualization.fieldConfig.overrides[%d] must be an object", i)
			}
			matcher, ok := override["matcher"].(map[string]any)
			if !ok {
				return fmt.Errorf("visualization.fieldConfig.overrides[%d].matcher must be an object", i)
			}
			if id, ok := matcher["id"].(string); !ok || id == "" {
				return fmt.Errorf("visualization.fieldConfig.overrides[%d].matcher.id is required", i)
			}
			properties, ok := override["properties"].([]any)
			if !ok {
				return fmt.Errorf("visualization.fieldConfig.overrides[%d].properties must be a list", i)
			}
			for _, value := range properties {
				property, ok := value.(map[string]any)
				if !ok {
					return fmt.Errorf("visualization.fieldConfig override property must be an object")
				}
				if id, ok := property["id"].(string); !ok || id == "" {
					return fmt.Errorf("visualization.fieldConfig override property.id is required")
				}
			}
		}
	}
	return nil
}

// Context 是渲染查询模板时的绑定上下文，由调用方根据数据源配置和当前请求提供。
type Context struct {
	// Labels 是标签角色到实际标签名的映射（如 "pod" -> "k8s_pod"），用于替换 {{label:角色}}。
	Labels map[string]string
	// Selector 根据指标名和额外匹配器生成完整的 metric selector 字符串（含上下文过滤条件），
	// 用于替换 {{selector:别名}}；返回结果必须能解析为单个 metric selector。
	Selector func(metric string, matchers []Matcher) (string, error)
}

// Render 把查询 q 的表达式模板渲染成最终的查询语句，并返回表达式中引用到的指标名（按出现顺序）。
// 步骤：先替换 {{rateWindow}}、{{label:角色}}，再把每个 {{selector:别名}} 换成内部占位指标名；
// 然后把表达式解析成 AST，遍历其中的 metric selector，用 ctx.Selector 的结果替换占位符。
// 因为是先解析成 AST 再绑定选择器，所以原始选择器、藏在字符串里的选择器，
// 以及位置不对或未知的模板占位符都会被拒绝。
func (c *Chart) Render(q Query, ctx Context) (string, []string, error) {
	if strings.Contains(q.Expr, "vmx_config_selector_") {
		return "", nil, fmt.Errorf("reserved selector placeholder name")
	}
	selectors := map[string]Selector{}
	var tokenErr error
	s := tokenPattern.ReplaceAllStringFunc(q.Expr, func(token string) string {
		name := token[2 : len(token)-2]
		if name == "rateWindow" {
			return c.RateWindow
		}
		if role, ok := strings.CutPrefix(name, "label:"); ok {
			if label, ok := ctx.Labels[role]; ok && labelPattern.MatchString(label) {
				return label
			}
			tokenErr = fmt.Errorf("unknown label role or invalid mapping %q", role)
			return "invalid"
		}
		if alias, ok := strings.CutPrefix(name, "selector:"); ok {
			selector, found := c.Selectors[alias]
			if !found {
				selector.MetricName = alias
			}
			if !slices.Contains(c.Match.MetricNames, selector.MetricName) {
				tokenErr = fmt.Errorf("selector %q is not in match.metricNames", alias)
			}
			key := fmt.Sprintf("vmx_config_selector_%d", len(selectors))
			selectors[key] = selector
			return key
		}
		tokenErr = fmt.Errorf("unknown placeholder %s", token)
		return "invalid"
	})
	if tokenErr != nil {
		return "", nil, tokenErr
	}
	if strings.Contains(s, "{{") || strings.Contains(s, "}}") || strings.Contains(s, "$") {
		return "", nil, fmt.Errorf("unresolved template variable")
	}
	e, err := metricsql.Parse(s)
	if err != nil {
		return "", nil, err
	}
	seen := map[string]bool{}
	var names []string
	metricsql.VisitAll(e, func(e metricsql.Expr) {
		m, ok := e.(*metricsql.MetricExpr)
		if !ok || tokenErr != nil {
			return
		}
		if len(m.LabelFilterss) != 1 || len(m.LabelFilterss[0]) != 1 {
			tokenErr = fmt.Errorf("all selectors must use a selector placeholder")
			return
		}
		key := m.LabelFilterss[0][0].Value
		selector, ok := selectors[key]
		if !ok {
			tokenErr = fmt.Errorf("raw selector %q: use a selector placeholder", key)
			return
		}
		bound, err := ctx.Selector(selector.MetricName, selector.Matchers)
		if err != nil {
			tokenErr = err
			return
		}
		parsed, err := metricsql.Parse(bound)
		if err != nil {
			tokenErr = err
			return
		}
		actual, ok := parsed.(*metricsql.MetricExpr)
		if !ok {
			tokenErr = fmt.Errorf("binding must produce a metric selector")
			return
		}
		m.LabelFilterss = actual.LabelFilterss
		seen[key] = true
		names = append(names, selector.MetricName)
	})
	if tokenErr != nil {
		return "", nil, tokenErr
	}
	if len(selectors) == 0 || len(seen) != len(selectors) {
		return "", nil, fmt.Errorf("each selector placeholder must be used as a metric selector")
	}
	return string(e.AppendString(nil)), names, nil
}

// Matches 判断图表在当前数据下是否应当展示：图表未被禁用；metricsql 图表要求数据源支持
// MetricsQL（supportsMetricsQL）；并且 Match.MetricNames 中的每个指标都在 names 中存在。
func (c Chart) Matches(names map[string]bool, supportsMetricsQL bool) bool {
	if c.Enabled != nil && !*c.Enabled || c.Language == "metricsql" && !supportsMetricsQL {
		return false
	}
	for _, n := range c.Match.MetricNames {
		if !names[n] {
			return false
		}
	}
	return true
}
