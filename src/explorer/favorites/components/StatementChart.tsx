import React, { useEffect, useMemo, useState } from 'react';
import {
  DataFrame,
  FieldType,
  GrafanaTheme2,
  TimeRange,
  dateTimeFormat,
  formattedValueToString,
  getFieldDisplayName,
} from '@grafana/data';
import {
  Alert,
  BigValue,
  BigValueColorMode,
  BigValueGraphMode,
  BigValueJustifyMode,
  BigValueTextMode,
  Button,
  ClipboardButton,
  LinkButton,
  LoadingPlaceholder,
  useStyles2,
  useTheme2,
} from '@grafana/ui';
import { css } from '@emotion/css';

import { VisualizationKind, type QueryStatement } from '../../../generated/explorer/user_storage_pb';
import { describeError, type RangeQueryResult } from '../../api';
import {
  Centered,
  HeatmapView,
  MultiSeriesChart,
  exploreUrl,
  hasBucketLabels,
  useElementSize,
} from '../../components/chartParts';
import { MAX_DRAWN_SERIES } from '../limits';
import { StatementError, datasourceName, isAbortError, runStatement } from '../queryExecution';
import { VISUALIZATION_LABELS, bucketFormatterForUnit, heatmapValueSuffix, unitDisplay } from '../units';
import { statementTitle } from '../drafts';

interface RunState {
  loading: boolean;
  /** The last result; while a new run loads it may belong to the previous range. */
  result: RangeQueryResult | null;
  error: { title: string; message: string } | null;
}

interface Finished {
  key: string;
  result: RangeQueryResult | null;
  error: RunState['error'];
}

/**
 * Run one statement whenever its expression, datasource, range, step or runKey changes. Unit, name
 * and visualization changes only redraw. A newer run aborts the older one.
 */
function useStatementRun(statement: QueryStatement, range: TimeRange, step: string, runKey: string): RunState {
  const key = [
    statement.datasourceUid,
    statement.expression,
    range.from.valueOf(),
    range.to.valueOf(),
    step,
    runKey,
  ].join('\n');
  const [finished, setFinished] = useState<Finished>({ key: '', result: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    runStatement(statement, range, step, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setFinished({ key, result, error: null });
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) {
          return;
        }
        const title =
          err instanceof StatementError
            ? err.kind === 'template'
              ? 'Dashboard variable in the expression'
              : 'Datasource unavailable'
            : 'Query failed';
        const message = err instanceof StatementError ? err.message : describeError(err);
        setFinished({ key, result: null, error: { title, message } });
      });
    return () => controller.abort();
    // key covers every input that changes the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loading = finished.key !== key;
  return { loading, result: finished.result, error: loading ? null : finished.error };
}

interface Props {
  statement: QueryStatement;
  /** Absolute range of this run. */
  range: TimeRange;
  /** Step sent to the backend; empty for auto. */
  step: string;
  /** Changes force a new run (query switch, refresh). */
  runKey: string;
  /** Plot area height in pixels. */
  height?: number;
  index?: number;
  /** Show the expression that runs, with Copy and Explore, under the header. */
  showQuery?: boolean;
}

export const StatementChart: React.FC<Props> = ({
  statement,
  range,
  step,
  runKey,
  height = 340,
  index,
  showQuery = false,
}) => {
  const styles = useStyles2(getStyles);
  const run = useStatementRun(statement, range, step, runKey);
  const [forceTimeseries, setForceTimeseries] = useState(false);
  const frames = run.result?.frames ?? [];
  const drawn = frames.slice(0, MAX_DRAWN_SERIES);
  let kind = statement.visualization;
  const heatmapIncompatible = kind === VisualizationKind.HEATMAP && frames.length > 0 && !hasBucketLabels(frames);
  if (heatmapIncompatible && forceTimeseries) {
    kind = VisualizationKind.TIMESERIES;
  }
  const effective = run.result?.meta.effectiveRange;

  return (
    <section className={styles.container} aria-label={`Statement ${index !== undefined ? index + 1 : ''} chart`}>
      <div className={styles.header}>
        <span className={styles.title} title={statement.expression}>
          {index !== undefined && <span className={styles.index}>{index + 1}</span>}
          {statementTitle(statement)}
        </span>
        <span className={styles.badges}>
          <span>{VISUALIZATION_LABELS[statement.visualization] ?? 'Unknown'}</span>
          <span title={statement.datasourceUid}>{datasourceName(statement) || statement.datasourceUid}</span>
          {run.result && <span>step {run.result.step}</span>}
          {effective && effective.endMs > 0 && (
            <span title="Range after aligning to the step">
              {dateTimeFormat(effective.startMs, { format: 'MM-DD HH:mm' })} –{' '}
              {dateTimeFormat(effective.endMs, { format: 'MM-DD HH:mm' })}
            </span>
          )}
          {run.result && <span>{frames.length} series</span>}
        </span>
      </div>

      {showQuery && (
        <div className={styles.queryBar} title={statement.expression}>
          <ClipboardButton
            size="sm"
            variant="secondary"
            icon="copy"
            aria-label="Copy PromQL expression"
            getText={() => statement.expression}
          >
            Copy
          </ClipboardButton>
          <code className={styles.queryCode}>{statement.expression}</code>
          <LinkButton
            size="sm"
            variant="secondary"
            icon="compass"
            href={exploreUrl(statement.datasourceUid, statement.expression, run.result?.step ?? step, range)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open PromQL expression in Grafana Explore"
          >
            Explore
          </LinkButton>
        </div>
      )}

      {run.result?.meta.truncated && (
        <div className={styles.warning}>
          The backend returned only its first {frames.length} series; the rest were cut off.
        </div>
      )}
      {frames.length > MAX_DRAWN_SERIES && kind !== VisualizationKind.HEATMAP && (
        <div className={styles.warning}>
          Showing {MAX_DRAWN_SERIES} of {frames.length} series. This limits drawing only; the query still returned them
          all.
        </div>
      )}
      {heatmapIncompatible && (
        <div className={styles.warning}>
          The result has no le or vmrange bucket labels, so it cannot be drawn as a heatmap.{' '}
          <Button size="sm" variant="secondary" fill="text" onClick={() => setForceTimeseries((value) => !value)}>
            {forceTimeseries ? 'Show as heatmap' : 'Show as time series'}
          </Button>
        </div>
      )}

      <div className={styles.body} style={{ height: `${height}px` }}>
        {run.error ? (
          <Alert title={run.error.title} severity="error">
            {run.error.message}
          </Alert>
        ) : run.loading && !run.result ? (
          <Centered>
            <LoadingPlaceholder text="Loading data…" />
          </Centered>
        ) : frames.length === 0 ? (
          <Centered>No data for this expression and time range.</Centered>
        ) : kind === VisualizationKind.STAT ? (
          <StatList frames={drawn} unitId={statement.unitId} />
        ) : kind === VisualizationKind.HEATMAP && !heatmapIncompatible ? (
          <HeatmapView
            frames={frames}
            formatBucket={bucketFormatterForUnit(statement.heatmapBucketUnitId)}
            rateUnit={heatmapValueSuffix(statement.heatmapValueUnitId)}
          />
        ) : (
          <MultiSeriesChart
            frames={drawn}
            unitId={statement.unitId}
            range={range}
            unlabeledName={statementTitle(statement)}
          />
        )}
        {run.loading && run.result && <div className={styles.refreshing}>Refreshing…</div>}
      </div>
    </section>
  );
};

/** The last non-null value of each series, one entry per series; values are never summed. */
const StatList: React.FC<{ frames: DataFrame[]; unitId: string }> = ({ frames, unitId }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [setContainer, size] = useElementSize<HTMLDivElement>();
  const values = useMemo(
    () =>
      frames.flatMap((frame) => {
        const field = frame.fields.find((candidate) => candidate.type === FieldType.number);
        if (!field) {
          return [];
        }
        let last: number | null = null;
        for (let index = field.values.length - 1; index >= 0; index--) {
          const value = Number(field.values[index]);
          if (field.values[index] !== null && Number.isFinite(value)) {
            last = value;
            break;
          }
        }
        if (last === null) {
          return [];
        }
        const name = frame.name || getFieldDisplayName(field, frame);
        const display = unitDisplay(field, unitId, theme)(last);
        return [{ name, value: last, display }];
      }),
    [frames, theme, unitId]
  );

  if (values.length === 0) {
    return <Centered>No numeric value is available.</Centered>;
  }
  if (values.length === 1) {
    const [only] = values;
    return (
      <div
        className={styles.statSingle}
        role="figure"
        aria-label={`${only.name}: ${formattedValueToString(only.display)}`}
      >
        <div ref={setContainer} className={styles.statBig}>
          {size.width > 0 && size.height > 0 && (
            <BigValue
              theme={theme}
              width={size.width}
              height={size.height}
              value={{
                ...only.display,
                numeric: only.value,
                title: only.name,
                color: only.display.color ?? theme.colors.text.primary,
              }}
              colorMode={BigValueColorMode.Value}
              graphMode={BigValueGraphMode.None}
              justifyMode={BigValueJustifyMode.Center}
              textMode={BigValueTextMode.Value}
            />
          )}
        </div>
        <div className={styles.statName}>{only.name}</div>
      </div>
    );
  }
  return (
    <div className={styles.statTable}>
      <table aria-label="Last value of each series">
        <thead>
          <tr>
            <th>Series</th>
            <th>Last value</th>
          </tr>
        </thead>
        <tbody>
          {values.map((entry) => (
            <tr key={entry.name}>
              <td title={entry.name}>{entry.name}</td>
              <td>{formattedValueToString(entry.display)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    minWidth: 0,
  }),
  header: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
  }),
  title: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    minWidth: 0,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  index: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '18px',
    height: '18px',
    borderRadius: '50%',
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    fontFamily: theme.typography.fontFamily,
    fontSize: theme.typography.size.xs,
    flexShrink: 0,
  }),
  badges: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  queryBar: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
  }),
  queryCode: css({
    flex: 1,
    minWidth: 0,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  warning: css({
    padding: theme.spacing(0.5, 1),
    color: theme.colors.warning.text,
    fontSize: theme.typography.size.xs,
    borderBottom: `1px solid ${theme.colors.border.weak}`,
  }),
  body: css({
    position: 'relative',
    padding: theme.spacing(1),
    minHeight: 0,
    overflow: 'hidden',
  }),
  refreshing: css({
    position: 'absolute',
    top: theme.spacing(1),
    right: theme.spacing(1),
    padding: theme.spacing(0.25, 0.75),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  statSingle: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  }),
  statBig: css({
    flex: 1,
    minHeight: 0,
  }),
  statName: css({
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.sm,
    textAlign: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  statTable: css({
    height: '100%',
    overflow: 'auto',
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: theme.typography.size.sm,
      fontVariantNumeric: 'tabular-nums',
    },
    'th, td': {
      padding: theme.spacing(0.5, 0.75),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'right',
      whiteSpace: 'nowrap',
    },
    'th:first-child, td:first-child': {
      textAlign: 'left',
      fontFamily: theme.typography.fontFamilyMonospace,
      maxWidth: '480px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    th: {
      color: theme.colors.text.secondary,
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
});
