package vmclient

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Exercise both decoders and every upstream endpoint through the same transport boundary.
func TestAPIsUseAuthenticatedTransport(t *testing.T) {
	apis := []struct {
		name, path, body string
		call             func(context.Context, *Client) error
	}{
		{"label values", "/label/pod/values", `{"status":"success","data":["web"]}`, func(ctx context.Context, c *Client) error {
			_, _, err := c.LabelValues(ctx, "pod", nil, time.Time{}, time.Time{}, 10)
			return err
		}},
		{"pooled label values", "/label/pod/values", `{"status":"success","data":["web"]}`, func(ctx context.Context, c *Client) error {
			v, _, err := c.LabelValuesArray(ctx, "pod", nil, time.Time{}, time.Time{}, 10)
			if v != nil {
				PutStringArray(v)
			}
			return err
		}},
		{"pooled label names", "/labels", `{"status":"success","data":["pod"]}`, func(ctx context.Context, c *Client) error {
			v, _, err := c.LabelNamesArray(ctx, nil, time.Time{}, time.Time{}, 10)
			if v != nil {
				PutStringArray(v)
			}
			return err
		}},
		{"series", "/series", `{"status":"success","data":[{"pod":"web"}]}`, func(ctx context.Context, c *Client) error {
			_, _, err := c.Series(ctx, []string{"up"}, time.Time{}, time.Time{}, 10)
			return err
		}},
		{"metadata", "/metadata", `{"status":"success","data":{}}`, func(ctx context.Context, c *Client) error {
			_, err := c.Metadata(ctx, "up")
			return err
		}},
		{"instant query", "/query", `{"status":"success","data":{"resultType":"vector","result":[]}}`, func(ctx context.Context, c *Client) error {
			_, err := c.Query(ctx, "up", time.Unix(1700000000, 0))
			return err
		}},
		{"range query", "/query_range", `{"status":"success","data":{"resultType":"matrix","result":[]}}`, func(ctx context.Context, c *Client) error {
			_, err := c.QueryRange(ctx, "up", time.Unix(1700000000, 0), time.Unix(1700000060, 0), "15s")
			return err
		}},
	}
	for _, oauth := range []bool{false, true} {
		mode := "service account"
		if oauth {
			mode = "OAuth session"
		}
		t.Run(mode, func(t *testing.T) {
			for _, api := range apis {
				t.Run(api.name, func(t *testing.T) {
					calls := 0
					path := "/api/datasources/proxy/uid/vm-local/api/v1" + api.path
					srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if oauth {
							t.Error("OAuth request used the service account")
						}
						if r.Header.Get("Authorization") != "Bearer test-token" || r.URL.Path != path {
							t.Errorf("wrong credentials or path: %s", r.URL.Path)
						}
						calls++
						_, _ = io.WriteString(w, api.body)
					}))
					defer srv.Close()
					c := newClient(t, srv.URL, "test-token")
					c.config.ForwardOAuth = oauth
					ctx := WithSessionProxy(t.Context(), func(ctx context.Context, got string) (*http.Response, error) {
						if !oauth || strings.SplitN(got, "?", 2)[0] != path {
							t.Errorf("unexpected session request: %s", got)
						}
						if _, ok := ctx.Deadline(); !ok {
							t.Error("missing upstream deadline")
						}
						calls++
						return &http.Response{StatusCode: 200, ContentLength: int64(len(api.body)), Body: io.NopCloser(strings.NewReader(api.body))}, nil
					})
					if err := api.call(ctx, c); err != nil {
						t.Fatal(err)
					}
					if calls != 1 {
						t.Fatalf("got %d requests, want 1", calls)
					}
					if oauth {
						if err := api.call(t.Context(), c); err == nil || !strings.Contains(err.Error(), "OAuth session") {
							t.Fatalf("missing session did not fail closed: %v", err)
						}
					}
				})
			}
		})
	}
}

func TestOAuthErrorsReachOptimizedLabelDecoder(t *testing.T) {
	c := newClient(t, "http://unused", "unused")
	c.config.ForwardOAuth = true
	for _, tc := range []struct {
		status     int
		body, hint string
	}{
		{400, "Authentication to data source failed", "OAuth provider"},
		{401, "Unauthorized", "current session"},
		{403, "Forbidden", "datasources:query"},
	} {
		ctx := WithSessionProxy(t.Context(), func(context.Context, string) (*http.Response, error) {
			return &http.Response{StatusCode: tc.status, ContentLength: int64(len(tc.body)), Body: io.NopCloser(strings.NewReader(tc.body))}, nil
		})
		_, _, err := c.LabelNamesArray(ctx, nil, time.Time{}, time.Time{}, 10)
		var upstream *UpstreamError
		if !errors.As(err, &upstream) || !strings.Contains(err.Error(), tc.hint) {
			t.Fatalf("wrong OAuth error: %v", err)
		}
	}
	ctx := WithSessionProxy(t.Context(), func(ctx context.Context, _ string) (*http.Response, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	c.config.Timeout = time.Millisecond
	if _, _, err := c.LabelNamesArray(ctx, nil, time.Time{}, time.Time{}, 10); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected request timeout, got %v", err)
	}
}
