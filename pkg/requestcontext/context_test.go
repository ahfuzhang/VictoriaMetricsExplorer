package requestcontext

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"go.opentelemetry.io/otel/trace"
)

func TestRequestMetadataAndIdentity(t *testing.T) {
	parent, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	pc := backend.PluginContext{OrgID: 2, PluginID: "explorer", Namespace: "org-2", APIVersion: "v1", User: &backend.User{Login: "alice"}, AppInstanceSettings: &backend.AppInstanceSettings{DecryptedSecureJSONData: map[string]string{"secret": "do-not-forward"}}}
	h := http.Header{"x-grafana-id": {"signed-token"}, "X-Grafana-Org-Id": {"99"}, "X-Grafana-User": {"spoof"}, "X-Request-Id": {"a", "b"}, "Authorization": {"browser-token"}, "Cookie": {"grafana_session=secret"}, "X-DS-Authorization": {"upstream-override"}, "X-Payload-Encoding": {"zstd"}, "Connection": {"X-Correlation-Id"}, "X-Correlation-Id": {"hop"}}
	ctx := Capture(parent, pc, h)
	h["x-grafana-id"][0] = "mutated"
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://grafana/api", nil)
	Apply(req)
	if req.Header.Get("X-Grafana-Id") != "signed-token" || req.Header.Get("X-Grafana-Org-Id") != "2" || req.Header.Get("X-Grafana-User") != "alice" || len(req.Header.Values("X-Request-Id")) != 2 {
		t.Fatalf("metadata lost: %v", req.Header)
	}
	for _, key := range []string{"Authorization", "Cookie", "X-DS-Authorization", "X-Payload-Encoding", "Connection", "X-Correlation-Id"} {
		if req.Header.Get(key) != "" {
			t.Errorf("forwarded %s", key)
		}
	}
	actual := backend.PluginConfigFromContext(ctx)
	if actual.Namespace != pc.Namespace || actual.AppInstanceSettings != pc.AppInstanceSettings || actual.APIVersion != "v1" {
		t.Fatal("SDK context lost")
	}
	if _, ok := ctx.Deadline(); !ok {
		t.Fatal("deadline lost")
	}
	cancel()
	if ctx.Err() != context.Canceled {
		t.Fatal("cancellation lost")
	}
}

func TestBackgroundDropsUserAndTrace(t *testing.T) {
	sc := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}})
	ctx := Capture(trace.ContextWithSpanContext(t.Context(), sc), backend.PluginContext{OrgID: 1, User: &backend.User{Login: "alice"}}, http.Header{"X-Grafana-Id": {"token"}, "Traceparent": {"trace"}, "Baggage": {"user=alice"}})
	req, _ := http.NewRequestWithContext(Background(ctx), "GET", "http://grafana", nil)
	Apply(req)
	if len(req.Header) != 1 || req.Header.Get("X-Grafana-Org-Id") != "1" || backend.PluginConfigFromContext(req.Context()).User != nil {
		t.Fatalf("background retained user metadata: %v", req.Header)
	}
}

func TestActiveSpanPropagated(t *testing.T) {
	sc := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled})
	ctx := Capture(trace.ContextWithSpanContext(t.Context(), sc), backend.PluginContext{}, http.Header{})
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://grafana", nil)
	Apply(req)
	if req.Header.Get("Traceparent") == "" {
		t.Fatal("SDK tracing context was not injected")
	}
}
