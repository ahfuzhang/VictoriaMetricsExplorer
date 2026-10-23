import React, { useMemo, useState } from 'react';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { css, cx } from '@emotion/css';

import { SourceScope, VisualizationKind, type QueryStatement } from '../../../generated/explorer/user_storage_pb';
import { useFavorites, type DatasourceOption } from '../FavoritesProvider';
import { describeSource, updateStatement } from '../drafts';
import { onDatasource, statementStep } from '../queryExecution';
import {
  HISTOGRAM_RATE_MODE_OPTIONS,
  RATE_MODE_OPTIONS,
  detectRateMode,
  rewriteCounterCalls,
  unitForRateMode,
  type RateMode,
} from '../rateMode';
import { columnStyles } from './columnStyles';
import { StatementChart } from './StatementChart';

/** DOM id of a query's section, so the query list can scroll to it. */
export function savedQuerySectionId(queryId: string): string {
  return `saved-query-${queryId}`;
}

/**
 * Column 3 in saved mode: every query of the open favorite, top to bottom, each statement on its
 * own row with its chart on the left and its options on the right.
 */
export const SavedQueriesPanel: React.FC<{ range: TimeRange; runKey: string }> = ({ range, runKey }) => {
  const styles = useStyles2(getStyles);
  const column = useStyles2(columnStyles);
  const { selectedNode, selectedContent, selection, step, datasources, defaultDatasourceUid, openEdit, writeBlocked } =
    useFavorites();
  const canEdit = !writeBlocked && selectedContent?.state === 'ok';
  const queries = selectedContent?.state === 'ok' ? selectedContent.content.queries : [];
  const statementCount = queries.reduce((count, query) => count + query.statements.length, 0);
  const runStep = statementStep(step, range);
  const datasource = datasources.find((ds) => ds.uid === defaultDatasourceUid);

  let body: React.ReactNode;
  if (!selectedNode) {
    body = <div className={column.empty}>This favorite no longer exists.</div>;
  } else if (!selectedContent) {
    body = (
      <div className={column.empty}>
        <LoadingPlaceholder text="Loading queries…" />
      </div>
    );
  } else if (selectedContent.state !== 'ok') {
    body = <div className={column.empty}>The queries of this favorite cannot be shown.</div>;
  } else if (queries.length === 0) {
    body = <div className={column.empty}>This favorite has no queries yet.</div>;
  } else {
    body = (
      <div className={styles.queries}>
        {queries.map((query) => (
          <section
            key={query.id}
            id={savedQuerySectionId(query.id)}
            className={styles.query}
            aria-label={`Saved query ${query.name}`}
          >
            <div className={cx(styles.queryHeader, query.id === selection?.queryId && styles.queryHeaderActive)}>
              <h3 className={styles.queryName} title={query.name}>
                {query.name}
              </h3>
              <span className={styles.queryCount}>
                {query.statements.length} statement{query.statements.length === 1 ? '' : 's'}
              </span>
            </div>
            {query.statements.map((statement, index) => (
              <StatementRow
                // Statements have no id; their position is their identity within the query.
                key={index}
                statement={statement}
                index={index}
                range={range}
                step={runStep}
                datasource={datasource}
                runKey={`${runKey}:${query.id}`}
              />
            ))}
          </section>
        ))}
        <p className={styles.note}>
          Every chart uses the time range and Step of the toolbar. In statements saved from a chart, the window of
          rate(), increase() and irate() follows the Step too; hand-written expressions keep the windows they were
          written with.
        </p>
      </div>
    );
  }

  return (
    <div className={column.container}>
      <div className={column.header}>
        <div className={column.headingRow}>
          <span className={column.stepNumber}>03</span>
          <h2 className={column.title}>Visualization</h2>
          {queries.length > 0 && (
            <span className={styles.summary}>
              {queries.length} quer{queries.length === 1 ? 'y' : 'ies'} · {statementCount} chart
              {statementCount === 1 ? '' : 's'}
            </span>
          )}
          {selection && (
            <Button
              size="sm"
              variant="secondary"
              icon="pen"
              onClick={() => openEdit(selection.favoriteId)}
              disabled={!canEdit}
              tooltip={writeBlocked ?? undefined}
            >
              Edit
            </Button>
          )}
        </div>
      </div>
      <div className={column.body}>{body}</div>
    </div>
  );
};

interface StatementRowProps {
  statement: QueryStatement;
  index: number;
  range: TimeRange;
  step: string;
  /** The toolbar's datasource, which every statement runs on; undefined when there is none. */
  datasource: DatasourceOption | undefined;
  runKey: string;
}

/**
 * One statement: its chart, and beside it the counter functions it can be drawn with. Switching
 * runs the expression with the other function for this view only; the saved statement is kept.
 * `step` is the step the chart runs with, already resolved (statementStep).
 */
const StatementRow: React.FC<StatementRowProps> = ({ statement, index, range, step, datasource, runKey }) => {
  const styles = useStyles2(getStyles);
  const savedMode = useMemo(() => detectRateMode(statement.expression), [statement.expression]);
  // A choice belongs to the expression it was made on; an edit of the statement drops it.
  const [choice, setChoice] = useState<{ expression: string; mode: RateMode } | null>(null);
  const mode = choice?.expression === statement.expression ? choice.mode : savedMode;

  const switchedTo = mode !== savedMode ? mode : null;
  // A statement saved from a chart got the Step of that moment as its window; it follows the
  // current Step instead. A hand-written expression keeps the windows it was written with.
  const followsStep = statement.sourceScope !== SourceScope.UNSPECIFIED;

  const shown = useMemo(() => {
    const runnable = onDatasource(statement, datasource);
    const expression = rewriteCounterCalls(statement.expression, {
      mode: switchedTo ?? undefined,
      window: followsStep ? step : undefined,
    });
    if (!switchedTo) {
      return expression === statement.expression ? runnable : updateStatement(runnable, { expression });
    }
    return updateStatement(runnable, {
      expression,
      unitId: unitForRateMode(statement.unitId, switchedTo),
      heatmapValueUnitId: unitForRateMode(statement.heatmapValueUnitId, switchedTo),
    });
  }, [datasource, followsStep, statement, step, switchedTo]);

  const histogram = statement.visualization === VisualizationKind.HEATMAP && savedMode !== 'irate';
  const options = savedMode ? (histogram ? HISTOGRAM_RATE_MODE_OPTIONS : RATE_MODE_OPTIONS) : [];
  const savedLabel = RATE_MODE_OPTIONS.find((option) => option.value === savedMode)?.label;
  const unitId = shown.visualization === VisualizationKind.HEATMAP ? shown.heatmapValueUnitId : shown.unitId;

  return (
    <div className={styles.row}>
      <div className={styles.chart}>
        <StatementChart
          statement={shown}
          index={index}
          range={range}
          step={step}
          runKey={runKey}
          height={300}
          showQuery
        />
      </div>
      <aside className={styles.options} aria-label={`Statement ${index + 1} options`}>
        {options.length > 0 && (
          <div className={styles.optionGroup} role="group" aria-label="Rate">
            <span className={styles.optionTitle}>Rate</span>
            {options.map((option) => (
              <Button
                key={option.value}
                size="sm"
                fullWidth
                variant={option.value === mode ? 'primary' : 'secondary'}
                aria-pressed={option.value === mode}
                onClick={() => setChoice({ expression: statement.expression, mode: option.value })}
              >
                {option.label}
              </Button>
            ))}
            {switchedTo && (
              <span className={styles.hint}>
                Shown here only; the favorite keeps {savedLabel}.{' '}
                <button type="button" className={styles.reset} onClick={() => setChoice(null)}>
                  Reset
                </button>
              </span>
            )}
          </div>
        )}
        <dl className={styles.facts}>
          <dt>Unit</dt>
          <dd>{unitId || 'none'}</dd>
          {savedMode && (
            <>
              <dt>Window</dt>
              <dd>{followsStep ? `${step}, the Step` : 'as written'}</dd>
            </>
          )}
          <dt>Source</dt>
          <dd>{describeSource(statement) ?? 'Written by hand'}</dd>
        </dl>
      </aside>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  summary: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    whiteSpace: 'nowrap',
  }),
  queries: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
    padding: theme.spacing(1),
  }),
  query: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    // Keep the heading clear of the column header when the list scrolls a query into view.
    scrollMarginTop: theme.spacing(1),
  }),
  queryHeader: css({
    display: 'flex',
    alignItems: 'baseline',
    gap: theme.spacing(1),
    paddingLeft: theme.spacing(1),
    borderLeft: `3px solid ${theme.colors.border.medium}`,
  }),
  queryHeaderActive: css({
    borderLeftColor: theme.colors.primary.border,
  }),
  queryName: css({
    margin: 0,
    minWidth: 0,
    fontSize: theme.typography.size.md,
    fontWeight: theme.typography.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  queryCount: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    whiteSpace: 'nowrap',
  }),
  row: css({
    display: 'flex',
    alignItems: 'stretch',
    gap: theme.spacing(1),
  }),
  chart: css({
    flex: 1,
    minWidth: 0,
  }),
  options: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
    width: '200px',
    flexShrink: 0,
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  optionGroup: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
  }),
  optionTitle: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightMedium,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.5,
  }),
  reset: css({
    padding: 0,
    border: 0,
    background: 'none',
    color: theme.colors.text.link,
    font: 'inherit',
    cursor: 'pointer',
    '&:hover': {
      textDecoration: 'underline',
    },
  }),
  facts: css({
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    gap: theme.spacing(0.25, 1),
    margin: 0,
    fontSize: theme.typography.size.xs,
    dt: {
      color: theme.colors.text.secondary,
    },
    dd: {
      margin: 0,
      minWidth: 0,
      overflowWrap: 'anywhere',
    },
  }),
  note: css({
    margin: 0,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.5,
  }),
});
