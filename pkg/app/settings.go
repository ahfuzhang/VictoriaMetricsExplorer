package app

import (
	json "encoding/json/v2"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
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
	// LocalCacheSize is the capacity in bytes of the in-memory cache every datasource shares.
	LocalCacheSize int

	// UpstreamTimeout bounds each request the backend sends to a datasource through Grafana.
	UpstreamTimeout time.Duration
}

// maxLocalCacheSize bounds localCacheSize, so that a typo such as "10000GB" fails at startup.
const maxLocalCacheSize = 1 << 40

// byteUnits are the units of sizes such as "512MB". All are 1024-based: KB is the same as KiB.
var byteUnits = map[string]float64{
	"": 1, "b": 1,
	"k": 1 << 10, "kb": 1 << 10, "kib": 1 << 10,
	"m": 1 << 20, "mb": 1 << 20, "mib": 1 << 20,
	"g": 1 << 30, "gb": 1 << 30, "gib": 1 << 30,
	"t": 1 << 40, "tb": 1 << 40, "tib": 1 << 40,
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
		LocalCacheSize:   cache.DefaultMaxBytes,
		UpstreamTimeout:  vmclient.DefaultTimeout,
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
		LocalCacheSize   any      `json:"localCacheSize"`   // e.g. "1GB", "512MB", or a number of bytes
		UpstreamTimeout  string   `json:"upstreamTimeout"`  // e.g. "120s", "5m"
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
	if jd.LocalCacheSize != nil {
		// A JSON number arrives as a float64, which prints as a plain count of bytes.
		size, ok := parseByteSize(fmt.Sprint(jd.LocalCacheSize))
		if !ok {
			return nil, fmt.Errorf("localCacheSize %v is not a size from 1B to 1TB, such as \"1GB\"", jd.LocalCacheSize)
		}
		s.LocalCacheSize = size
	}
	if jd.UpstreamTimeout != "" {
		d, err := time.ParseDuration(jd.UpstreamTimeout)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("upstreamTimeout %q is not a positive duration", jd.UpstreamTimeout)
		}
		s.UpstreamTimeout = d
	}
	return s, nil
}

// parseByteSize parses a size such as "1GB", "1.5gb", "512MiB" or "1073741824" (bytes) and reports
// whether it is within [1, maxLocalCacheSize].
func parseByteSize(s string) (int, bool) {
	s = strings.TrimSpace(s)
	num := strings.TrimRightFunc(s, unicode.IsLetter)
	mult, ok := byteUnits[strings.ToLower(s[len(num):])]
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(num), 64)
	if err != nil {
		return 0, false
	}
	n := f * mult
	if !(n >= 1 && n <= maxLocalCacheSize) {
		return 0, false
	}
	return int(n), true
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
