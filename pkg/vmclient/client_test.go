package vmclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/limits"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/observability"
)

func TestBuildURL(t *testing.T) {
	c := &Client{config: Config{UID: "vm-local"}}

	tests := []struct {
		name     string
		baseURL  string
		apiPath  string
		query    map[string]string
		expected string
	}{
		{
			name:     "simple path",
			baseURL:  "http://grafana:3000",
			apiPath:  "/api/v1/labels",
			expected: "http://grafana:3000/api/datasources/proxy/uid/vm-local/api/v1/labels",
		},
		{
			name:     "trailing slash and sub path in the Grafana URL",
			baseURL:  "https://example.com/grafana/",
			apiPath:  "/api/v1/query",
			expected: "https://example.com/grafana/api/datasources/proxy/uid/vm-local/api/v1/query",
		},
		{
			name:    "with query params",
			baseURL: "http://grafana:3000",
			apiPath: "/api/v1/label/__name__/values",
			query: map[string]string{
				"start": "1609459200",
				"end":   "1609545600",
			},
			expected: "http://grafana:3000/api/datasources/proxy/uid/vm-local/api/v1/label/__name__/values?end=1609545600&start=1609459200",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var q url.Values
			if tt.query != nil {
				q = url.Values{}
				for k, v := range tt.query {
					q.Set(k, v)
				}
			}
			if got := c.BuildURL(tt.baseURL, tt.apiPath, q); got != tt.expected {
				t.Fatalf("expected %q, got %q", tt.expected, got)
			}
		})
	}
}

func TestBuildURLEscapesUID(t *testing.T) {
	c := &Client{config: Config{UID: "a/b c"}}
	got := c.BuildURL("http://g", "/api/v1/labels", nil)
	want := "http://g/api/datasources/proxy/uid/a%2Fb%20c/api/v1/labels"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func newClient(t *testing.T, baseURL, token string) *Client {
	t.Helper()
	obs := observability.New("test")
	t.Cleanup(obs.Close)
	c, err := New(Config{
		UID: "vm-local",
		Credentials: func(context.Context) (string, string, error) {
			return baseURL, token, nil
		},
	}, limits.Default(), obs)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestLabelValuesGoesThroughGrafanaProxyWithServiceAccount(t *testing.T) {
	var gotPath, gotAuth, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotQuery = r.URL.Path, r.Header.Get("Authorization"), r.URL.RawQuery
		_, _ = w.Write([]byte(`{"status":"success","data":["up","process_cpu_seconds_total"]}`))
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "sa-token")
	names, partial, err := c.LabelValues(context.Background(), "__name__", nil,
		time.Unix(1609459200, 0), time.Unix(1609545600, 0), 50)
	if err != nil {
		t.Fatalf("LabelValues: %v", err)
	}
	if partial || len(names) != 2 || names[0] != "up" {
		t.Fatalf("unexpected result: %v partial=%v", names, partial)
	}
	if want := "/api/datasources/proxy/uid/vm-local/api/v1/label/__name__/values"; gotPath != want {
		t.Fatalf("path: expected %q, got %q", want, gotPath)
	}
	if gotAuth != "Bearer sa-token" {
		t.Fatalf("Authorization: got %q", gotAuth)
	}
	for _, part := range []string{"start=1609459200", "end=1609545600", "limit=50"} {
		if !strings.Contains(gotQuery, part) {
			t.Fatalf("query %q is missing %q", gotQuery, part)
		}
	}
}

func TestUpstreamErrorHints(t *testing.T) {
	tests := []struct {
		status int
		hint   string
	}{
		{http.StatusUnauthorized, "service account"},
		{http.StatusForbidden, "datasources:query"},
		{http.StatusNotFound, "not found"},
		{http.StatusBadGateway, "HTTP 502"},
	}
	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "nope", tt.status)
			}))
			defer srv.Close()

			_, _, err := newClient(t, srv.URL, "t").Labels(context.Background(), time.Time{}, time.Time{}, 0)
			var ue *UpstreamError
			if !errors.As(err, &ue) || ue.StatusCode != tt.status {
				t.Fatalf("expected UpstreamError %d, got %v", tt.status, err)
			}
			if !strings.Contains(err.Error(), tt.hint) {
				t.Fatalf("error %q should mention %q", err, tt.hint)
			}
			if !strings.Contains(err.Error(), "/api/v1/labels") || !strings.Contains(err.Error(), "nope") {
				t.Fatalf("error %q should name the failing upstream path and carry the response body", err)
			}
		})
	}
}

func TestMissingServiceAccountIsReported(t *testing.T) {
	// No Grafana config in the context: the default credentials must fail clearly, not panic.
	c, err := New(Config{UID: "vm-local"}, limits.Default(), observability.New("test"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer c.Close()

	_, _, err = c.Labels(context.Background(), time.Time{}, time.Time{}, 0)
	if !errors.Is(err, ErrNoServiceAccount) {
		t.Fatalf("expected ErrNoServiceAccount, got %v", err)
	}
}

func TestNewRequiresUID(t *testing.T) {
	if _, err := New(Config{}, limits.Default(), observability.New("test")); err == nil {
		t.Fatal("expected an error for an empty datasource UID")
	}
}

func TestRedirectToAnotherHostIsBlocked(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the token must never be sent to a redirect target on another host")
	}))
	defer other.Close()
	grafana := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusFound)
	}))
	defer grafana.Close()

	_, _, err := newClient(t, grafana.URL, "t").Labels(context.Background(), time.Time{}, time.Time{}, 0)
	if err == nil {
		t.Fatal("expected the cross-host redirect to fail")
	}
}

func TestBuildSelector(t *testing.T) {
	tests := []struct {
		name           string
		metric         string
		includeFilters map[string][]string
		excludeFilters map[string][]string
		expectContains []string
	}{
		{
			name:           "metric only",
			metric:         "http_requests_total",
			includeFilters: nil,
			excludeFilters: nil,
			expectContains: []string{`__name__="http_requests_total"`},
		},
		{
			name:   "with include filters",
			metric: "cpu_usage",
			includeFilters: map[string][]string{
				"job":      {"node-exporter"},
				"instance": {"host1", "host2"},
			},
			excludeFilters: nil,
			expectContains: []string{`job="node-exporter"`, `instance=~`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := BuildSelector(tt.metric, tt.includeFilters, tt.excludeFilters)
			for _, expected := range tt.expectContains {
				if !contains(result, expected) {
					t.Fatalf("expected selector to contain %q, got %q", expected, result)
				}
			}
		})
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsStr(s, substr))
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
