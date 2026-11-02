package resource

import (
	"strings"
	"testing"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/metricconfig"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

func TestConfiguredSelectorsIntersectScopeAndFilters(t *testing.T) {
	h := &Handlers{router: &Router{config: vmclient.Config{PodLabel: "k8s_pod", NamespaceLabel: "k8s_namespace", ClusterLabel: "cluster", NodeLabel: "node"}}}
	c := metricconfig.Chart{RateWindow: "1m", Match: metricconfig.Match{MetricNames: []string{"sample_total"}}, Selectors: map[string]metricconfig.Selector{
		"sample": {MetricName: "sample_total", Matchers: []metricconfig.Matcher{{Label: "resource", Op: "=", Value: "cpu"}, {Label: "image", Op: "!~", Value: "proxy|pause"}}},
	}}
	query := metricconfig.Query{Expr: "sum by ({{label:namespace}}) (rate({{selector:sample}}[{{rateWindow}}]))"}
	expr, _, err := c.Render(query, h.configuredContext(`api.+`, map[string][]string{"k8s_pod": {`api.1`}, "namespace": {`a\"b`}}))
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{`k8s_pod="api.1"`, `k8s_pod=~`, `resource="cpu"`, `image!~"proxy|pause"`, `by(k8s_namespace)`, `[1m]`} {
		if !strings.Contains(expr, part) {
			t.Errorf("missing %q in %s", part, expr)
		}
	}
	if strings.Contains(expr, `api.+`) {
		t.Fatalf("pod prefix was not regex escaped: %s", expr)
	}
	all, _, err := c.Render(query, h.configuredContext("", nil))
	if err != nil || !strings.Contains(all, `k8s_pod!=""`) {
		t.Fatalf("all-pod query is unscoped: %s %v", all, err)
	}
}
