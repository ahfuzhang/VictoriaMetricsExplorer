package metricconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/VictoriaMetrics/metricsql"
)

const sample = `apiVersion: 1
category: {id: example, title: Example}
charts:
  - id: usage
    title: Usage
    description: Example chart
    match: {metricNames: [example_total]}
    queries:
      - refId: A
        expr: sum(rate({{selector:example_total}}[{{rateWindow}}]))
    visualization:
      type: line
      axes:
        left: {unitId: percent}
`

func loadText(t *testing.T, text string) (*Catalog, error) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "example.yaml"), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	return Load(dir)
}

func TestLoadAndStrictValidation(t *testing.T) {
	c, err := loadText(t, sample)
	if err != nil {
		t.Fatal(err)
	}
	chart := c.Files[0].Charts[0]
	if chart.RateWindow != "1m" || chart.Queries[0].Axis != "left" || chart.Language != "promql" {
		t.Fatalf("defaults not applied: %+v", chart)
	}
	for _, tc := range []struct{ name, text string }{
		{"unknown field", sample + "unexpected: true\n"},
		{"duplicate YAML key", sample + "apiVersion: 1\n"},
		{"multiple documents", sample + "---\n" + sample},
		{"raw selector", strings.Replace(sample, "{{selector:example_total}}", "example_total", 1)},
		{"string selector", strings.Replace(sample, "sum(rate({{selector:example_total}}[{{rateWindow}}]))", `label_set(vector(1), "label", "{{selector:example_total}}")`, 1)},
		{"unknown placeholder", strings.Replace(sample, "{{rateWindow}}", "{{unknown}}", 1)},
		{"missing metric", strings.Replace(sample, "{{selector:example_total}}", "{{selector:missing}}", 1)},
		{"invalid range", strings.Replace(sample, "unitId: percent", "unitId: percent, min: 10, max: 0", 1)},
		{"invalid query", strings.Replace(sample, "sum(rate(", "bad-func(", 1)},
		{"invalid native config", strings.Replace(sample, "      type: line", "      type: timeseries\n      fieldConfig: {defaults: broken}", 1)},
		{"invalid override", strings.Replace(sample, "      type: line", "      type: timeseries\n      fieldConfig: {defaults: {}, overrides: [{matcher: {id: byName}, properties: broken}]}", 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if c, err := loadText(t, tc.text); err == nil || c != nil {
				t.Fatalf("invalid file returned catalog=%v, error=%v", c, err)
			}
		})
	}
}

func TestLoadDirectoryRules(t *testing.T) {
	if c, err := Load(""); err != nil || c.Enabled {
		t.Fatalf("unset dir: %+v, %v", c, err)
	}
	if _, err := Load("relative"); err == nil {
		t.Fatal("relative dir accepted")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "subdir", "nested.yaml"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "mounted")
	if err := os.WriteFile(target, []byte(sample), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "mounted.yml")); err != nil {
		t.Fatal(err)
	}
	if c, err := Load(dir); err != nil || len(c.Files) != 1 {
		t.Fatalf("symlink loading: %+v %v", c, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "duplicate.yaml"), []byte(sample), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil {
		t.Fatal("duplicate category accepted")
	}
}

func TestImportedDashboard(t *testing.T) {
	dir, err := filepath.Abs("../../config/metrics")
	if err != nil {
		t.Fatal(err)
	}
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	charts, queries, instant, pie, stacked, rightAxis := 0, 0, 0, 0, 0, 0
	names := map[string]bool{}
	for _, file := range c.Files {
		for _, chart := range file.Charts {
			for _, name := range chart.Match.MetricNames {
				names[name] = true
			}
		}
	}
	for _, f := range c.Files {
		for _, chart := range f.Charts {
			if !chart.Matches(names, false) {
				t.Fatalf("imported chart %s is incorrectly filtered out on Prometheus", chart.ID)
			}
			charts++
			if chart.Visualization.Type == "piechart" {
				pie++
			}
			for _, q := range chart.Queries {
				expr, _, err := chart.Render(q, Context{Labels: map[string]string{"pod": "pod"}, Selector: func(name string, _ []Matcher) (string, error) { return name, nil }})
				if err != nil {
					t.Fatal(err)
				}
				ast, err := metricsql.Parse(expr)
				if err != nil {
					t.Fatal(err)
				}
				metricsql.VisitAll(ast, func(e metricsql.Expr) {
					if fn, ok := e.(*metricsql.FuncExpr); ok && (fn.Name == "rate" || fn.Name == "increase" || fn.Name == "irate") {
						rollup, ok := fn.Args[0].(*metricsql.RollupExpr)
						if !ok || rollup.Window == nil {
							t.Errorf("%s/%s: %s needs an explicit range on Prometheus", chart.ID, q.RefID, fn.Name)
						}
					}
				})
				queries++
				if q.Instant {
					instant++
				}
				if strings.Contains(q.Expr, "$") {
					t.Fatalf("unconverted dashboard variable: %s/%s", chart.ID, q.RefID)
				}
			}
			if chart.Visualization.Type == "timeseries" {
				d := chart.Visualization.FieldConfig["defaults"].(map[string]any)
				custom := d["custom"].(map[string]any)
				if custom["stacking"].(map[string]any)["mode"] == "normal" {
					stacked++
				}
			}
			for _, override := range chart.Visualization.FieldConfig["overrides"].([]any) {
				for _, property := range override.(map[string]any)["properties"].([]any) {
					p := property.(map[string]any)
					if p["id"] == "custom.axisPlacement" && p["value"] == "right" {
						rightAxis++
					}
				}
			}
		}
	}
	if len(c.Files) != 7 || charts != 45 || queries != 83 || instant != 11 || pie != 1 || stacked != 1 || rightAxis != 2 {
		t.Fatalf("migration coverage: categories=%d charts=%d queries=%d instant=%d pie=%d stacked=%d rightAxis=%d", len(c.Files), charts, queries, instant, pie, stacked, rightAxis)
	}
}
