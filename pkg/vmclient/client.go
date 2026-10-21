package vmclient

import (
	"context"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/limits"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/observability"
)

// ErrNoServiceAccount means Grafana did not hand the plugin a service-account token
// (or its own URL), so the plugin cannot call back into Grafana.
var ErrNoServiceAccount = errors.New("grafana did not provide a service account token to the plugin: " +
	"enable the externalServiceAccounts feature toggle and auth.managed_service_accounts_enabled")

// CredentialsFunc returns the Grafana base URL and the service-account token used to
// reach a datasource through Grafana. It is called for every upstream request because
// Grafana supplies both values per plugin call (through the request context).
type CredentialsFunc func(ctx context.Context) (baseURL, token string, err error)

// GrafanaCredentials is the production CredentialsFunc: it reads the Grafana app URL and
// the managed service-account token that Grafana injects into the plugin request context.
func GrafanaCredentials(ctx context.Context) (string, string, error) {
	cfg := config.GrafanaConfigFromContext(ctx)
	baseURL, err := cfg.AppURL()
	if err != nil || baseURL == "" {
		return "", "", fmt.Errorf("grafana app URL unavailable: %w", ErrNoServiceAccount)
	}
	token, err := cfg.PluginAppClientSecret()
	if err != nil || token == "" {
		return "", "", ErrNoServiceAccount
	}
	return baseURL, token, nil
}

// Config holds what the per-datasource client needs. The VictoriaMetrics URL, tenant path,
// credentials and TLS settings all live in the Grafana datasource itself; this plugin only
// ever names the datasource by UID and lets Grafana's datasource proxy apply them.
type Config struct {
	// UID is the Grafana datasource UID (of a VictoriaMetrics-type datasource).
	UID string
	// OrgID is the Grafana organization the datasource belongs to (cache isolation).
	OrgID int64

	// ConfigFingerprint changes whenever the Grafana datasource config changes (cache key isolation).
	ConfigFingerprint string

	// Credentials supplies the Grafana URL and service-account token. Defaults to GrafanaCredentials.
	Credentials CredentialsFunc

	// Label mappings
	PodLabel       string
	NamespaceLabel string
	NodeLabel      string
	ClusterLabel   string

	// Time and cache
	DefaultTimeRange time.Duration
	CacheTTL         time.Duration
}

// Client queries one VictoriaMetrics datasource through Grafana's datasource proxy
// (/api/datasources/proxy/uid/<uid>/...). All upstream communication goes through this
// client — business code must not construct URLs or inject auth directly.
type Client struct {
	config     Config
	limits     *limits.Limits
	obs        *observability.Observability
	httpClient *http.Client
}

// New creates a client for one Grafana datasource.
func New(cfg Config, lim *limits.Limits, obs *observability.Observability) (*Client, error) {
	if cfg.UID == "" {
		return nil, fmt.Errorf("datasource UID is required")
	}
	if cfg.Credentials == nil {
		cfg.Credentials = GrafanaCredentials
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 100
	transport.MaxIdleConnsPerHost = 20
	transport.IdleConnTimeout = 90 * time.Second

	httpClient := &http.Client{
		Transport: transport,
		Timeout:   60 * time.Second, // todo: from config file
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Never follow a redirect to another host: the bearer token must only go to Grafana.
			if len(via) > 3 {
				return fmt.Errorf("too many redirects")
			}
			if len(via) > 0 && req.URL.Host != via[0].URL.Host {
				return fmt.Errorf("cross-host redirect blocked")
			}
			return nil
		},
	}

	return &Client{
		config:     cfg,
		limits:     lim,
		obs:        obs,
		httpClient: httpClient,
	}, nil
}

// Close releases resources.
func (c *Client) Close() {
	if t, ok := c.httpClient.Transport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}
}

// Config returns the client configuration.
func (c *Client) Config() Config {
	return c.config
}

// Limits returns the configured limits.
func (c *Client) Limits() *limits.Limits {
	return c.limits
}

// Observability returns the observability instance.
func (c *Client) Observability() *observability.Observability {
	return c.obs
}

// BuildURL constructs the Grafana datasource-proxy URL for an upstream API path.
// Only the Grafana base URL and the configured datasource UID are used — user input never
// overrides them, so the plugin cannot be pointed at an arbitrary host.
func (c *Client) BuildURL(baseURL, apiPath string, query url.Values) string {
	u := strings.TrimRight(baseURL, "/") + "/api/datasources/proxy/uid/" + url.PathEscape(c.config.UID) + apiPath
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

// Do executes an HTTP request against the datasource proxy with the service-account token,
// size limits, and error mapping.
func (c *Client) Do(ctx context.Context, method, apiPath string, query url.Values, body io.Reader) (*http.Response, error) {
	baseURL, token, err := c.config.Credentials(ctx)
	if err != nil {
		c.obs.RecordUpstreamRequest(0, "error")
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BuildURL(baseURL, apiPath, query), body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	started := time.Now()
	resp, err := c.httpClient.Do(req)
	elapsed := time.Since(started)

	if err != nil {
		c.obs.RecordUpstreamRequest(elapsed, "error")
		return nil, fmt.Errorf("request %s: %w", apiPath, err)
	}

	status := "success"
	if resp.StatusCode >= 400 {
		status = "error"
	}
	c.obs.RecordUpstreamRequest(elapsed, status)

	return resp, nil
}

// doJSON is a helper that executes a request and decodes the JSON response
// with a size limit.
func (c *Client) doJSON(ctx context.Context, method, apiPath string, query url.Values, target interface{}) error {
	resp, err := c.Do(ctx, method, apiPath, query, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Limit response body to the configured maximum
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(c.limits.MaxUpstreamBytes)))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return &UpstreamError{
			StatusCode: resp.StatusCode,
			Body:       truncateBody(body, 512),
			Path:       apiPath,
		}
	}

	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	return nil
}

// UpstreamError represents a non-200 response from the datasource (via Grafana).
type UpstreamError struct {
	StatusCode int
	Body       string
	// Path is the upstream API path that failed (e.g. /api/v1/labels); empty when unknown.
	Path string
}

func (e *UpstreamError) Error() string {
	var msg string
	switch e.StatusCode {
	case http.StatusUnauthorized:
		msg = "grafana rejected the plugin service account (HTTP 401); check that managed service accounts are enabled"
	case http.StatusForbidden:
		msg = "the plugin service account may not query this datasource (HTTP 403); it needs datasources:query"
	case http.StatusNotFound:
		msg = "datasource or endpoint not found (HTTP 404); check the datasource URL in Grafana"
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		msg = fmt.Sprintf("grafana could not get an answer from the datasource's URL (HTTP %d); check that URL "+
			"and that it is reachable from the Grafana server (inside Docker, localhost is the Grafana container itself)", e.StatusCode)
	default:
		msg = fmt.Sprintf("upstream returned HTTP %d", e.StatusCode)
	}
	if e.Path != "" {
		msg += " [" + e.Path + "]"
	}
	if e.Body != "" {
		msg += ": " + e.Body
	}
	return msg
}

func truncateBody(body []byte, max int) string {
	if len(body) <= max {
		return string(body)
	}
	return string(body[:max]) + "..."
}

// ============================================================================
// VictoriaMetrics API methods
// ============================================================================

// labelValuesResponse is the JSON response from /api/v1/label/:name/values
type labelValuesResponse struct {
	Status    string   `json:"status"`
	Data      []string `json:"data"`
	IsPartial bool     `json:"isPartial"`
	Error     string   `json:"error"`
}

// labelsResponse is the JSON response from /api/v1/labels
type labelsResponse struct {
	Status    string   `json:"status"`
	Data      []string `json:"data"`
	IsPartial bool     `json:"isPartial"`
}

// seriesResponse is the JSON response from /api/v1/series
type seriesResponse struct {
	Status    string              `json:"status"`
	Data      []map[string]string `json:"data"`
	IsPartial bool                `json:"isPartial"`
}

// metadataResponse is the JSON response from /api/v1/metadata
type metadataResponse struct {
	Status string                              `json:"status"`
	Data   map[string][]map[string]interface{} `json:"data"`
}

// queryResponse is the JSON response from /api/v1/query or /api/v1/query_range
type queryResponse struct {
	Status string         `json:"status"`
	Data   jsontext.Value `json:"data"`
}

// LabelValues returns all values for a given label name, optionally restricted to the series
// matching the given match[] selectors.
func (c *Client) LabelValues(ctx context.Context, label string, matches []string, start, end time.Time, limit int) ([]string, bool, error) {
	q := url.Values{}
	for _, m := range matches {
		q.Add("match[]", m)
	}
	if !start.IsZero() && !end.IsZero() {
		q.Set("start", fmt.Sprintf("%d", start.Unix()))
		q.Set("end", fmt.Sprintf("%d", end.Unix()))
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}

	var resp labelValuesResponse
	// URL-encode the label name
	apiPath := "/api/v1/label/" + url.PathEscape(label) + "/values"
	if err := c.doJSON(ctx, http.MethodGet, apiPath, q, &resp); err != nil {
		return nil, false, err
	}
	if resp.Status != "success" {
		return nil, resp.IsPartial, fmt.Errorf("upstream status %q: %s", resp.Status, resp.Error)
	}
	return resp.Data, resp.IsPartial, nil
}

// Labels returns all label names.
func (c *Client) Labels(ctx context.Context, start, end time.Time, limit int) ([]string, bool, error) {
	q := url.Values{}
	if !start.IsZero() && !end.IsZero() {
		q.Set("start", fmt.Sprintf("%d", start.Unix()))
		q.Set("end", fmt.Sprintf("%d", end.Unix()))
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}

	var resp labelsResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/labels", q, &resp); err != nil {
		return nil, false, err
	}
	if resp.Status != "success" {
		return nil, resp.IsPartial, fmt.Errorf("upstream status: %s", resp.Status)
	}
	return resp.Data, resp.IsPartial, nil
}

// Series returns series matching the given match[] selectors.
func (c *Client) Series(ctx context.Context, matches []string, start, end time.Time, limit int) ([]map[string]string, bool, error) {
	q := url.Values{}
	for _, m := range matches {
		q.Add("match[]", m)
	}
	if !start.IsZero() && !end.IsZero() {
		q.Set("start", fmt.Sprintf("%d", start.Unix()))
		q.Set("end", fmt.Sprintf("%d", end.Unix()))
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}

	var resp seriesResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/series", q, &resp); err != nil {
		return nil, false, err
	}
	if resp.Status != "success" {
		return nil, resp.IsPartial, fmt.Errorf("upstream status: %s", resp.Status)
	}
	return resp.Data, resp.IsPartial, nil
}

// Metadata returns metric metadata (type, help, unit).
func (c *Client) Metadata(ctx context.Context, metric string) (map[string][]map[string]interface{}, error) {
	q := url.Values{}
	if metric != "" {
		q.Set("metric", metric)
	}

	var resp metadataResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/metadata", q, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// QueryRange executes a range query and returns the raw JSON data.
func (c *Client) QueryRange(ctx context.Context, query string, start, end time.Time, step string) (jsontext.Value, error) {
	q := url.Values{}
	q.Set("query", query)
	q.Set("start", fmt.Sprintf("%d", start.Unix()))
	q.Set("end", fmt.Sprintf("%d", end.Unix()))
	q.Set("step", step)

	var resp queryResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/query_range", q, &resp); err != nil {
		return nil, err
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("upstream status: %s", resp.Status)
	}
	return resp.Data, nil
}

// Query executes an instant query.
func (c *Client) Query(ctx context.Context, query string, t time.Time) (jsontext.Value, error) {
	q := url.Values{}
	q.Set("query", query)
	if !t.IsZero() {
		q.Set("time", fmt.Sprintf("%d", t.Unix()))
	}

	var resp queryResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/query", q, &resp); err != nil {
		return nil, err
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("upstream status: %s", resp.Status)
	}
	return resp.Data, nil
}

// getUpstreamVersion tries to fetch the VictoriaMetrics version from the buildinfo endpoint.
func (c *Client) getUpstreamVersion(ctx context.Context) string {
	// VictoriaMetrics has a /api/v1/status/buildinfo endpoint
	resp, err := c.Do(ctx, http.MethodGet, "/api/v1/status/buildinfo", nil, nil)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return ""
	}
	var info struct {
		Data struct {
			Version string `json:"version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return ""
	}
	return info.Data.Version
}

// GetUpstreamVersionPublic tries to fetch the VictoriaMetrics version.
// Returns empty string if unavailable.
func (c *Client) GetUpstreamVersionPublic(ctx context.Context) string {
	return c.getUpstreamVersion(ctx)
}

// BuildSelector constructs a PromQL label selector from a metric name and filters.
func BuildSelector(metric string, includeFilters, excludeFilters map[string][]string) string {
	var parts []string
	if metric != "" {
		parts = append(parts, fmt.Sprintf("__name__=%q", metric))
	}
	for name, values := range includeFilters {
		if len(values) == 1 {
			parts = append(parts, fmt.Sprintf("%s=%q", name, values[0]))
		} else if len(values) > 1 {
			quoted := make([]string, len(values))
			for i, v := range values {
				quoted[i] = fmt.Sprintf("%q", v)
			}
			parts = append(parts, fmt.Sprintf("%s=~%s", name, strings.Join(quoted, "|")))
		}
	}
	var selector string
	if len(parts) > 0 {
		selector = "{" + strings.Join(parts, ",") + "}"
	} else {
		selector = "{}"
	}
	excludeParts := []string{}
	for name, values := range excludeFilters {
		if len(values) == 1 {
			excludeParts = append(excludeParts, fmt.Sprintf("%s!=%q", name, values[0]))
		}
	}
	for _, ep := range excludeParts {
		selector += " " + ep
	}
	return selector
}
