package vmclient

// Grafana datasource plugin IDs supported by the shared Prometheus HTTP API client.
const (
	VictoriaMetricsDatasourceType = "victoriametrics-metrics-datasource"
	PrometheusDatasourceType      = "prometheus"
)

func IsSupportedDatasourceType(datasourceType string) bool {
	return datasourceType == VictoriaMetricsDatasourceType || datasourceType == PrometheusDatasourceType
}

// SupportsMetricsQL reports whether generated queries may use VictoriaMetrics extensions.
// An omitted type preserves the original VictoriaMetrics client configuration.
func (c Config) SupportsMetricsQL() bool {
	return c.DatasourceType == "" || c.DatasourceType == VictoriaMetricsDatasourceType
}

func (c Config) UpstreamProduct() string {
	if c.DatasourceType == PrometheusDatasourceType {
		return "Prometheus"
	}
	return "VictoriaMetrics"
}
