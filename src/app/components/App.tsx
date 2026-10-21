import React, { useState, useEffect, useCallback } from 'react';
import { locationService } from '@grafana/runtime';
import { Select, Button, LoadingPlaceholder, Alert, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, SelectableValue, TimeRange, dateTime } from '@grafana/data';
import { css } from '@emotion/css';

import { getDatasources, fetchCapabilities, describeError, PLUGIN_ID } from '../../explorer/api';
import { Explorer } from '../../explorer/components/Explorer';
import { Capabilities } from '../../explorer/model';
import { TimeRangeControl } from './TimeRangeControl';

interface Props {}

/** Which step failed, so the alert can say what was being attempted. */
interface LoadError {
  step: 'datasources' | 'capabilities';
  uid?: string;
  detail: string;
}

const STEP_OPTIONS: Array<SelectableValue<string>> = [
  { value: 'auto', label: 'Auto' },
  { value: '15s', label: '15 seconds' },
  { value: '30s', label: '30 seconds' },
  { value: '1m', label: '1 minute' },
  { value: '5m', label: '5 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '1h', label: '1 hour' },
];

function defaultTimeRange(): TimeRange {
  const now = Date.now();
  return {
    from: dateTime(now - 60 * 60 * 1000),
    to: dateTime(now),
    raw: { from: 'now-1h', to: 'now' },
  };
}

export const App: React.FC<Props> = () => {
  const styles = useStyles2(getStyles);

  const [datasources, setDatasources] = useState<SelectableValue[]>([]);
  const [selectedDS, setSelectedDS] = useState<string>('');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(defaultTimeRange);
  const [step, setStep] = useState('auto');
  const [refreshKey, setRefreshKey] = useState(0);

  // Load the VictoriaMetrics datasources the Explorer can use
  useEffect(() => {
    getDatasources()
      .then((ds: any) => {
        setDatasources(
          ds.map((d: { uid: string; name: string }) => ({
            value: d.uid,
            label: d.name,
          }))
        );
        if (ds.length > 0) {
          setSelectedDS((ds.find((d: { isDefault?: boolean }) => d.isDefault) ?? ds[0]).uid);
        }
        setLoading(false);
      })
      .catch((err: any) => {
        console.error('VictoriaMetrics Explorer: failed to list datasources', err);
        setError({ step: 'datasources', detail: describeError(err) });
        setLoading(false);
      });
  }, []);

  // Fetch capabilities when datasource changes
  const loadCapabilities = useCallback(async (uid: string) => {
    if (!uid) return;
    setLoading(true);
    setError(null);
    try {
      const caps = await fetchCapabilities(uid);
      setCapabilities(caps);
    } catch (err: any) {
      console.error(`VictoriaMetrics Explorer: failed to reach datasource ${uid}`, err);
      setError({ step: 'capabilities', uid, detail: describeError(err) });
      setCapabilities(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedDS) {
      loadCapabilities(selectedDS);
    }
  }, [selectedDS, loadCapabilities]);

  const refresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
    if (selectedDS) {
      loadCapabilities(selectedDS);
    }
  }, [loadCapabilities, selectedDS]);

  if (loading && !capabilities) {
    return (
      <div className={styles.center}>
        <LoadingPlaceholder text="Loading VictoriaMetrics Explorer…" />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <label className={styles.controlGroup}>
            <span className={styles.controlLabel}>Datasource</span>
            <Select
              options={datasources}
              value={selectedDS}
              onChange={(v) => setSelectedDS(v.value ?? '')}
              placeholder="Select datasource"
              width={24}
            />
          </label>
          {capabilities && (
            <span className={styles.versionBadge}>
              {capabilities.upstreamProduct} {capabilities.upstreamVersion ?? ''}
            </span>
          )}
        </div>
        <div className={styles.toolbarRight}>
          <label className={styles.controlGroup}>
            <span className={styles.controlLabel}>Step</span>
            <Select
              options={STEP_OPTIONS}
              value={step}
              onChange={(value) => setStep(value.value ?? 'auto')}
              width={16}
            />
          </label>
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>Time range</span>
            <TimeRangeControl value={timeRange} onChange={setTimeRange} />
          </div>
          <Button variant="secondary" size="sm" icon="sync" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Alert title={errorTitle(error, datasources)} severity="error">
          <div>{error.detail}</div>
          <div className={styles.errorHint}>
            The full cause is in the Grafana server log (logger=plugin.{PLUGIN_ID}) and the browser console.
          </div>
        </Alert>
      )}

      {capabilities && selectedDS ? (
        <Explorer
          datasourceUID={selectedDS}
          capabilities={capabilities}
          timeRange={timeRange}
          step={step}
          refreshKey={refreshKey}
        />
      ) : (
        !error && (
          <Alert title="No datasource selected" severity="info">
            Add a VictoriaMetrics datasource (type “VictoriaMetrics”) to start exploring metrics.
            <Button
              variant="secondary"
              size="sm"
              className={styles.createBtn}
              onClick={() => locationService.push('/connections/datasources/new')}
            >
              Create datasource
            </Button>
          </Alert>
        )
      )}
    </div>
  );
};

function errorTitle(error: LoadError, datasources: SelectableValue[]): string {
  if (error.step === 'datasources') {
    return 'Cannot list the VictoriaMetrics datasources';
  }
  const name = datasources.find((d) => d.value === error.uid)?.label;
  return name ? `Cannot read from datasource "${name}" (uid ${error.uid})` : `Cannot read from datasource ${error.uid}`;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    // Grafana's app page container grows with its contents instead of providing a
    // definite height. Constrain the plugin to the viewport below the 48px chrome
    // header so the explorer columns can own their vertical scrolling.
    height: 'calc(100dvh - 48px)',
    width: '100%',
    gap: theme.spacing(1),
    padding: theme.spacing(2),
    minHeight: 0,
    overflow: 'hidden',
  }),
  toolbar: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing(2),
    flexShrink: 0,
    flexWrap: 'wrap',
  }),
  toolbarLeft: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
    flexWrap: 'wrap',
  }),
  toolbarRight: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  }),
  controlGroup: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
  }),
  controlLabel: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightMedium,
    whiteSpace: 'nowrap',
  }),
  versionBadge: css({
    fontSize: theme.typography.size.sm,
    color: theme.colors.text.secondary,
    padding: `${theme.spacing(0.25)} ${theme.spacing(1)}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  center: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
  }),
  errorHint: css({
    marginTop: theme.spacing(0.5),
    fontSize: theme.typography.size.sm,
    opacity: 0.8,
  }),
  createBtn: css({
    marginTop: theme.spacing(1),
  }),
});
