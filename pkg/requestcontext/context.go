// Package requestcontext carries Grafana request metadata across the plugin's HTTP calls.
// Plugin settings and credentials stay in Go context; they are never serialized as headers.
package requestcontext

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

type headersKey struct{}

// Only request metadata has cross-request meaning. In particular, incoming Authorization,
// Cookie, X-DS-Authorization, HTTP hop headers and the binary body's encoding must not be
// copied into a new Grafana API request authenticated with the plugin service account.
var forwarded = map[string]bool{
	"X-Grafana-Id": true, "X-Grafana-User": true, "X-Grafana-Org-Id": true,
	"X-Grafana-Device-Id": true, "X-Grafana-Plugin-Id": true,
	"X-Grafana-Query-Group-Id": true, "X-Grafana-Panel-Id": true,
	"X-Grafana-Dashboard-Uid": true, "X-Grafana-Datasource-Uid": true,
	"X-Dashboard-Uid": true, "X-Panel-Id": true, "X-Datasource-Uid": true,
	"X-Request-Id": true, "X-Correlation-Id": true,
	"Traceparent": true, "Tracestate": true, "Baggage": true,
	"Accept-Language": true, "Referer": true, "User-Agent": true, "X-Grafana-Referer": true,
}

// Capture preserves the original context (deadline, cancellation, SDK config and tracing),
// adds the complete PluginContext, and snapshots supported headers for this request only.
func Capture(ctx context.Context, pc backend.PluginContext, headers http.Header) context.Context {
	h := make(http.Header)
	// A Connection header may name additional hop-by-hop headers.
	blocked := make(map[string]bool)
	for k, values := range headers {
		if strings.EqualFold(k, "Connection") {
			for _, v := range values {
				for _, name := range strings.Split(v, ",") {
					blocked[http.CanonicalHeaderKey(strings.TrimSpace(name))] = true
				}
			}
		}
	}
	for k, values := range headers {
		k = http.CanonicalHeaderKey(k)
		if forwarded[k] && !blocked[k] {
			h[k] = append([]string(nil), values...)
		}
	}
	// Use trusted SDK identity instead of an incoming caller-controlled org/user header.
	h.Del("X-Grafana-Org-Id")
	h.Del("X-Grafana-User")
	if pc.OrgID > 0 {
		h.Set("X-Grafana-Org-Id", strconv.FormatInt(pc.OrgID, 10))
	}
	if pc.User != nil && pc.User.Login != "" {
		h.Set("X-Grafana-User", pc.User.Login)
	}
	if pc.PluginID != "" {
		h.Set("X-Grafana-Plugin-Id", pc.PluginID)
	}
	ctx = backend.WithPluginContext(ctx, pc)
	ctx = backend.WithUser(ctx, pc.User)
	return context.WithValue(ctx, headersKey{}, h)
}

// Apply forwards request metadata. Callers still set their own Authorization and body headers.
func Apply(req *http.Request) {
	if h, ok := req.Context().Value(headersKey{}).(http.Header); ok {
		for k, values := range h {
			req.Header[k] = append([]string(nil), values...)
		}
	}
	pc := backend.PluginConfigFromContext(req.Context())
	if pc.OrgID > 0 {
		req.Header.Set("X-Grafana-Org-Id", strconv.FormatInt(pc.OrgID, 10))
	}
	// Propagate the active SDK span when present; otherwise keep the received trace headers.
	if trace.SpanContextFromContext(req.Context()).IsValid() {
		propagation.TraceContext{}.Inject(req.Context(), propagation.HeaderCarrier(req.Header))
	}
}

// Background retains SDK/service-account configuration and organization, but drops user
// identity and request headers. Scheduled refreshes must not replay a user's token or trace.
func Background(ctx context.Context) context.Context {
	pc := backend.PluginConfigFromContext(ctx)
	pc.User = nil
	ctx = backend.WithPluginContext(context.WithoutCancel(ctx), pc)
	ctx = backend.WithUser(ctx, nil)
	ctx = trace.ContextWithSpanContext(ctx, trace.SpanContext{})
	return context.WithValue(ctx, headersKey{}, http.Header{})
}
