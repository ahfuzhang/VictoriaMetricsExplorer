package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/app"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

// Resource API layout (all under /api/plugins/<app id>/resources/):
//
//	GET  /explorer/v1/datasources                 VictoriaMetrics datasources the Explorer may use
//	*    /explorer/v1/ds/{uid}/{endpoint...}      the per-datasource Explorer API (capabilities, metric-index, ...)
const (
	routeDatasources = "GET /explorer/v1/datasources"
	routeScoped      = "/explorer/v1/ds/{uid}/{rest...}"
)

// Manage starts the app plugin.
func Manage(pluginID string) error {
	return app.Manage(pluginID, NewApp, app.ManageOpts{})
}

// App is the backend instance of the VictoriaMetrics Explorer app plugin. It is the only
// plugin this package ships: it holds no VictoriaMetrics URL or credentials, and reaches the
// user's existing VictoriaMetrics datasources through Grafana using its service account.
type App struct {
	backend.CallResourceHandler

	settings *Settings
	reg      *registry
	api      *grafanaAPI
}

var (
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// NewApp creates a new app instance.
func NewApp(_ context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	s, err := ParseSettings(settings)
	if err != nil {
		return nil, err
	}
	return newApp(s, vmclient.GrafanaCredentials), nil
}

func newApp(s *Settings, creds vmclient.CredentialsFunc) *App {
	a := &App{
		settings: s,
		reg:      newRegistry(s, creds),
		api:      newGrafanaAPI(creds),
	}

	mux := http.NewServeMux()
	mux.HandleFunc(routeDatasources, a.handleListDatasources)
	mux.HandleFunc(routeScoped, a.handleScoped)
	a.CallResourceHandler = httpadapter.New(mux)

	log.DefaultLogger.Info("VictoriaMetrics Explorer app instance created",
		"allowedDatasources", len(s.DatasourceUIDs))
	return a
}

// Dispose is called before a new instance is created.
func (a *App) Dispose() {
	a.reg.closeAll()
}

// CheckHealth verifies that Grafana gave the plugin a working service account and that it can
// see at least the datasource list.
func (a *App) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	list, err := a.api.listDatasources(ctx)
	if err != nil {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "cannot list datasources with the plugin service account: " + friendlyError(err),
		}, nil
	}
	n := len(a.filterDatasources(list))
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: fmt.Sprintf("VictoriaMetrics Explorer is running; %d VictoriaMetrics datasource(s) available", n),
	}, nil
}

// filterDatasources keeps VictoriaMetrics-type datasources that pass the allowlist, sorted by name.
func (a *App) filterDatasources(list []datasourceInfo) []datasourceInfo {
	out := make([]datasourceInfo, 0, len(list))
	for _, ds := range list {
		if ds.Type == vmDatasourceType && a.settings.allows(ds.UID) {
			out = append(out, ds)
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// handleListDatasources returns the VictoriaMetrics datasources the Explorer can use. Only UID,
// name and type are returned — never URLs or credentials.
func (a *App) handleListDatasources(w http.ResponseWriter, r *http.Request) {
	if !checkOrg(w, r) {
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
	if !checkOrg(w, r) {
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

	r2 := r.Clone(r.Context())
	r2.URL.Path = "/explorer/v1/" + rest
	r2.URL.RawPath = ""
	t.handler.ServeHTTP(w, r2)
}

// checkOrg refuses requests from organizations the plugin service account cannot act in.
func checkOrg(w http.ResponseWriter, r *http.Request) bool {
	pCtx := backend.PluginConfigFromContext(r.Context())
	if pCtx.OrgID != serviceAccountOrgID {
		writeError(w, http.StatusForbidden, "unsupported_org",
			fmt.Sprintf("the Explorer's service account only supports organization %d (this request is from organization %d)",
				serviceAccountOrgID, pCtx.OrgID))
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
