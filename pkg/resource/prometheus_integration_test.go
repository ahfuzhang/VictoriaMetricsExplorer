//go:build integration

package resource

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// Run the generated expression in Prometheus's real query engine, without needing a server or
// Grafana. PROMTOOL_PATH may point to promtool from an unpacked Prometheus release.
func TestPrometheusZeroCounterQuery(t *testing.T) {
	tool := os.Getenv("PROMTOOL_PATH")
	if tool == "" {
		var err error
		tool, err = exec.LookPath("promtool")
		if err != nil {
			t.Skip("set PROMTOOL_PATH or install promtool to verify PromQL with the Prometheus engine")
		}
	}

	query := zeroCounterQuery([]string{"idle_total", "busy_total", "spike_total", "job:requests_total", "missing_total"}, false)
	// The metrics deliberately share label sets. A rollup over all their names would collide after
	// Prometheus drops __name__. The brief spike also guards against losing raw samples by resampling.
	suite := fmt.Sprintf(`evaluation_interval: 15s
tests:
  - interval: 15s
    input_series:
      - series: 'idle_total{instance="a"}'
        values: '0+0x240'
      - series: 'idle_total{instance="b"}'
        values: '0+0x240'
      - series: 'busy_total{instance="a"}'
        values: '0+0x240'
      - series: 'busy_total{instance="b"}'
        values: '1+0x240'
      - series: 'spike_total{instance="a"}'
        values: '0 1 0+0x238'
      - series: 'job:requests_total{instance="a"}'
        values: '0+0x240'
    promql_expr_test:
      - expr: %s
        eval_time: 1h
        exp_samples:
          - labels: 'idle_total'
            value: 0
          - labels: 'busy_total'
            value: 1
          - labels: 'spike_total'
            value: 1
          - labels: 'job:requests_total'
            value: 0
`, strconv.Quote(query))
	path := filepath.Join(t.TempDir(), "promql.yaml")
	if err := os.WriteFile(path, []byte(suite), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, tool, "test", "rules", path).CombinedOutput(); err != nil {
		t.Fatalf("Prometheus rejected the generated query or returned incorrect results: %v\n%s\nquery: %s", err, output, query)
	}
}
