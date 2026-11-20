package vmclient

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
	for _, api := range apis {
		t.Run(api.name, func(t *testing.T) {
			calls := 0
			path := "/api/datasources/proxy/uid/vm-local/api/v1" + api.path
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-token" || r.URL.Path != path {
					t.Errorf("wrong credentials or path: %s", r.URL.Path)
				}
				calls++
				_, _ = io.WriteString(w, api.body)
			}))
			defer srv.Close()
			c := newClient(t, srv.URL, "test-token")
			if err := api.call(t.Context(), c); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("got %d requests, want 1", calls)
			}
			c.config.ForwardOAuth = true
			if err := api.call(t.Context(), c); !errors.Is(err, ErrOAuthUnsupported) {
				t.Fatalf("expected explicit OAuth limitation, got %v", err)
			}
			if calls != 1 {
				t.Fatal("OAuth query silently used service account credentials")
			}
		})
	}
}
