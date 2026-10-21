package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

// vmDatasourceType is the plugin ID of the official VictoriaMetrics datasource. The Explorer
// only works with datasources of this type; it does not ship a datasource of its own.
const vmDatasourceType = "victoriametrics-metrics-datasource"

// serviceAccountOrgID is the only organization Grafana's managed plugin service accounts
// can act in. Requests from any other org are refused rather than silently answered from org 1.
const serviceAccountOrgID int64 = 1

// maxGrafanaResponse bounds Grafana API responses read into memory.
const maxGrafanaResponse = 8 << 20

// datasourceInfo is the subset of Grafana's datasource model the app needs. Secrets are never
// part of this response, and the URL is only used for change detection — it is not sent to the browser.
type datasourceInfo struct {
	ID        int64           `json:"id"`
	UID       string          `json:"uid"`
	OrgID     int64           `json:"orgId"`
	Name      string          `json:"name"`
	Type      string          `json:"type"`
	URL       string          `json:"url"`
	IsDefault bool            `json:"isDefault"`
	Version   int             `json:"version"`
	JSONData  json.RawMessage `json:"jsonData"`
}

var (
	errDatasourceNotFound = errors.New("datasource not found")
	errDatasourceDenied   = errors.New("datasource is not available to the Explorer")
)

// grafanaAPI reads datasource metadata from Grafana with the plugin's service account.
type grafanaAPI struct {
	creds  vmclient.CredentialsFunc
	client *http.Client
}

func newGrafanaAPI(creds vmclient.CredentialsFunc) *grafanaAPI {
	return &grafanaAPI{
		creds: creds,
		client: &http.Client{
			Timeout: 15 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) > 3 || (len(via) > 0 && req.URL.Host != via[0].URL.Host) {
					return fmt.Errorf("redirect blocked")
				}
				return nil
			},
		},
	}
}

func (g *grafanaAPI) get(ctx context.Context, path string, target any) error {
	baseURL, token, err := g.creds(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := g.client.Do(req)
	if err != nil {
		return fmt.Errorf("grafana request %s: %w", path, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGrafanaResponse))
	if err != nil {
		return fmt.Errorf("read grafana response: %w", err)
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return errDatasourceNotFound
	case resp.StatusCode >= 400:
		return &vmclient.UpstreamError{StatusCode: resp.StatusCode, Body: truncate(string(body), 256)}
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode grafana response: %w", err)
	}
	return nil
}

// getDatasource looks one datasource up by UID.
func (g *grafanaAPI) getDatasource(ctx context.Context, uid string) (*datasourceInfo, error) {
	var info datasourceInfo
	if err := g.get(ctx, "/api/datasources/uid/"+url.PathEscape(uid), &info); err != nil {
		return nil, err
	}
	return &info, nil
}

// listDatasources returns every datasource the service account can read.
func (g *grafanaAPI) listDatasources(ctx context.Context) ([]datasourceInfo, error) {
	var list []datasourceInfo
	if err := g.get(ctx, "/api/datasources", &list); err != nil {
		return nil, err
	}
	return list, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
