package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// Settings holds the parsed app configuration (the app's jsonData). It never contains
// credentials: connection details live in the Grafana datasources the app explores.
type Settings struct {
	// DatasourceUIDs optionally restricts which datasources the Explorer may query. When
	// empty, every VictoriaMetrics-type datasource in the organization is available.
	//
	// The plugin queries datasources with its own service account, not with the end user's
	// identity, so Grafana's per-user datasource permissions are not enforced by the backend.
	// Set this list to bound what any Explorer user can reach.
	DatasourceUIDs []string

	// Label mappings (overridable)
	PodLabel       string
	NamespaceLabel string
	NodeLabel      string
	ClusterLabel   string

	// Time and cache
	DefaultTimeRange time.Duration
	CacheTTL         time.Duration
}

// ParseSettings extracts Settings from Grafana's AppInstanceSettings.
func ParseSettings(settings backend.AppInstanceSettings) (*Settings, error) {
	s := &Settings{
		PodLabel:         "pod",
		NamespaceLabel:   "namespace",
		NodeLabel:        "node",
		ClusterLabel:     "cluster",
		DefaultTimeRange: time.Hour,
		CacheTTL:         2 * time.Minute,
	}
	if len(settings.JSONData) == 0 {
		return s, nil
	}

	var jd struct {
		DatasourceUIDs   []string `json:"datasourceUids"`
		PodLabel         string   `json:"podLabel"`
		NamespaceLabel   string   `json:"namespaceLabel"`
		NodeLabel        string   `json:"nodeLabel"`
		ClusterLabel     string   `json:"clusterLabel"`
		DefaultTimeRange string   `json:"defaultTimeRange"` // e.g. "1h", "6h"
		CacheTTL         string   `json:"cacheTTL"`         // e.g. "2m", "5m"
	}
	if err := json.Unmarshal(settings.JSONData, &jd); err != nil {
		return nil, fmt.Errorf("parse jsonData: %w", err)
	}

	for _, uid := range jd.DatasourceUIDs {
		if uid = strings.TrimSpace(uid); uid != "" {
			s.DatasourceUIDs = append(s.DatasourceUIDs, uid)
		}
	}
	if jd.PodLabel != "" {
		s.PodLabel = jd.PodLabel
	}
	if jd.NamespaceLabel != "" {
		s.NamespaceLabel = jd.NamespaceLabel
	}
	if jd.NodeLabel != "" {
		s.NodeLabel = jd.NodeLabel
	}
	if jd.ClusterLabel != "" {
		s.ClusterLabel = jd.ClusterLabel
	}
	if jd.DefaultTimeRange != "" {
		d, err := time.ParseDuration(jd.DefaultTimeRange)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("defaultTimeRange %q is not a positive duration", jd.DefaultTimeRange)
		}
		s.DefaultTimeRange = d
	}
	if jd.CacheTTL != "" {
		d, err := time.ParseDuration(jd.CacheTTL)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("cacheTTL %q is not a positive duration", jd.CacheTTL)
		}
		s.CacheTTL = d
	}
	return s, nil
}

// allows reports whether the datasource UID passes the configured allowlist.
func (s *Settings) allows(uid string) bool {
	if len(s.DatasourceUIDs) == 0 {
		return true
	}
	for _, allowed := range s.DatasourceUIDs {
		if allowed == uid {
			return true
		}
	}
	return false
}

// labelFingerprint covers the settings that change what a cached response means.
func (s *Settings) labelFingerprint() string {
	return fmt.Sprintf("pod=%s|ns=%s|node=%s|cluster=%s", s.PodLabel, s.NamespaceLabel, s.NodeLabel, s.ClusterLabel)
}
