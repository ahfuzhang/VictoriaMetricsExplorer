// Package metricconfig loads read-only chart definitions. Metric names, expressions and
// visualization settings belong to YAML; this package only validates and binds templates.
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

const EnvDir = "VMX_METRIC_CONFIG_DIR"

type File struct {
	APIVersion int      `yaml:"apiVersion"`
	Category   Category `yaml:"category"`
	Charts     []Chart  `yaml:"charts"`
}

type Category struct {
	ID          string `yaml:"id"`
	Title       string `yaml:"title"`
	Description string `yaml:"description"`
	Order       *int   `yaml:"order"`
}

type Chart struct {
	ID            string              `yaml:"id"`
	Title         string              `yaml:"title"`
	Description   string              `yaml:"description"`
	Enabled       *bool               `yaml:"enabled"`
	Order         *int                `yaml:"order"`
	Language      string              `yaml:"language"`
	Match         Match               `yaml:"match"`
	RateWindow    string              `yaml:"rateWindow"`
	Selectors     map[string]Selector `yaml:"selectors"`
	Queries       []Query             `yaml:"queries"`
	Visualization Visualization       `yaml:"visualization"`
	Summary       *Summary            `yaml:"summary"`
}

type Match struct {
	Modes       []string `yaml:"modes"`
	MetricNames []string `yaml:"metricNames"`
}

type Selector struct {
	MetricName string    `yaml:"metricName"`
	Matchers   []Matcher `yaml:"matchers"`
}

type Matcher struct {
	Label string `yaml:"label"`
	Op    string `yaml:"op"`
	Value string `yaml:"value"`
}

type Query struct {
	RefID   string `yaml:"refId"`
	Expr    string `yaml:"expr"`
	Legend  string `yaml:"legend"`
	Axis    string `yaml:"axis"`
	Instant bool   `yaml:"instant"`
	Hidden  bool   `yaml:"hidden"`
}

// Options and FieldConfig use Grafana's native schema, so no panel-specific settings
// or metric-specific rendering rules are compiled into the backend or frontend.
type Visualization struct {
	Type        string          `yaml:"type" json:"type"`
	Height      int             `yaml:"height" json:"height,omitempty"`
	Width       int             `yaml:"width" json:"width,omitempty"`
	Axes        map[string]Axis `yaml:"axes" json:"axes,omitempty"`
	Options     map[string]any  `yaml:"options" json:"options,omitempty"`
	FieldConfig map[string]any  `yaml:"fieldConfig" json:"fieldConfig,omitempty"`
}

type Axis struct {
	UnitID   string   `yaml:"unitId" json:"unitId"`
	Label    string   `yaml:"label" json:"label,omitempty"`
	Min      *float64 `yaml:"min" json:"min,omitempty"`
	Max      *float64 `yaml:"max" json:"max,omitempty"`
	Decimals *int     `yaml:"decimals" json:"decimals,omitempty"`
}

type Summary struct {
	QueryRef string `yaml:"queryRef" json:"queryRef"`
	Reducer  string `yaml:"reducer" json:"reducer"`
}

type Catalog struct {
	Enabled bool
	Files   []File
}

var (
	idPattern     = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	namePattern   = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)
	labelPattern  = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
	refPattern    = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)
	windowPattern = regexp.MustCompile(`^[1-9][0-9]*[smh]$`)
	tokenPattern  = regexp.MustCompile(`\{\{([^{}]+)\}\}`)
)

// Load is atomic: an error never returns a partially loaded catalog.
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

// Native panel property names remain owned by Grafana, but the envelope must be
// valid before it reaches the renderer. YAML decoding already validates duplicate keys.
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

type Context struct {
	Labels   map[string]string
	Selector func(metric string, matchers []Matcher) (string, error)
}

// Render parses a template into an AST before binding selectors. Thus a raw selector,
// a selector hidden in a string, and misplaced/unknown template tokens are rejected.
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
