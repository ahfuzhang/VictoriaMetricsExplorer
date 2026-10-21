import React, { useState, useEffect } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { LoadingPlaceholder, useStyles2, Button, Alert } from '@grafana/ui';
import { locationService } from '@grafana/runtime';
import { css } from '@emotion/css';

import { Capabilities, MetricMetadata } from '../model';
import { fetchMetadata, describeError } from '../api';

interface Props {
  datasourceUID: string;
  metric: string;
  capabilities: Capabilities;
}

export const DetailPanel: React.FC<Props> = ({ datasourceUID, metric, capabilities }) => {
  const styles = useStyles2(getStyles);

  const [metadata, setMetadata] = useState<MetricMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isFavorite, setIsFavorite] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    fetchMetadata(datasourceUID, metric)
      .then((resp) => {
        if (!cancelled) {
          setMetadata(resp.items ?? []);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error('Failed to load metric metadata', err);
          setError(describeError(err));
          setMetadata([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasourceUID, metric]);

  // Check if metric is in favorites (stored in localStorage for now)
  useEffect(() => {
    const favorites = JSON.parse(localStorage.getItem('vm_explorer_favorites') ?? '[]');
    setIsFavorite(favorites.includes(metric));
  }, [metric]);

  const toggleFavorite = () => {
    const favorites = JSON.parse(localStorage.getItem('vm_explorer_favorites') ?? '[]');
    let next;
    if (favorites.includes(metric)) {
      next = favorites.filter((m: string) => m !== metric);
    } else {
      next = [...favorites, metric];
    }
    localStorage.setItem('vm_explorer_favorites', JSON.stringify(next));
    setIsFavorite(next.includes(metric));
  };

  const createDashboard = () => {
    // Navigate to new dashboard with the metric pre-filled
    locationService.push({
      pathname: '/dashboard/new',
      search: new URLSearchParams({
        editPanel: '1',
        'var-datasource': datasourceUID,
        'var-metric': metric,
      }).toString(),
    });
  };

  const meta = metadata[0];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Details</h3>
        <div className={styles.headerActions}>
          <Button
            variant={isFavorite ? 'primary' : 'secondary'}
            size="sm"
            onClick={toggleFavorite}
            icon={isFavorite ? 'star' : 'star'}
          >
            {isFavorite ? '★' : '☆'}
          </Button>
        </div>
      </div>

      <div className={styles.content}>
        {loading ? (
          <div className={styles.center}>
            <LoadingPlaceholder text="Loading details…" />
          </div>
        ) : (
          <>
            {error && (
              <Alert title="Failed to load metric details" severity="error">
                {error}
              </Alert>
            )}

            {/* Metric name */}
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Metric</div>
              <div className={styles.metricName}>{metric}</div>
            </div>

            {/* Type */}
            {meta?.type && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Type</div>
                <div className={styles.value}>{meta.type}</div>
              </div>
            )}

            {/* Help text */}
            {meta?.help && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Help</div>
                <div className={styles.helpText}>{meta.help}</div>
              </div>
            )}

            {/* Unit */}
            {meta?.unit && meta.unit !== 'unknown' && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Unit</div>
                <div className={styles.value}>{meta.unit}</div>
              </div>
            )}

            {/* Source */}
            {meta?.source && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Metadata Source</div>
                <div className={styles.value}>
                  {meta.source}
                  {meta.confidence > 0 && (
                    <span className={styles.confidence}>({(meta.confidence * 100).toFixed(0)}% confidence)</span>
                  )}
                </div>
              </div>
            )}

            {/* Limits info */}
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Limits</div>
              <div className={styles.limits}>
                <span>Max series: {capabilities.maxChartSeries}</span>
                <span>Max scan: {capabilities.maxSeriesScan}</span>
                <span>Max facets: {capabilities.maxFacetValues}</span>
              </div>
            </div>

            {/* Actions */}
            <div className={styles.actions}>
              <Button variant="primary" size="sm" onClick={createDashboard} className={styles.actionBtn}>
                Create Dashboard
              </Button>
            </div>

            {metadata.length === 0 && (
              <Alert title="No metadata" severity="info">
                No metadata available for this metric.
              </Alert>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  }),
  header: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.spacing(1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  title: css({
    margin: 0,
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightBold,
  }),
  headerActions: css({
    display: 'flex',
    gap: theme.spacing(0.5),
  }),
  content: css({
    flex: 1,
    overflowY: 'auto' as const,
    padding: theme.spacing(1),
  }),
  center: css({
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(2),
  }),
  section: css({
    marginBottom: theme.spacing(2),
  }),
  sectionLabel: css({
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightBold,
    color: theme.colors.text.secondary,
    textTransform: 'uppercase' as const,
    marginBottom: theme.spacing(0.5),
  }),
  metricName: css({
    fontSize: theme.typography.size.sm,
    fontFamily: theme.typography.fontFamilyMonospace,
    wordBreak: 'break-all' as const,
    color: theme.colors.text.primary,
  }),
  value: css({
    fontSize: theme.typography.size.sm,
    color: theme.colors.text.primary,
  }),
  helpText: css({
    fontSize: theme.typography.size.sm,
    color: theme.colors.text.primary,
    lineHeight: 1.4,
  }),
  confidence: css({
    marginLeft: theme.spacing(0.5),
    fontSize: theme.typography.size.xs,
    color: theme.colors.text.secondary,
  }),
  limits: css({
    display: 'flex',
    flexDirection: 'column' as const,
    gap: theme.spacing(0.25),
    fontSize: theme.typography.size.xs,
    color: theme.colors.text.secondary,
  }),
  actions: css({
    marginTop: theme.spacing(2),
  }),
  actionBtn: css({
    width: '100%',
  }),
});
