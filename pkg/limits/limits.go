package limits

// Limits holds all safety limits for the datasource.
// These prevent OOM, excessive upstream load, and other resource exhaustion.
type Limits struct {
	// Discovery limits
	MaxMetricNames    int // soft limit for metric name candidates
	MaxMetricNamesHard int // hard limit
	MaxSeriesScan     int // max series to scan for facets
	MaxSeriesScanHard int

	// Facet limits
	MaxFacetValues     int // max values per facet
	MaxFacetValuesHard int

	// Chart limits
	MaxChartSeries     int // max series per chart
	MaxChartSeriesHard int
	MaxConcurrentCharts int // max concurrent chart preview requests

	// Request limits
	MaxRequestBody     int // max Resource API request body size
	MaxRequestBodyHard int
	MaxUpstreamBytes   int // max upstream response body (pre-decompression)
	MaxUpstreamBytesHard int
	MaxDecompressedBytes int // max decompressed response
	MaxDecompressedBytesHard int

	// Concurrency
	MaxConcurrentRequests int // max concurrent exploration requests per datasource

	// Compression
}

// Default returns the default limits from the plan (section 7.3).
func Default() *Limits {
	return &Limits{
		MaxMetricNames:         10000,
		MaxMetricNamesHard:     100000,
		MaxSeriesScan:          20000,
		MaxSeriesScanHard:      100000,
		MaxFacetValues:         100,
		MaxFacetValuesHard:     1000,
		MaxChartSeries:         10,
		MaxChartSeriesHard:     20,
		MaxConcurrentCharts:    6,
		MaxRequestBody:         256 * 1024,  // 256 KiB
		MaxRequestBodyHard:     1 * 1024 * 1024, // 1 MiB
		MaxUpstreamBytes:       8 * 1024 * 1024,  // 8 MiB
		MaxUpstreamBytesHard:   32 * 1024 * 1024, // 32 MiB
		MaxDecompressedBytes:   16 * 1024 * 1024, // 16 MiB
		MaxDecompressedBytesHard: 64 * 1024 * 1024, // 64 MiB
		MaxConcurrentRequests:  4,
	}
}

// IsHardLimitExceeded returns true if the count exceeds the hard limit.
func (l *Limits) IsHardLimitExceeded(count, hardLimit int) bool {
	return count > hardLimit
}

// IsSoftLimitExceeded returns true if the count exceeds the soft limit.
func (l *Limits) IsSoftLimitExceeded(count, softLimit int) bool {
	return count > softLimit
}
