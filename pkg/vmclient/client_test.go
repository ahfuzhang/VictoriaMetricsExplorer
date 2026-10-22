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
		query    string
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
			name:     "with query params",
			baseURL:  "http://grafana:3000",
			apiPath:  "/api/v1/label/__name__/values",
			query:    "start=1609459200&end=1609545600",
			expected: "http://grafana:3000/api/datasources/proxy/uid/vm-local/api/v1/label/__name__/values?start=1609459200&end=1609545600",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := c.BuildURL(tt.baseURL, tt.apiPath, []byte(tt.query)); got != tt.expected {
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

func TestUpstreamErrorMessage(t *testing.T) {
	tests := []struct {
		err  UpstreamError
		want string
	}{
		{UpstreamError{StatusCode: 500}, "upstream returned HTTP 500"},
		{UpstreamError{StatusCode: 418, Path: "/api/v1/query", Body: "nope"}, "upstream returned HTTP 418 [/api/v1/query]: nope"},
		{UpstreamError{StatusCode: 404, Body: "x"}, "datasource or endpoint not found (HTTP 404); check the datasource URL in Grafana: x"},
		{UpstreamError{StatusCode: 503}, "grafana could not get an answer from the datasource's URL (HTTP 503); check that URL " +
			"and that it is reachable from the Grafana server (inside Docker, localhost is the Grafana container itself)"},
	}
	for _, tt := range tests {
		if got := tt.err.Error(); got != tt.want {
			t.Errorf("Error() = %q, want %q", got, tt.want)
		}
	}
}

func TestTruncateBody(t *testing.T) {
	if got := TruncateBody([]byte("short"), 8); got != "short" {
		t.Errorf("TruncateBody(short) = %q", got)
	}
	if got := TruncateBody([]byte("0123456789"), 4); got != "0123..." {
		t.Errorf("TruncateBody(long) = %q", got)
	}
}

func TestQueryParamsMatchURLValues(t *testing.T) {
	values := []string{"", "up", `sum by (le) (rate({__name__="a.b",x=~"^(?:1|2)$"}[5m]))`, "a b+c&d=e/f?g#h%i", "héllo\x00\xff", "~-_."}
	for _, v := range values {
		want := url.Values{"match[]": {v}}.Encode()
		q := make([]byte, 0, queryParamLen("match[]", v))
		q = appendQueryParam(q, "match[]", v)
		if string(q) != want || cap(q) != len(want)+len("&") {
			t.Errorf("appendQueryParam(%q) = %s (cap %d), want %s", v, q, cap(q), want)
		}
	}
	q := make([]byte, 0, intParamLen("start")+intParamLen("end"))
	q = appendIntParam(appendIntParam(q, "start", -1<<63), "end", 1609545600)
	if want := "start=-9223372036854775808&end=1609545600"; string(q) != want || len(q) > cap(q) {
		t.Errorf("appendIntParam = %s, want %s", q, want)
	}
}
