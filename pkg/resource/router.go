package resource

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	"google.golang.org/protobuf/proto"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/limits"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/observability"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

// Router routes Resource API requests to the appropriate handler.
type Router struct {
	client   *vmclient.Client
	cache    *cache.Scope
	limits   *limits.Limits
	obs      *observability.Observability
	config   vmclient.Config
	handlers *Handlers
}

// NewRouter creates a new Resource API router. cacheScope is the datasource's share of the app's
// local cache.
func NewRouter(client *vmclient.Client, cacheScope *cache.Scope, lim *limits.Limits, obs *observability.Observability, config vmclient.Config) *Router {
	r := &Router{
		client: client,
		cache:  cacheScope,
		limits: lim,
		obs:    obs,
		config: config,
	}
	r.handlers = NewHandlers(r)
	return r
}

// HTTPHandler returns the Resource API routes as a plain http.Handler, so an app can mount
// one Router per datasource behind its own dispatcher.
func (r *Router) HTTPHandler() http.Handler {
	mux := http.NewServeMux()
	r.registerRoutes(mux)
	return mux
}

// Handler returns the CallResourceHandler for Grafana.
func (r *Router) Handler() backend.CallResourceHandler {
	return httpadapter.New(r.HTTPHandler())
}

// registerRoutes registers all Resource API routes.
func (r *Router) registerRoutes(mux *http.ServeMux) {
	// All routes are under /explorer/v1/
	mux.HandleFunc("/explorer/v1/capabilities", r.handlers.handleCapabilities)
	mux.HandleFunc("/explorer/v1/metric-index", r.handlers.handleMetricIndex)
	mux.HandleFunc("/explorer/v1/metric-types", r.handlers.handleMetricTypes)
	mux.HandleFunc("/explorer/v1/pod-groups", r.handlers.handlePodGroups)
	mux.HandleFunc("/explorer/v1/node-groups", r.handlers.handleNodeGroups)
	mux.HandleFunc("/explorer/v1/entities", r.handlers.handleEntities)
	mux.HandleFunc("/explorer/v1/facets", r.handlers.handleFacets)
	mux.HandleFunc("/explorer/v1/series", r.handlers.handleSeries)
	mux.HandleFunc("/explorer/v1/metadata", r.handlers.handleMetadata)
	mux.HandleFunc("/explorer/v1/chart-plan", r.handlers.handleChartPlan)
	mux.HandleFunc("/explorer/v1/query-range", r.handlers.handleRangeQuery)
	mux.HandleFunc("/explorer/v1/diagnostics", r.handlers.handleDiagnostics)
	mux.HandleFunc("/explorer/v1/cache", r.handlers.handleCacheStats)
	mux.HandleFunc("/explorer/v1/cache/purge", r.handlers.handleCachePurge)
}

// ============================================================================
// Request / response helpers (bodies are zstd-compressed protobuf, see pkg/wire)
// ============================================================================

// writeError writes an explorer.Error response.
func writeError(w http.ResponseWriter, code int, errCode, message string, requestID string) {
	wire.WriteError(w, code, errCode, message, requestID)
}

// writeMessage writes msg as a 200 response, or a marshal_error.
func writeMessage(w http.ResponseWriter, msg proto.Message, requestID string) {
	body, err := wire.Encode(msg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "marshal_error", "failed to encode response: "+err.Error(), requestID)
		return
	}
	wire.Write(w, http.StatusOK, body)
}

// decodePost decodes the body of a POST into msg. On failure it has already answered the request.
func (h *Handlers) decodePost(w http.ResponseWriter, r *http.Request, msg proto.Message, requestID string) bool {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only POST is supported", requestID)
		return false
	}
	if err := wire.ReadRequest(r, h.router.limits.MaxRequestBody, msg); err != nil {
		writeError(w, http.StatusBadRequest, "parse_request", "failed to parse request: "+err.Error(), requestID)
		return false
	}
	return true
}

// timeRange resolves a request range; unset ends default to the datasource's default range ending now.
func (h *Handlers) timeRange(tr *explorerpb.TimeRange) (time.Time, time.Time) {
	start := time.Now().Add(-h.router.config.DefaultTimeRange)
	end := time.Now()
	if ms := tr.GetStartMs(); ms > 0 {
		start = time.UnixMilli(ms)
	}
	if ms := tr.GetEndMs(); ms > 0 {
		end = time.UnixMilli(ms)
	}
	return start, end
}

// schemaV1 is the schema version every response carries.
func schemaV1() *explorerpb.SchemaVersion {
	return &explorerpb.SchemaVersion{Major: 1, Minor: 0}
}

// generateRequestID generates a unique request ID.
func generateRequestID() string {
	return uuid.NewString()
}

// getRequestContext extracts the request context with org info.
func getRequestContext(r *http.Request) context.Context {
	ctx := r.Context()
	// Grafana injects user and org info via the request context
	// through the plugin SDK's resource http adapter
	return ctx
}

// now returns the current time (for easy mocking in tests).
var now = func() time.Time {
	return time.Now()
}

// time import used by now()
var _ = time.Now
