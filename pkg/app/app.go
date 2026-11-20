package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/app"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/metricconfig"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/requestcontext"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

// Resource API layout (all under /api/plugins/<app id>/resources/):
//
//	GET  /explorer/v1/datasources                 Prometheus and VictoriaMetrics datasources the Explorer may use
//	*    /explorer/v1/ds/{uid}/{endpoint...}      the per-datasource Explorer API (capabilities, metric-index, ...)
const (
	routeDatasources = "GET /explorer/v1/datasources"
	routeScoped      = "/explorer/v1/ds/{uid}/{rest...}"
)

// Manage starts the app plugin.
func Manage(pluginID string) error {
	catalog, err := metricconfig.Load(os.Getenv(metricconfig.EnvDir))
	if err != nil {
		return err
	}
	log.DefaultLogger.Info("metric chart configuration loaded", "enabled", catalog.Enabled, "files", len(catalog.Files))
	return app.Manage(pluginID, func(ctx context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
		return newConfiguredApp(ctx, settings, catalog)
	}, app.ManageOpts{})
}

// App is the backend instance of the VictoriaMetrics Explorer app plugin. It is the only
// plugin this package ships: it holds no upstream URL or credentials, and reaches the
// user's existing Prometheus and VictoriaMetrics datasources through Grafana using its service account.
type App struct {
	backend.CallResourceHandler

	settings *Settings
	reg      *registry
	api      *grafanaAPI
	// ownToken is set when the app authenticates with the token from its own configuration.
	// That token belongs to the organization the configuration belongs to, so unlike Grafana's
	// managed service account (org 1 only) it serves every organization.
	ownToken bool
}

var (
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// serviceAccountTokenKey is the secureJsonData key of the service-account token an admin can set
// for Grafanas that do not give the plugin a managed service account.
const serviceAccountTokenKey = "serviceAccountToken"

// NewApp creates a new app instance. Grafana creates one per organization, with that
// organization's settings.
func NewApp(ctx context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	return newConfiguredApp(ctx, settings, &metricconfig.Catalog{})
}

func newConfiguredApp(_ context.Context, settings backend.AppInstanceSettings, catalog *metricconfig.Catalog) (instancemgmt.Instance, error) {
	s, err := ParseSettings(settings)
	if err != nil {
		return nil, err
	}
	// Without a catalog the Explorer hides Important Metrics (capabilities) and serves no charts.
	if s.ShowImportantMetrics {
		s.MetricCatalog = catalog
	}
	// A configured token wins over the managed service account: it is the admin's explicit choice,
	// and the managed account would act in org 1 whatever organization this instance serves.
	if token := strings.TrimSpace(settings.DecryptedSecureJSONData[serviceAccountTokenKey]); token != "" {
		return newApp(s, vmclient.TokenCredentials(token), true), nil
	}
	return newApp(s, vmclient.GrafanaCredentials, false), nil
}

func newApp(s *Settings, creds vmclient.CredentialsFunc, ownToken bool) *App {
	a := &App{
		settings: s,
		reg:      newRegistry(s, creds),
		api:      newGrafanaAPI(creds),
		ownToken: ownToken,
	}

	mux := http.NewServeMux()
	mux.HandleFunc(routeDatasources, a.handleListDatasources)
	mux.HandleFunc(routeScoped, a.handleScoped)
	a.CallResourceHandler = httpadapter.New(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := requestcontext.Capture(r.Context(), backend.PluginConfigFromContext(r.Context()), r.Header)
		mux.ServeHTTP(w, r.WithContext(ctx))
	}))

	credentials := "managed service account"
	if ownToken {
		credentials = "configured service account token"
	}
	log.DefaultLogger.Info("VictoriaMetrics Explorer app instance created", "credentials", credentials,
		"allowedDatasources", len(s.DatasourceUIDs), "localCacheMB", a.reg.cache.Stats().MaxBytes>>20)
	return a
}

// Dispose is called before a new instance is created.
func (a *App) Dispose() {
	a.reg.closeAll()
}

// CheckHealth verifies that Grafana gave the plugin a working service account and that it can
// see at least the datasource list.
func (a *App) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if req != nil {
		headers := make(http.Header)
		for k, v := range req.Headers {
			headers.Set(k, v)
		}
		ctx = requestcontext.Capture(ctx, req.PluginContext, headers)
	}
	list, err := a.api.listDatasources(ctx)
	if err != nil {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "cannot list datasources with the plugin service account: " + friendlyError(err),
		}, nil
	}
	const head, tail = "VictoriaMetrics Explorer is running; ", " Prometheus/VictoriaMetrics datasource(s) available"
	msg := make([]byte, 0, len(head)+bytesutil.MaxIntLen+len(tail))
	msg = strconv.AppendInt(append(msg, head...), int64(len(a.filterDatasources(list))), 10)
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: bytesutil.ToUnsafeString(append(msg, tail...)),
	}, nil
}

// filterDatasources keeps supported datasources that pass the allowlist, sorted by name.
func (a *App) filterDatasources(list []datasourceInfo) []datasourceInfo {
	out := make([]datasourceInfo, 0, len(list))
	for _, ds := range list {
		if vmclient.IsSupportedDatasourceType(ds.Type) && a.settings.allows(ds.UID) {
			out = append(out, ds)
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// handleListDatasources returns the supported datasources the Explorer can use. Only UID,
// name and type are returned — never URLs or credentials.
func (a *App) handleListDatasources(w http.ResponseWriter, r *http.Request) {
	if !a.checkOrg(w, r) {
		return
	}
	list, err := a.api.listDatasources(r.Context())
	if err != nil {
		writeGrafanaError(w, err)
		return
	}
	resp := &explorerpb.DatasourcesResponse{}
	for _, ds := range a.filterDatasources(list) {
		resp.Datasources = append(resp.Datasources, &explorerpb.DatasourceInfo{
			Uid: ds.UID, Name: ds.Name, Type: ds.Type, IsDefault: ds.IsDefault,
		})
	}
	wire.WriteMessage(w, http.StatusOK, resp)
}

// handleScoped routes /explorer/v1/ds/{uid}/{rest...} to the Explorer API of that datasource,
// rewritten to /explorer/v1/{rest}.
func (a *App) handleScoped(w http.ResponseWriter, r *http.Request) {
	if !a.checkOrg(w, r) {
		return
	}
	uid, rest := r.PathValue("uid"), r.PathValue("rest")

	// Cache inspection and purging are administrative.
	if strings.HasPrefix(rest, "cache") && !isAdmin(r) {
		writeError(w, http.StatusForbidden, "forbidden", "cache endpoints require the Admin role")
		return
	}

	pCtx := backend.PluginConfigFromContext(r.Context())
	t, err := a.reg.get(r.Context(), pCtx.OrgID, uid)
	if err != nil {
		writeGrafanaError(w, err)
		return
	}

	if t.client.Config().ForwardOAuth {
		if rest != "cache" && rest != "cache/purge" {
			writeError(w, http.StatusUnprocessableEntity, "oauth_forwarding_unsupported", vmclient.ErrOAuthUnsupported.Error())
			return
		}
	} else {
		var username string
		if pCtx.User != nil {
			username = pCtx.User.Login
		}
		if err := t.checkDatasourceAccess(r.Context(), username); err != nil {
			writeDatasourceProbeError(w, uid, err)
			return
		}
	}

	r2 := r.Clone(r.Context())
	r2.URL.Path = "/explorer/v1/" + rest
	r2.URL.RawPath = ""
	t.handler.ServeHTTP(w, r2)
}

func writeDatasourceProbeError(w http.ResponseWriter, uid string, err error) {
	if errors.Is(err, vmclient.ErrNoServiceAccount) {
		writeGrafanaError(w, err)
		return
	}

	requestID := uuid.NewString()
	log.DefaultLogger.Warn("datasource access probe failed", "uid", uid, "requestId", requestID, "error", err)
	status, code := http.StatusBadGateway, "upstream_error"
	if isDatasourceDenied(err) {
		status, code = http.StatusForbidden, "datasource_denied"
	}
	wire.WriteError(w, status, code, "datasource access probe failed: "+err.Error(), requestID)
}

// checkOrg refuses requests from organizations the plugin service account cannot act in.
func (a *App) checkOrg(w http.ResponseWriter, r *http.Request) bool {
	pCtx := backend.PluginConfigFromContext(r.Context())
	if !a.ownToken && pCtx.OrgID != serviceAccountOrgID {
		const head, mid = "the Explorer's managed service account only supports organization ", " (this request is from organization "
		const tail = "); set a service account token of this organization on the app's Configuration page"
		msg := make([]byte, 0, len(head)+len(mid)+len(tail)+2*bytesutil.MaxIntLen)
		msg = strconv.AppendInt(append(msg, head...), serviceAccountOrgID, 10)
		msg = strconv.AppendInt(append(msg, mid...), pCtx.OrgID, 10)
		writeError(w, http.StatusForbidden, "unsupported_org", bytesutil.ToUnsafeString(append(msg, tail...)))
		return false
	}
	return true
}

func isAdmin(r *http.Request) bool {
	u := backend.PluginConfigFromContext(r.Context()).User
	return u != nil && u.Role == "Admin"
}

// writeGrafanaError maps registry/Grafana lookup failures to HTTP responses.
func writeGrafanaError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errDatasourceNotFound):
		writeError(w, http.StatusNotFound, "datasource_not_found", "datasource not found")
	case errors.Is(err, errDatasourceDenied):
		writeError(w, http.StatusForbidden, "datasource_denied", err.Error())
	case errors.Is(err, vmclient.ErrNoServiceAccount):
		writeError(w, http.StatusServiceUnavailable, "no_service_account", err.Error())
	default:
		writeError(w, http.StatusBadGateway, "grafana_error", friendlyError(err))
	}
}

func friendlyError(err error) string {
	if errors.Is(err, vmclient.ErrNoServiceAccount) {
		return vmclient.ErrNoServiceAccount.Error()
	}
	return err.Error()
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	wire.WriteError(w, code, errCode, message, "")
}
