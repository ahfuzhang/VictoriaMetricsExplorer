import React, { useEffect, useRef, useState } from 'react';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { Capabilities } from '../model';
import { describeError, Facet, fetchFacets, FacetResponse } from '../api';
import type { SelectedFilters } from './Explorer';

interface Props {
  datasourceUID: string;
  metric: string;
  capabilities: Capabilities;
  filters: SelectedFilters;
  podGroup?: string;
  node?: string;
  timeRange: TimeRange;
  refreshKey: number;
  onFilterChange: (label: string, values: string[]) => void;
  onResetFilters: () => void;
}

interface FacetResult {
  requestKey: string;
  response: FacetResponse | null;
  error: string;
}

export const FacetPanel: React.FC<Props> = ({
  datasourceUID,
  metric,
  capabilities,
  filters,
  podGroup,
  node,
  timeRange,
  refreshKey,
  onFilterChange,
  onResetFilters,
}) => {
  const styles = useStyles2(getStyles);
  const [result, setResult] = useState<FacetResult>({ requestKey: '', response: null, error: '' });
  const generationRef = useRef(0);
  const startMs = timeRange.from.valueOf();
  const endMs = timeRange.to.valueOf();
  const requestKey = `${datasourceUID}:${metric}:${podGroup ?? ''}:${node ?? ''}:${startMs}:${endMs}:${refreshKey}:${JSON.stringify(filters)}`;
  const response = result.response;
  const error = result.requestKey === requestKey ? result.error : '';
  const loading = result.requestKey !== requestKey;

  useEffect(() => {
    const generation = ++generationRef.current;

    fetchFacets(datasourceUID, {
      metric,
      filters,
      podGroup,
      node,
      startMs,
      endMs,
      maxValuesPerFacet: Math.min(100, capabilities.maxFacetValues),
    })
      .then((nextResponse) => {
        if (generation === generationRef.current) {
          setResult({ requestKey, response: nextResponse, error: '' });
        }
      })
      .catch((err: unknown) => {
        if (generation === generationRef.current) {
          setResult((previous) => ({
            requestKey,
            response: previous.response,
            error: describeError(err),
          }));
        }
      });

    return () => {
      generationRef.current += 1;
    };
  }, [capabilities.maxFacetValues, datasourceUID, endMs, filters, metric, node, podGroup, requestKey, startMs]);

  const toggleFilter = (label: string, value: string) => {
    const current = filters[label] ?? [];
    onFilterChange(
      label,
      current.includes(value) ? current.filter((selected) => selected !== value) : [...current, value]
    );
  };

  const selectedCount = Object.values(filters).reduce((count, values) => count + values.length, 0);
  const allFacets: Facet[] = response?.facets ?? [];
  const constants = allFacets.filter((facet) => facet.isConstant);
  const visibleFacets = allFacets
    .filter((facet) => !facet.isConstant)
    .map((facet) => ({ facet, values: facet.values }))
    .filter(({ values }) => values.length > 0);

  const podMatcher = response?.podMatcher ?? '';
  const commonCount = constants.length + (podMatcher ? 1 : 0);
  const hasVisibleContent = commonCount > 0 || visibleFacets.length > 0;
  const totalSuffix = response && !response.countsExact ? '+' : '';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headingRow}>
          <div className={styles.headingTitle}>
            <span className={styles.stepNumber}>03</span>
            <h2 className={styles.title}>Label filters</h2>
          </div>
          <button type="button" className={styles.resetButton} onClick={onResetFilters} disabled={selectedCount === 0}>
            Reset
          </button>
        </div>

        <div className={styles.seriesSummary} aria-live="polite">
          <strong>{response?.seriesReturned ?? '—'}</strong>
          <div>
            Matching series
            <span>time series</span>
          </div>
          <span className={styles.seriesTotal}>
            / {response?.seriesTotal ?? '—'}
            {totalSuffix}
          </span>
          {loading && response && <span className={styles.refreshing}>Updating…</span>}
        </div>

        <div className={styles.filterLogic}>
          <span aria-hidden="true">▽</span>
          Same label <b>OR</b>
          <span>·</span> different labels <b>AND</b>
        </div>
      </div>

      <div className={styles.list}>
        {loading && !response ? (
          <div className={styles.center}>
            <LoadingPlaceholder text="Loading labels and values…" />
          </div>
        ) : error && !response ? (
          <Alert title="Cannot load label filters" severity="error">
            {error}
          </Alert>
        ) : response ? (
          <>
            {error && (
              <Alert title="Could not refresh label filters" severity="warning">
                {error}
              </Alert>
            )}
            {(response.meta.partial || response.meta.truncated) && (
              <div className={styles.resultWarning}>
                {response.meta.partial ? 'Partial upstream result' : 'Series or label values were truncated'}; counts
                may be incomplete.
              </div>
            )}

            {commonCount > 0 && (
              <section className={styles.constants} aria-label="Common labels">
                <div className={styles.constantsTitle}>
                  <span aria-hidden="true">◆</span>
                  Common labels <span>· {commonCount}</span>
                </div>
                {podMatcher && (
                  <div className={styles.constantRow} title={`Filtered by pod name prefix: ${podMatcher}`}>
                    {podMatcher}
                  </div>
                )}
                {constants.map((facet) => (
                  <div key={facet.label} className={styles.constantRow} title={`${facet.label}=${facet.constantValue}`}>
                    <span>{facet.label} = </span>
                    {facet.constantValue || '(empty)'}
                  </div>
                ))}
                <p className={styles.constantHint}>Shared by every series; no repeated filtering needed.</p>
              </section>
            )}

            {visibleFacets.map(({ facet, values }) => (
              <section key={facet.label} className={styles.labelBlock} aria-label={`${facet.label} label values`}>
                <h3 className={styles.labelHeading}>
                  <span className={styles.labelName}>{facet.label}</span>
                  <span>{facet.totalValues} values</span>
                </h3>
                <div className={styles.labelValues}>
                  {values.map((item) => {
                    const selected = (filters[facet.label] ?? []).includes(item.value);
                    const count = item.availableCount ?? item.count;
                    // A selected zero-count value must remain enabled so the user can remove it.
                    // Unselected zero-count values cannot produce results under the other active
                    // label filters, so render them as genuinely disabled controls.
                    const unavailable = count === 0 && !selected;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        className={`${styles.labelValue} ${selected ? styles.labelValueSelected : ''} ${
                          unavailable ? styles.labelValueZero : ''
                        }`}
                        aria-pressed={selected}
                        disabled={unavailable}
                        title={
                          unavailable
                            ? `${facet.label}=${item.value} · no matching series under the current filters`
                            : `${facet.label}=${item.value} · ${count} matching series · values in one label use OR`
                        }
                        onClick={() => toggleFilter(facet.label, item.value)}
                      >
                        {selected && <span className={styles.checkMark}>✓</span>}
                        <span className={styles.labelValueText}>{item.value || '(empty)'}</span>
                        <em>{count}</em>
                      </button>
                    );
                  })}
                </div>
                {facet.truncated && <div className={styles.truncated}>Showing the most frequent values.</div>}
              </section>
            ))}

            {!hasVisibleContent && (
              <div className={styles.empty}>
                <strong>No label values</strong>
                <span>No variable labels are available for this metric and time range.</span>
              </div>
            )}
          </>
        ) : null}
      </div>

      <div className={styles.footer}>
        <span>
          {selectedCount > 0 ? `${selectedCount} selected · ` : ''}Highest value count · fewer values break ties
        </span>
        {response && !response.countsExact && <span>estimated</span>}
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
    flexDirection: 'column',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  headingRow: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
  }),
  headingTitle: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  stepNumber: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightBold,
  }),
  title: css({
    margin: 0,
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightBold,
  }),
  resetButton: css({
    border: 0,
    padding: theme.spacing(0.25, 0.5),
    background: 'transparent',
    color: theme.colors.text.link,
    cursor: 'pointer',
    fontSize: theme.typography.size.xs,
    '&:disabled': {
      color: theme.colors.text.disabled,
      cursor: 'default',
    },
  }),
  seriesSummary: css({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    '& strong': {
      color: theme.colors.primary.text,
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: '24px',
      fontWeight: theme.typography.fontWeightMedium,
      lineHeight: 1,
    },
    '& > div': {
      display: 'flex',
      flexDirection: 'column',
      color: theme.colors.text.secondary,
      fontSize: theme.typography.size.xs,
      lineHeight: 1.45,
    },
    '& > div span': {
      opacity: 0.7,
    },
  }),
  seriesTotal: css({
    marginLeft: 'auto',
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
  }),
  refreshing: css({
    position: 'absolute',
    right: theme.spacing(1),
    bottom: theme.spacing(0.25),
    color: theme.colors.text.secondary,
    fontSize: '9px',
  }),
  filterLogic: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    '& b': {
      color: theme.colors.text.primary,
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  list: css({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: theme.spacing(1),
  }),
  center: css({
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(2),
  }),
  resultWarning: css({
    marginBottom: theme.spacing(1),
    padding: theme.spacing(0.75),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.warning.transparent,
    color: theme.colors.warning.text,
    fontSize: theme.typography.size.xs,
  }),
  constants: css({
    marginBottom: theme.spacing(2),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.success.border}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.success.transparent,
  }),
  constantsTitle: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    marginBottom: theme.spacing(0.75),
    color: theme.colors.success.text,
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  constantRow: css({
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.8,
    overflowWrap: 'anywhere',
    '& span': {
      color: theme.colors.text.secondary,
    },
  }),
  constantHint: css({
    margin: `${theme.spacing(0.5)} 0 0`,
    color: theme.colors.text.secondary,
    fontSize: '9px',
  }),
  labelBlock: css({
    marginBottom: theme.spacing(2),
  }),
  labelHeading: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    margin: `0 0 ${theme.spacing(0.75)}`,
    color: theme.colors.text.secondary,
    fontSize: '9px',
    fontWeight: theme.typography.fontWeightRegular,
  }),
  labelName: css({
    minWidth: 0,
    overflow: 'hidden',
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightMedium,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  labelValues: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
  }),
  labelValue: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    maxWidth: '100%',
    minWidth: 0,
    padding: theme.spacing(0.5, 0.75),
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    color: theme.colors.text.primary,
    cursor: 'pointer',
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.35,
    '&:hover': {
      borderColor: theme.colors.primary.border,
      background: theme.colors.action.hover,
    },
    '& em': {
      flexShrink: 0,
      padding: '0 3px',
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.primary,
      color: theme.colors.text.secondary,
      fontSize: '9px',
      fontStyle: 'normal',
    },
  }),
  labelValueSelected: css({
    borderColor: theme.colors.primary.border,
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    '&:hover': {
      background: theme.colors.primary.transparent,
    },
    '& em': {
      color: theme.colors.primary.text,
    },
  }),
  labelValueZero: css({
    opacity: 0.45,
    cursor: 'not-allowed',
    '&:hover': {
      borderColor: theme.colors.border.medium,
      background: theme.colors.background.secondary,
    },
  }),
  checkMark: css({
    flexShrink: 0,
    color: theme.colors.primary.text,
    fontFamily: theme.typography.fontFamily,
    fontSize: '10px',
  }),
  labelValueText: css({
    minWidth: 0,
    overflowWrap: 'anywhere',
  }),
  truncated: css({
    marginTop: theme.spacing(0.5),
    color: theme.colors.text.secondary,
    fontSize: '9px',
  }),
  empty: css({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(3, 1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    textAlign: 'center',
    '& strong': {
      color: theme.colors.text.primary,
    },
  }),
  footer: css({
    display: 'flex',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 1),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    color: theme.colors.text.secondary,
    fontSize: '9px',
    flexShrink: 0,
  }),
});
