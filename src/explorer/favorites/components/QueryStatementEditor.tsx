import React, { useId, useMemo, useState } from 'react';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { Button, Field, IconButton, RadioButtonGroup, TextArea, UnitPicker, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { VisualizationKind, type QueryStatement } from '../../../generated/explorer/user_storage_pb';
import { useFavorites } from '../FavoritesProvider';
import { describeSource, updateStatement } from '../drafts';
import { onDatasource, resolveRange, statementStep } from '../queryExecution';
import { statementProblems, templateVariableIn } from '../validation';
import { StatementChart } from './StatementChart';

const VISUALIZATION_OPTIONS: Array<SelectableValue<VisualizationKind>> = [
  { label: 'Time series', value: VisualizationKind.TIMESERIES },
  { label: 'Stat', value: VisualizationKind.STAT },
  { label: 'Heatmap', value: VisualizationKind.HEATMAP },
];

interface Props {
  statement: QueryStatement;
  index: number;
  count: number;
  onChange: (next: QueryStatement) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  /** Offer a "Try run" with the toolbar's range and step. */
  canTryRun?: boolean;
  /** Show validation problems (after a save attempt). */
  showProblems?: boolean;
}

/**
 * One statement of a query: expression, unit and visualization. The browse source is read-only.
 * There is no datasource to choose: statements run on the toolbar's datasource.
 */
export const QueryStatementEditor: React.FC<Props> = ({
  statement,
  index,
  count,
  onChange,
  onMove,
  onRemove,
  canTryRun = false,
  showProblems = false,
}) => {
  const styles = useStyles2(getStyles);
  const id = useId();
  const { datasources, defaultDatasourceUid, timeRange, step } = useFavorites();
  const [tryRun, setTryRun] = useState<{ key: number; range: ReturnType<typeof resolveRange> } | null>(null);
  const source = describeSource(statement);
  const variable = templateVariableIn(statement.expression);
  const problems = showProblems ? statementProblems(statement) : [];
  // A try run runs where the saved query will: on the toolbar's datasource.
  const runnable = useMemo(
    () =>
      onDatasource(
        statement,
        datasources.find((ds) => ds.uid === defaultDatasourceUid)
      ),
    [datasources, defaultDatasourceUid, statement]
  );

  return (
    <fieldset className={styles.container}>
      <legend className={styles.legend}>
        <span>Statement {index + 1}</span>
        <span className={styles.legendActions}>
          <IconButton name="arrow-up" size="sm" tooltip="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton
            name="arrow-down"
            size="sm"
            tooltip="Move down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            name="trash-alt"
            size="sm"
            tooltip={count === 1 ? 'A query keeps at least one statement' : 'Remove statement'}
            disabled={count === 1}
            onClick={onRemove}
          />
        </span>
      </legend>

      <Field
        label="Expression"
        htmlFor={`${id}-expression`}
        invalid={problems.some((p) => p.includes('xpression'))}
        className={styles.field}
      >
        <TextArea
          id={`${id}-expression`}
          className={styles.expression}
          rows={3}
          value={statement.expression}
          placeholder="sum(rate(http_requests_total[5m]))"
          spellCheck={false}
          onChange={(event) => onChange(updateStatement(statement, { expression: event.currentTarget.value }))}
        />
      </Field>
      {variable && (
        <div className={styles.warning}>
          {variable} is a dashboard variable and is not expanded here; replace it with a real value.
        </div>
      )}

      <div className={styles.row}>
        <Field label="Unit" htmlFor={`${id}-unit`} className={styles.field}>
          <UnitPicker
            id={`${id}-unit`}
            value={statement.unitId || 'none'}
            onChange={(unit) => onChange(updateStatement(statement, { unitId: unit || 'none' }))}
            width={24}
          />
        </Field>
      </div>

      <Field label="Visualization" className={styles.field}>
        <RadioButtonGroup
          size="sm"
          options={VISUALIZATION_OPTIONS}
          value={statement.visualization}
          onChange={(visualization) => onChange(updateStatement(statement, { visualization }))}
        />
      </Field>

      {statement.visualization === VisualizationKind.HEATMAP && (
        <div className={styles.row}>
          <Field
            label="Bucket unit"
            description="Unit of the bucket bounds (le)"
            htmlFor={`${id}-bucket-unit`}
            className={styles.field}
          >
            <UnitPicker
              id={`${id}-bucket-unit`}
              value={statement.heatmapBucketUnitId || 'none'}
              onChange={(unit) => onChange(updateStatement(statement, { heatmapBucketUnitId: unit || 'none' }))}
              width={24}
            />
          </Field>
          <Field
            label="Value unit"
            description="Unit of the bucket counts"
            htmlFor={`${id}-value-unit`}
            className={styles.field}
          >
            <UnitPicker
              id={`${id}-value-unit`}
              value={statement.heatmapValueUnitId || 'none'}
              onChange={(unit) => onChange(updateStatement(statement, { heatmapValueUnitId: unit || 'none' }))}
              width={24}
            />
          </Field>
        </div>
      )}

      <div className={styles.source}>
        <span>Source:</span> {source ?? 'Written by hand'}
        {statement.sourceMetric && <span className={styles.mono}> · {statement.sourceMetric}</span>}
        {source && (
          <span className={styles.sourceNote}> (kept for reference; editing the expression does not change it)</span>
        )}
      </div>

      {problems.length > 0 && (
        <ul className={styles.problems}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {canTryRun && (
        <div className={styles.tryRun}>
          <Button
            size="sm"
            variant="secondary"
            icon="play"
            disabled={!statement.expression.trim() || !runnable.datasourceUid}
            onClick={() => setTryRun((previous) => ({ key: (previous?.key ?? 0) + 1, range: resolveRange(timeRange) }))}
          >
            Try run
          </Button>
          {tryRun && (
            <Button size="sm" variant="secondary" fill="text" onClick={() => setTryRun(null)}>
              Hide result
            </Button>
          )}
        </div>
      )}
      {canTryRun && tryRun && (
        <StatementChart
          statement={runnable}
          range={tryRun.range}
          step={statementStep(step, tryRun.range)}
          runKey={String(tryRun.key)}
          height={220}
        />
      )}
    </fieldset>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
    margin: 0,
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    minWidth: 0,
  }),
  legend: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    margin: 0,
    padding: 0,
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  legendActions: css({
    display: 'flex',
    gap: theme.spacing(0.5),
  }),
  field: css({
    marginBottom: theme.spacing(0.5),
  }),
  row: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(2),
  }),
  expression: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.sm,
  }),
  warning: css({
    color: theme.colors.warning.text,
    fontSize: theme.typography.size.xs,
  }),
  source: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    overflowWrap: 'anywhere',
  }),
  sourceNote: css({
    fontStyle: 'italic',
  }),
  mono: css({
    fontFamily: theme.typography.fontFamilyMonospace,
  }),
  problems: css({
    margin: 0,
    paddingLeft: theme.spacing(2),
    color: theme.colors.error.text,
    fontSize: theme.typography.size.xs,
  }),
  tryRun: css({
    display: 'flex',
    gap: theme.spacing(1),
  }),
});
