import { detectRateMode, rewriteCounterCalls, unitForRateMode } from './rateMode';

describe('rate mode', () => {
  it('finds the counter function of a saved counter chart', () => {
    expect(detectRateMode('sum by () (rate({__name__="http_requests_total"}[1m]))')).toBe('rate');
    expect(detectRateMode('sum by () (increase(m[5m]))')).toBe('increase');
    expect(detectRateMode('sum by () (irate (m[5m]))')).toBe('irate');
    expect(detectRateMode('sum(rate(a[5m])) / sum(rate(b[5m]))')).toBe('rate');
  });

  it('ignores names that are not counter calls', () => {
    expect(detectRateMode('max(node_load1)')).toBeNull();
    expect(detectRateMode('sum(m{rate="x"}) by (rate)')).toBeNull();
    expect(detectRateMode('sum(m{path="/rate(x)"})')).toBeNull();
    expect(detectRateMode("sum(m{path='increase(\\'x\\')'})")).toBeNull();
    expect(detectRateMode('rate_over_sum(m[5m]) + increase_pure(m[5m])')).toBeNull();
    expect(detectRateMode('sum(m) # rate(m[5m])')).toBeNull();
  });

  it('refuses an expression that mixes counter functions', () => {
    expect(detectRateMode('rate(a[5m]) / increase(b[5m])')).toBeNull();
  });

  it('renames every call and keeps the rest of the expression', () => {
    expect(rewriteCounterCalls('sum by () (rate(m{a="rate("}[1m]))', { mode: 'increase' })).toBe(
      'sum by () (increase(m{a="rate("}[1m]))'
    );
    expect(rewriteCounterCalls('sum(irate(a[5m])) / sum(irate (b[5m]))', { mode: 'rate' })).toBe(
      'sum(rate(a[5m])) / sum(rate (b[5m]))'
    );
    expect(
      rewriteCounterCalls(
        'sum by (le) (label_replace(rate(m[1m]), "le", "$1", "vmrange", "([^\\\\n]+)\\\\.\\\\.\\\\.([^\\\\n]+)"))',
        { mode: 'increase' }
      )
    ).toBe(
      'sum by (le) (label_replace(increase(m[1m]), "le", "$1", "vmrange", "([^\\\\n]+)\\\\.\\\\.\\\\.([^\\\\n]+)"))'
    );
    expect(rewriteCounterCalls('max(m)', { mode: 'increase' })).toBe('max(m)');
  });

  it('sets the window of every counter call and leaves other windows alone', () => {
    expect(rewriteCounterCalls('sum by () (rate({__name__="m",a="[1m]"}[1m]))', { window: '5m' })).toBe(
      'sum by () (rate({__name__="m",a="[1m]"}[5m]))'
    );
    expect(rewriteCounterCalls('sum(rate(a[1m] offset 1h)) / sum(avg_over_time(b[1h]))', { window: '2m' })).toBe(
      'sum(rate(a[2m] offset 1h)) / sum(avg_over_time(b[1h]))'
    );
    // Subqueries and MetricsQL calls without a window keep what they have.
    expect(rewriteCounterCalls('rate(sum(m)[1h:1m]) + rate(m)', { window: '5m' })).toBe(
      'rate(sum(m)[1h:1m]) + rate(m)'
    );
    expect(rewriteCounterCalls('sum by (le) (rate(m[1m]))', { mode: 'increase', window: '30s' })).toBe(
      'sum by (le) (increase(m[30s]))'
    );
  });

  it('switches per-second and per-minute units together with the function', () => {
    expect(unitForRateMode('Bps', 'increase')).toBe('bytes/min');
    expect(unitForRateMode('bytes/min', 'rate')).toBe('Bps');
    expect(unitForRateMode('s/s', 'increase')).toBe('s/min');
    expect(unitForRateMode('s/min', 'irate')).toBe('s/s');
    expect(unitForRateMode('suffix:/s', 'increase')).toBe('suffix:/min');
    expect(unitForRateMode('suffix:/min', 'rate')).toBe('suffix:/s');
    expect(unitForRateMode('Bps', 'irate')).toBe('Bps');
    expect(unitForRateMode('percent', 'increase')).toBe('percent');
  });
});
