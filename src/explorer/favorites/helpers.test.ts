jest.mock('@grafana/runtime', () => ({ getDataSourceSrv: () => ({ getInstanceSettings: () => undefined }) }));

import { createTheme, dateTime, type Field, FieldType } from '@grafana/data';

import { NodeKind, SourceScope, VisualizationKind } from '../../generated/explorer/user_storage_pb';
import { describeSource, savedFilters, statementTitle, updateStatement } from './drafts';
import { MAX_QUERIES_PER_FAVORITE } from './limits';
import { findImportFolder, legacyQuery, planImport } from './legacyMigration';
import { folderChoices, freeName, insertMenuNode, positionOf, toMenuNodes } from './menuModel';
import { Limiter, resolveRange, statementStep } from './queryExecution';
import { favorite, folder, statement, tree } from './testUtils';
import { ROOT } from './types';
import {
  heatmapUnitsFromPlan,
  heatmapValueSuffix,
  planUnitToUnitId,
  unitDisplay,
  visualizationFromPlan,
} from './units';

describe('units', () => {
  it('maps chart plan units to Grafana unit ids without scaling', () => {
    expect(planUnitToUnitId('')).toBe('none');
    expect(planUnitToUnitId('bytes')).toBe('bytes');
    expect(planUnitToUnitId('s')).toBe('s');
    expect(planUnitToUnitId('%')).toBe('percent');
    expect(planUnitToUnitId('°C')).toBe('celsius');
    expect(planUnitToUnitId('bytes/s')).toBe('Bps');
    expect(planUnitToUnitId('s/min')).toBe('s/min');
    expect(planUnitToUnitId('/s')).toBe('suffix:/s');
  });

  it('formats values by unit id and never changes them', () => {
    const theme = createTheme();
    const field: Field = { name: 'v', type: FieldType.number, config: {}, values: [] };
    const text = (unitId: string, value: number) => {
      const display = unitDisplay(field, unitId, theme)(value);
      return `${display.prefix ?? ''}${display.text}${display.suffix ?? ''}`.trim();
    };
    expect(text('percent', 25)).toBe('25%');
    expect(text('percentunit', 0.25)).toBe('25%');
    expect(text('bytes', 2048)).toBe('2 KiB');
    expect(text('ms', 1500)).toBe('1.50 s');
    expect(text('s/min', 0.002)).toBe('2 ms/min');
    expect(text('none', 12)).toBe('12');
  });

  it('derives visualization and heatmap units from a chart plan', () => {
    expect(visualizationFromPlan('heatmap')).toBe(VisualizationKind.HEATMAP);
    expect(visualizationFromPlan('stat')).toBe(VisualizationKind.STAT);
    expect(visualizationFromPlan('timeseries')).toBe(VisualizationKind.TIMESERIES);
    expect(heatmapUnitsFromPlan('http_duration_seconds_bucket', 'sum_by_le_rate')).toEqual({
      bucketUnitId: 's',
      valueUnitId: 'suffix:/s',
    });
    expect(heatmapUnitsFromPlan('size_bytes_bucket', 'sum_by_le_increase')).toEqual({
      bucketUnitId: 'bytes',
      valueUnitId: 'suffix:/min',
    });
    expect(heatmapValueSuffix('suffix:/s')).toBe('/s');
  });
});

describe('drafts', () => {
  it('stores filters without empty labels, sorted by label and value', () => {
    expect(
      savedFilters({ pod: [], namespace: ['prod', 'dev', 'prod'], job: ['api'] }).map((f) => [f.name, f.values])
    ).toEqual([
      ['job', ['api']],
      ['namespace', ['dev', 'prod']],
    ]);
  });

  it('describes the browse source, which survives editing the expression', () => {
    const byPod = updateStatement(statement(), {
      sourceScope: SourceScope.BY_POD,
      sourceScopeValue: 'api-server',
      sourceFilters: savedFilters({ namespace: ['prod'] }),
    });
    expect(describeSource(byPod)).toBe('By Pod · api-server · namespace = prod');
    expect(describeSource(updateStatement(byPod, { expression: 'changed' }))).toBe(
      'By Pod · api-server · namespace = prod'
    );
    const allMetrics = updateStatement(statement(), {
      sourceScope: SourceScope.BY_NAME,
      sourceFilters: savedFilters({ job: ['a', 'b'] }),
    });
    expect(describeSource(allMetrics)).toBe('By Name · All metrics · job ∈ {a, b}');
    expect(describeSource(statement())).toBeNull();
  });

  it('titles a statement by its metric, else its expression', () => {
    expect(statementTitle(updateStatement(statement('rate(x[5m])'), { sourceMetric: 'x' }))).toBe('x');
    expect(statementTitle(statement('sum(\n  rate(x[5m])\n)'))).toBe('sum( rate(x[5m]) )');
  });
});

describe('menu model', () => {
  const menu = () => toMenuNodes(tree(4, [folder(1, 'A', [favorite(2, 'F'), favorite(3, 'G')]), folder(4, 'B')]));

  it('converts ids to refs and describes positions', () => {
    const nodes = menu();
    expect(nodes[0].children.map((node) => node.ref)).toEqual(['2', '3']);
    expect(positionOf(nodes, '3')).toEqual({ parentId: '1', afterId: '2' });
    expect(positionOf(nodes, '1')).toEqual({ parentId: ROOT, afterId: null });
  });

  it('inserts drafts and names them uniquely', () => {
    const nodes = menu();
    insertMenuNode(
      nodes,
      { ref: 'tmp-x', name: freeName(nodes[0].children, 'F'), kind: NodeKind.FAVORITE, children: [], draft: true },
      {
        parentId: '1',
        afterId: '2',
      }
    );
    expect(nodes[0].children.map((node) => node.name)).toEqual(['F', 'F 2', 'G']);
    expect(
      insertMenuNode(
        nodes,
        { ref: 'tmp-y', name: 'x', kind: NodeKind.FOLDER, children: [], draft: true },
        { parentId: '2', afterId: null }
      )
    ).toBe(false);
  });

  it('lists folders for "Move to…" with their paths', () => {
    expect(folderChoices(menu()).map((choice) => choice.label)).toEqual(['Top level', 'A', 'B']);
  });
});

describe('query execution', () => {
  it('works out the step as the backend does: 1m for auto, raised for long ranges', () => {
    const last = (hours: number) => ({
      from: dateTime(0),
      to: dateTime(hours * 3_600_000),
      raw: { from: dateTime(0), to: dateTime(hours * 3_600_000) },
    });
    expect(statementStep('auto', last(1))).toBe('1m');
    expect(statementStep('auto', last(24))).toBe('2m');
    expect(statementStep('auto', last(24 * 7))).toBe('15m');
    expect(statementStep('5m', last(1))).toBe('5m');
    expect(statementStep('15s', last(6))).toBe('30s');
    expect(statementStep('1h', last(24 * 7))).toBe('1h');
    expect(statementStep('90s', last(1))).toBe('90s');
    expect(statementStep('120s', last(1))).toBe('2m');
  });

  it('moves a relative range to now and keeps an absolute one', () => {
    const old = { from: dateTime(0), to: dateTime(3_600_000), raw: { from: 'now-1h', to: 'now' } };
    const resolved = resolveRange(old);
    expect(resolved.to.valueOf()).toBeGreaterThan(Date.now() - 5_000);
    expect(resolved.to.valueOf() - resolved.from.valueOf()).toBe(3_600_000);
    const absolute = { from: dateTime(0), to: dateTime(1000), raw: { from: dateTime(0), to: dateTime(1000) } };
    expect(resolveRange(absolute)).toBe(absolute);
  });

  it('runs at most two tasks at once and drops aborted waiters', async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const task = () =>
      new Promise<void>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        releases.push(() => {
          active--;
          resolve();
        });
      });
    const controller = new AbortController();
    const runs = [limiter.run(task), limiter.run(task), limiter.run(task, controller.signal), limiter.run(task)];
    await Promise.resolve();
    expect(active).toBe(2);
    controller.abort();
    await expect(runs[2]).rejects.toMatchObject({ name: 'AbortError' });
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([runs[0], runs[1], runs[3]]);
    expect(peak).toBe(2);
  });
});

describe('legacy import', () => {
  const datasource = { uid: 'ds1', name: 'VM' };

  it('turns each metric into a one-statement query without browse source', () => {
    const query = legacyQuery('up', datasource);
    expect(query.name).toBe('up');
    expect(query.statements).toHaveLength(1);
    expect(query.statements[0]).toMatchObject({
      expression: 'up',
      datasourceUid: 'ds1',
      unitId: 'none',
      visualization: VisualizationKind.TIMESERIES,
      sourceMetric: 'up',
      sourceScope: SourceScope.UNSPECIFIED,
    });
  });

  it('skips duplicates of the same datasource and groups the rest by favorite size', () => {
    const metrics = Array.from({ length: MAX_QUERIES_PER_FAVORITE + 3 }, (_, index) => `m${index}`);
    const plan = planImport(metrics, datasource, new Set(['ds1\nm0', 'ds2\nm1']));
    expect(plan.skipped).toEqual(['m0']);
    expect(plan.batches.map((batch) => batch.length)).toEqual([MAX_QUERIES_PER_FAVORITE, 2]);
    expect(new Set(plan.batches.flat().map((query) => query.id)).size).toBe(MAX_QUERIES_PER_FAVORITE + 2);
  });

  it('finds the import folder at the top level only', () => {
    const nodes = toMenuNodes(tree(3, [folder(1, 'Imported favorites'), folder(2, 'x', [folder(3, 'Other')])]));
    expect(findImportFolder(nodes, ' Imported favorites ')?.ref).toBe('1');
    expect(findImportFolder(nodes, 'Other')).toBeUndefined();
  });
});
