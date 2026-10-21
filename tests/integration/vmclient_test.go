//go:build integration

package integration

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/limits"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/observability"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

// newTestClient reaches a VictoriaMetrics datasource the way the app does: through Grafana's
// datasource proxy, using a Grafana API token (a service account token with datasources:query).
//
//	VMX_GRAFANA_URL    e.g. http://localhost:3000
//	VMX_GRAFANA_TOKEN  service account token
//	VMX_DS_UID         UID of a victoriametrics-metrics-datasource
func newTestClient(t *testing.T) *vmclient.Client {
	baseURL, token, uid := os.Getenv("VMX_GRAFANA_URL"), os.Getenv("VMX_GRAFANA_TOKEN"), os.Getenv("VMX_DS_UID")
	if baseURL == "" || token == "" || uid == "" {
		t.Skip("set VMX_GRAFANA_URL, VMX_GRAFANA_TOKEN and VMX_DS_UID to run the integration tests")
	}

	lim := limits.Default()
	obs := observability.New("integration-test")
	t.Cleanup(func() { obs.Close() })

	client, err := vmclient.New(vmclient.Config{
		UID: uid,
		Credentials: func(context.Context) (string, string, error) {
			return baseURL, token, nil
		},
	}, lim, obs)
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}
	t.Cleanup(client.Close)
	return client
}

// TestIntegration_LabelValues tests against a live VictoriaMetrics instance.
// Run with: go test -tags=integration -v ./tests/integration/...
func TestIntegration_LabelValues(t *testing.T) {
	client := newTestClient(t)
	ctx := context.Background()

	// Test fetching metric names (label values for __name__)
	names, isPartial, err := client.LabelValues(ctx, "__name__", time.Time{}, time.Time{}, 100)
	if err != nil {
		t.Fatalf("LabelValues failed: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("expected at least one metric name")
	}
	t.Logf("Got %d metric names (partial=%v), first: %s", len(names), isPartial, names[0])
}

func TestIntegration_Labels(t *testing.T) {
	client := newTestClient(t)
	ctx := context.Background()

	// Test fetching label names
	labels, _, err := client.Labels(ctx, time.Time{}, time.Time{}, 1000)
	if err != nil {
		t.Fatalf("Labels failed: %v", err)
	}
	if len(labels) == 0 {
		t.Fatal("expected at least one label")
	}
	t.Logf("Got %d labels, first: %s", len(labels), labels[0])
}

func TestIntegration_QueryRange(t *testing.T) {
	client := newTestClient(t)
	ctx := context.Background()

	// First get a metric name
	names, _, err := client.LabelValues(ctx, "__name__", time.Time{}, time.Time{}, 1)
	if err != nil || len(names) == 0 {
		t.Skip("no metrics available for range query test")
	}

	// Execute a simple range query
	end := time.Now()
	start := end.Add(-1 * time.Hour)
	data, err := client.QueryRange(ctx, names[0], start, end, "1m")
	if err != nil {
		t.Fatalf("QueryRange failed: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("expected non-empty response data")
	}
	t.Logf("QueryRange returned %d bytes for metric %s", len(data), names[0])
}

func TestIntegration_Version(t *testing.T) {
	client := newTestClient(t)

	// Empty is acceptable (not every upstream serves buildinfo); an error is not.
	t.Logf("Upstream version: %q", client.GetUpstreamVersionPublic(context.Background()))
}

func TestIntegration_Metadata(t *testing.T) {
	client := newTestClient(t)
	ctx := context.Background()

	// First get a metric name
	names, _, err := client.LabelValues(ctx, "__name__", time.Time{}, time.Time{}, 1)
	if err != nil || len(names) == 0 {
		t.Skip("no metrics available for metadata test")
	}

	// Fetch metadata for the first metric
	metadata, err := client.Metadata(ctx, names[0])
	if err != nil {
		t.Logf("Metadata failed (may be expected if metric has no metadata): %v", err)
		return
	}
	t.Logf("Metadata for %s: %d entries", names[0], len(metadata))
}
