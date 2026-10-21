package limits

import "testing"

func TestDefaults(t *testing.T) {
	lim := Default()

	if lim.MaxMetricNames <= 0 {
		t.Error("MaxMetricNames should be positive")
	}
	if lim.MaxSeriesScan <= 0 {
		t.Error("MaxSeriesScan should be positive")
	}
	if lim.MaxChartSeries <= 0 {
		t.Error("MaxChartSeries should be positive")
	}
	if lim.MaxConcurrentRequests <= 0 {
		t.Error("MaxConcurrentRequests should be positive")
	}
	if lim.MaxUpstreamBytes <= 0 {
		t.Error("MaxUpstreamBytes should be positive")
	}
	if lim.MaxRequestBody <= 0 {
		t.Error("MaxRequestBody should be positive")
	}

	// Hard limits should be >= soft limits
	if lim.MaxMetricNamesHard < lim.MaxMetricNames {
		t.Error("MaxMetricNamesHard should be >= MaxMetricNames")
	}
	if lim.MaxSeriesScanHard < lim.MaxSeriesScan {
		t.Error("MaxSeriesScanHard should be >= MaxSeriesScan")
	}
	if lim.MaxFacetValuesHard < lim.MaxFacetValues {
		t.Error("MaxFacetValuesHard should be >= MaxFacetValues")
	}
}

func TestLimitExceededChecks(t *testing.T) {
	lim := Default()

	if !lim.IsSoftLimitExceeded(lim.MaxMetricNames+1, lim.MaxMetricNames) {
		t.Error("should detect soft limit exceeded")
	}
	if lim.IsSoftLimitExceeded(lim.MaxMetricNames-1, lim.MaxMetricNames) {
		t.Error("should not detect soft limit exceeded when under limit")
	}

	if !lim.IsHardLimitExceeded(lim.MaxMetricNamesHard+1, lim.MaxMetricNamesHard) {
		t.Error("should detect hard limit exceeded")
	}
	if lim.IsHardLimitExceeded(lim.MaxMetricNamesHard-1, lim.MaxMetricNamesHard) {
		t.Error("should not detect hard limit exceeded when under limit")
	}
}
