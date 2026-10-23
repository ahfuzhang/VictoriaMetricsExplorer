import React, { useCallback, useEffect, useRef, useState } from 'react';
import { create } from '@bufbuild/protobuf';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { QueryStatementSchema, SourceScope, VisualizationKind } from '../../generated/explorer/user_storage_pb';
import { Capabilities } from '../model';
import { useFavorites } from '../favorites/FavoritesProvider';
import { SavedModeColumns } from '../favorites/components/SavedModeColumns';
import { savedFilters } from '../favorites/drafts';
import { heatmapUnitsFromPlan, planUnitToUnitId, visualizationFromPlan } from '../favorites/units';
import { TreeView } from './TreeView';
import { MetricList } from './MetricList';
import { FacetPanel } from './FacetPanel';
import { ChartPanel, type ChartSnapshot } from './ChartPanel';

interface Props {
  datasourceUID: string;
  capabilities: Capabilities;
  timeRange: TimeRange;
  step: string;
  refreshKey: number;
}

export interface SelectedFilters {
  [label: string]: string[];
}

export type MetricScope =
  | { kind: 'all' }
  | { kind: 'group'; group: string }
  | { kind: 'pod'; group: string; pods: string[] }
  | { kind: 'node'; node: string };

const COLUMN_WIDTHS_KEY = 'victoriametrics-explorer.columns.v1';
const RESIZE_HANDLE_WIDTH = 8;
const COLLAPSED_TREE_WIDTH = 44;
// The visualization column always fills the remaining width; below this the page scrolls horizontally.
const VISUALIZATION_MIN_WIDTH = 560;

type ColumnKey = 'tree' | 'metrics' | 'labels' | 'visualization';

interface ColumnWidths {
  tree: number;
  metrics: number;
  labels: number;
  visualization: number;
}

interface ResizeSnapshot {
  separatorIndex: number;
  pointerId: number;
  startX: number;
  leftWidth: number;
  rightWidth: number;
}

interface ColumnConfig {
  key: ColumnKey;
  min: number;
  max: number;
  defaultWidth: number;
}

const COLUMN_CONFIG: ColumnConfig[] = [
  { key: 'tree', min: 160, max: 420, defaultWidth: 210 },
  { key: 'metrics', min: 220, max: 600, defaultWidth: 280 },
  { key: 'labels', min: 240, max: 650, defaultWidth: 300 },
  {
    key: 'visualization',
    min: VISUALIZATION_MIN_WIDTH,
    max: Number.POSITIVE_INFINITY,
    defaultWidth: VISUALIZATION_MIN_WIDTH,
  },
];

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  tree: COLUMN_CONFIG[0].defaultWidth,
  metrics: COLUMN_CONFIG[1].defaultWidth,
  labels: COLUMN_CONFIG[2].defaultWidth,
  visualization: COLUMN_CONFIG[3].defaultWidth,
};

const SEPARATOR_LABELS = [
  'Resize explorer tree and metric names',
  'Resize metric names and label filters',
  'Resize label filters and visualization',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeColumnWidths(value: unknown): ColumnWidths {
  const stored = value && typeof value === 'object' ? (value as Partial<Record<ColumnKey, unknown>>) : {};
  return COLUMN_CONFIG.reduce<ColumnWidths>(
    (widths, config) => {
      const candidate = stored[config.key];
      widths[config.key] =
        typeof candidate === 'number' && Number.isFinite(candidate)
          ? clamp(Math.round(candidate), config.min, config.max)
          : config.defaultWidth;
      return widths;
    },
    { ...DEFAULT_COLUMN_WIDTHS }
  );
}

function readColumnWidths(): ColumnWidths {
  try {
    if (typeof window === 'undefined') {
      return { ...DEFAULT_COLUMN_WIDTHS };
    }
    const stored: unknown = JSON.parse(window.localStorage.getItem(COLUMN_WIDTHS_KEY) ?? 'null');
    return normalizeColumnWidths(stored);
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
}

function persistColumnWidths(widths: ColumnWidths): void {
  try {
    window.localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(normalizeColumnWidths(widths)));
  } catch {
    // Resizing remains available for this session when browser storage is unavailable.
  }
}

function removeStoredColumnWidths(): void {
  try {
    window.localStorage.removeItem(COLUMN_WIDTHS_KEY);
  } catch {
    // Reset the current session even when browser storage is unavailable.
  }
}

/** The browse source a saved statement records (docs/plan_v3.md §5.3). */
function sourceOf(scope: MetricScope): { sourceScope: SourceScope; sourceScopeValue: string } {
  switch (scope.kind) {
    case 'all':
      return { sourceScope: SourceScope.BY_NAME, sourceScopeValue: '' };
    case 'group':
      return { sourceScope: SourceScope.BY_NAME, sourceScopeValue: scope.group };
    case 'pod':
      // The pod prefix only, not the pods the group held at the time.
      return { sourceScope: SourceScope.BY_POD, sourceScopeValue: scope.group };
    case 'node':
      return { sourceScope: SourceScope.BY_NODE, sourceScopeValue: scope.node };
  }
}

export const Explorer: React.FC<Props> = ({ datasourceUID, capabilities, timeRange, step, refreshKey }) => {
  const styles = useStyles2(getStyles);
  const favorites = useFavorites();
  const { exitSavedMode, openSave } = favorites;
  // A favorite open in the menu replaces columns 2–4 with its query list and one wide chart column;
  // the browse selection below is kept meanwhile.
  const savedMode = favorites.selection !== null;

  const [scope, setScope] = useState<MetricScope>({ kind: 'all' });
  const [selectedMetric, setSelectedMetric] = useState('');
  const [filters, setFilters] = useState<SelectedFilters>({});
  // Labels the chart is summed by, picked under it from the labels the filters leave groupable.
  const [groupBy, setGroupBy] = useState<string[]>([]);
  // The groupable labels the label column last loaded, and the filters they were loaded for.
  const [groupable, setGroupable] = useState<{ filters: SelectedFilters; labels: string[] | null } | null>(null);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(readColumnWidths);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [activeSeparator, setActiveSeparator] = useState<number | null>(null);
  const columnWidthsRef = useRef(columnWidths);
  const resizeSnapshotRef = useRef<ResizeSnapshot | null>(null);
  const treeColumnRef = useRef<HTMLElement>(null);
  const metricsColumnRef = useRef<HTMLElement>(null);
  const labelsColumnRef = useRef<HTMLElement>(null);
  const visualizationColumnRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSelectedMetric('');
    setFilters({});
    setGroupBy([]);
    setGroupable(null);
    setScope({ kind: 'all' });
  }, [datasourceUID]);

  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  useEffect(() => {
    if (activeSeparator === null) {
      return;
    }
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [activeSeparator]);

  const handleMetricSelect = useCallback((metric: string) => {
    setSelectedMetric(metric);
    setFilters({});
    setGroupBy([]);
    setGroupable(null);
  }, []);

  const handleScopeChange = useCallback(
    (nextScope: MetricScope) => {
      exitSavedMode();
      setScope(nextScope);
      setSelectedMetric('');
      setFilters({});
      setGroupBy([]);
      setGroupable(null);
    },
    [exitSavedMode]
  );

  const handleFilterChange = useCallback((label: string, values: string[]) => {
    setFilters((previous) => {
      const next = { ...previous };
      if (values.length === 0) {
        delete next[label];
      } else {
        next[label] = values;
      }
      return next;
    });
  }, []);

  // A label the new filters leave with one value can no longer split the chart, so it is unpicked.
  const handleGroupableLabels = useCallback((loadedFilters: SelectedFilters, labels: string[] | null) => {
    setGroupable({ filters: loadedFilters, labels });
    if (labels) {
      setGroupBy((previous) => {
        const next = previous.filter((label) => labels.includes(label));
        return next.length === previous.length ? previous : next;
      });
    }
  }, []);

  // Prefill the save dialog with the chart on screen: its final expression (filters, pod or node
  // and rate already applied), unit, visualization, and where in the first column it came from.
  const handleFavorite = useCallback(
    ({ datasourceUID: uid, metric, plan }: ChartSnapshot) => {
      const visualization = visualizationFromPlan(plan.visualization);
      const heatmap =
        visualization === VisualizationKind.HEATMAP ? heatmapUnitsFromPlan(metric, plan.aggregation) : null;
      const statement = create(QueryStatementSchema, {
        expression: plan.query,
        datasourceUid: uid,
        datasourceNameHint: getDataSourceSrv().getInstanceSettings(uid)?.name ?? '',
        unitId: planUnitToUnitId(plan.unit),
        visualization,
        sourceMetric: metric,
        ...sourceOf(scope),
        sourceFilters: savedFilters(filters),
        heatmapBucketUnitId: heatmap?.bucketUnitId ?? '',
        heatmapValueUnitId: heatmap?.valueUnitId ?? '',
      });
      openSave({ queryName: metric, statement });
    },
    [filters, openSave, scope]
  );

  const readRenderedColumnWidths = useCallback((): ColumnWidths => {
    const refs = [treeColumnRef, metricsColumnRef, labelsColumnRef, visualizationColumnRef];
    return COLUMN_CONFIG.reduce<ColumnWidths>(
      (widths, config, index) => {
        const renderedWidth = refs[index].current?.getBoundingClientRect().width;
        if (config.key === 'tree' && treeCollapsed) {
          widths.tree = columnWidthsRef.current.tree;
          return widths;
        }
        widths[config.key] =
          renderedWidth && Number.isFinite(renderedWidth)
            ? clamp(Math.round(renderedWidth), config.min, config.max)
            : columnWidthsRef.current[config.key];
        return widths;
      },
      { ...columnWidthsRef.current }
    );
  }, [treeCollapsed]);

  const commitColumnWidths = useCallback((widths: ColumnWidths) => {
    columnWidthsRef.current = widths;
    setColumnWidths(widths);
  }, []);

  const resizeAdjacentColumns = useCallback(
    (separatorIndex: number, leftWidth: number, rightWidth: number, requestedDelta: number) => {
      const leftConfig = COLUMN_CONFIG[separatorIndex];
      const rightConfig = COLUMN_CONFIG[separatorIndex + 1];
      const pairWidth = leftWidth + rightWidth;
      const minimumLeft = Math.max(leftConfig.min, pairWidth - rightConfig.max);
      const maximumLeft = Math.min(leftConfig.max, pairWidth - rightConfig.min);
      const nextLeft = clamp(leftWidth + requestedDelta, minimumLeft, maximumLeft);
      const nextWidths = {
        ...columnWidthsRef.current,
        [leftConfig.key]: Math.round(nextLeft),
        [rightConfig.key]: Math.round(pairWidth - nextLeft),
      };
      commitColumnWidths(nextWidths);
      return nextWidths;
    },
    [commitColumnWidths]
  );

  const handleResizeStart = useCallback(
    (separatorIndex: number, event: React.PointerEvent<HTMLDivElement>) => {
      if ((treeCollapsed && separatorIndex === 0) || event.button !== 0 || !event.isPrimary) {
        return;
      }
      const renderedWidths = readRenderedColumnWidths();
      commitColumnWidths(renderedWidths);
      const leftKey = COLUMN_CONFIG[separatorIndex].key;
      const rightKey = COLUMN_CONFIG[separatorIndex + 1].key;
      resizeSnapshotRef.current = {
        separatorIndex,
        pointerId: event.pointerId,
        startX: event.clientX,
        leftWidth: renderedWidths[leftKey],
        rightWidth: renderedWidths[rightKey],
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setActiveSeparator(separatorIndex);
      event.preventDefault();
    },
    [commitColumnWidths, readRenderedColumnWidths, treeCollapsed]
  );

  const handleResizeMove = useCallback(
    (separatorIndex: number, event: React.PointerEvent<HTMLDivElement>) => {
      const snapshot = resizeSnapshotRef.current;
      if (!snapshot || snapshot.separatorIndex !== separatorIndex || snapshot.pointerId !== event.pointerId) {
        return;
      }
      resizeAdjacentColumns(separatorIndex, snapshot.leftWidth, snapshot.rightWidth, event.clientX - snapshot.startX);
    },
    [resizeAdjacentColumns]
  );

  const handleResizeEnd = useCallback((separatorIndex: number, event: React.PointerEvent<HTMLDivElement>) => {
    const snapshot = resizeSnapshotRef.current;
    if (!snapshot || snapshot.separatorIndex !== separatorIndex || snapshot.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeSnapshotRef.current = null;
    setActiveSeparator(null);
    persistColumnWidths(columnWidthsRef.current);
  }, []);

  const handleResizeKeyDown = useCallback(
    (separatorIndex: number, event: React.KeyboardEvent<HTMLDivElement>) => {
      if (treeCollapsed && separatorIndex === 0) {
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const renderedWidths = readRenderedColumnWidths();
      commitColumnWidths(renderedWidths);
      const leftConfig = COLUMN_CONFIG[separatorIndex];
      const rightConfig = COLUMN_CONFIG[separatorIndex + 1];
      const leftWidth = renderedWidths[leftConfig.key];
      const rightWidth = renderedWidths[rightConfig.key];
      const pairWidth = leftWidth + rightWidth;
      const minimumLeft = Math.max(leftConfig.min, pairWidth - rightConfig.max);
      const maximumLeft = Math.min(leftConfig.max, pairWidth - rightConfig.min);
      let delta: number;
      if (event.key === 'Home') {
        delta = minimumLeft - leftWidth;
      } else if (event.key === 'End') {
        delta = maximumLeft - leftWidth;
      } else {
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        delta = direction * (event.shiftKey ? 32 : 12);
      }
      const nextWidths = resizeAdjacentColumns(separatorIndex, leftWidth, rightWidth, delta);
      persistColumnWidths(nextWidths);
    },
    [commitColumnWidths, readRenderedColumnWidths, resizeAdjacentColumns, treeCollapsed]
  );

  const toggleTreeCollapsed = useCallback(() => {
    resizeSnapshotRef.current = null;
    setActiveSeparator(null);
    setTreeCollapsed((collapsed) => !collapsed);
  }, []);

  const resetColumnWidths = useCallback(() => {
    const defaults = { ...DEFAULT_COLUMN_WIDTHS };
    resizeSnapshotRef.current = null;
    setActiveSeparator(null);
    commitColumnWidths(defaults);
    removeStoredColumnWidths();
  }, [commitColumnWidths]);

  // Inside a pod group, labels and charts only look at series from pods with that name prefix.
  const podGroup = scope.kind === 'pod' ? scope.group : undefined;
  // Inside a node, labels and charts only look at series from that node.
  const node = scope.kind === 'node' ? scope.node : undefined;

  const renderedColumnWidths: ColumnWidths = {
    ...columnWidths,
    tree: treeCollapsed ? COLLAPSED_TREE_WIDTH : columnWidths.tree,
  };
  // The visualization width is only a drag-time snapshot: its track ignores it and takes the remaining
  // space, so the layout only overflows (and scrolls) when the viewport is narrower than the minimum.
  const gridTemplateColumns = COLUMN_CONFIG.map((config, index) => {
    const track =
      config.key === 'visualization' ? `minmax(${config.min}px, 1fr)` : `${renderedColumnWidths[config.key]}px`;
    return index === COLUMN_CONFIG.length - 1 ? track : `${track} ${RESIZE_HANDLE_WIDTH}px`;
  }).join(' ');
  const layoutMinimumWidth =
    COLUMN_CONFIG.reduce(
      (total, config) => total + (config.key === 'visualization' ? config.min : renderedColumnWidths[config.key]),
      0
    ) +
    RESIZE_HANDLE_WIDTH * (COLUMN_CONFIG.length - 1);

  const separator = (index: number) => {
    const disabled = treeCollapsed && index === 0;
    const leftConfig = COLUMN_CONFIG[index];
    const rightConfig = COLUMN_CONFIG[index + 1];
    const pairWidth = columnWidths[leftConfig.key] + columnWidths[rightConfig.key];
    const minimumLeft = Math.max(leftConfig.min, pairWidth - rightConfig.max);
    const maximumLeft = Math.min(leftConfig.max, pairWidth - rightConfig.min);
    return (
      <div
        className={`${styles.resizeHandle} ${activeSeparator === index ? styles.resizeHandleActive : ''} ${
          disabled ? styles.resizeHandleDisabled : ''
        }`}
        role="separator"
        aria-orientation="vertical"
        aria-label={SEPARATOR_LABELS[index]}
        aria-valuemin={Math.round(minimumLeft)}
        aria-valuemax={Math.round(maximumLeft)}
        aria-valuenow={Math.round(columnWidths[leftConfig.key])}
        aria-valuetext={`Left column width ${Math.round(columnWidths[leftConfig.key])} pixels`}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        title={
          disabled
            ? 'Expand the explorer tree to resize it'
            : 'Drag to resize · Arrow keys adjust · Double-click resets all columns'
        }
        onPointerDown={(event) => handleResizeStart(index, event)}
        onPointerMove={(event) => handleResizeMove(index, event)}
        onPointerUp={(event) => handleResizeEnd(index, event)}
        onPointerCancel={(event) => handleResizeEnd(index, event)}
        onLostPointerCapture={(event) => handleResizeEnd(index, event)}
        onKeyDown={(event) => handleResizeKeyDown(index, event)}
        onDoubleClick={resetColumnWidths}
      />
    );
  };

  const browseColumns = (
    <>
      <section ref={metricsColumnRef} className={styles.column} aria-label="Metric names">
        <MetricList
          datasourceUID={datasourceUID}
          capabilities={capabilities}
          selectedMetric={selectedMetric}
          scope={scope}
          timeRange={timeRange}
          refreshKey={refreshKey}
          onSelectMetric={handleMetricSelect}
        />
      </section>

      {separator(1)}

      <section ref={labelsColumnRef} className={styles.column} aria-label="Label filters">
        {selectedMetric ? (
          <FacetPanel
            key={selectedMetric}
            datasourceUID={datasourceUID}
            metric={selectedMetric}
            capabilities={capabilities}
            filters={filters}
            podGroup={podGroup}
            node={node}
            timeRange={timeRange}
            refreshKey={refreshKey}
            onFilterChange={handleFilterChange}
            onResetFilters={() => setFilters({})}
            onGroupableLabels={handleGroupableLabels}
          />
        ) : (
          <EmptyColumn title="03 · Label filters" message="Select a metric to inspect its label names and values." />
        )}
      </section>

      {separator(2)}

      <section
        ref={visualizationColumnRef}
        className={`${styles.column} ${styles.visualizationColumn}`}
        aria-label="Visualization"
      >
        {selectedMetric ? (
          <ChartPanel
            datasourceUID={datasourceUID}
            metric={selectedMetric}
            filters={filters}
            podGroup={podGroup}
            node={node}
            timeRange={timeRange}
            step={step}
            refreshKey={refreshKey}
            groupBy={groupBy}
            groupByOptions={groupable?.labels ?? []}
            // Until the label column has loaded the labels for new filters, a grouped chart waits so
            // it never draws a grouping those filters drop. Labels that failed to load drop none.
            groupByPending={groupBy.length > 0 && groupable?.filters !== filters}
            onGroupByChange={setGroupBy}
            onFavorite={handleFavorite}
            favoriteBlocked={favorites.writeBlocked}
          />
        ) : (
          <EmptyColumn
            title="04 · Visualization"
            message="Select a metric to render its chart, heatmap, or stat value."
            topAligned
          />
        )}
      </section>
    </>
  );

  // The query list keeps the metric names' track; the charts span the label and visualization
  // tracks, so the widths set while browsing still apply.
  const savedColumns = (
    <SavedModeColumns>
      {({ list, panel }) => (
        <>
          <section ref={metricsColumnRef} className={styles.column} aria-label="Saved queries">
            {list}
          </section>

          {separator(1)}

          <section className={`${styles.column} ${styles.savedChartsColumn}`} aria-label="Visualization">
            {panel}
          </section>
        </>
      )}
    </SavedModeColumns>
  );

  return (
    <div className={styles.scrollContainer}>
      <div className={styles.explorer} style={{ gridTemplateColumns, minWidth: `${layoutMinimumWidth}px` }}>
        <section ref={treeColumnRef} className={styles.column} aria-label="Explorer tree">
          <TreeView
            datasourceUID={datasourceUID}
            timeRange={timeRange}
            scope={scope}
            collapsed={treeCollapsed}
            onScopeChange={handleScopeChange}
            onToggleCollapsed={toggleTreeCollapsed}
          />
        </section>

        {separator(0)}

        {savedMode ? savedColumns : browseColumns}
      </div>
    </div>
  );
};

const EmptyColumn: React.FC<{ title: string; message: string; topAligned?: boolean }> = ({
  title,
  message,
  topAligned = false,
}) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={`${styles.emptyColumn} ${topAligned ? styles.emptyColumnTopAligned : ''}`}>
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  scrollContainer: css({
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
  }),
  explorer: css({
    display: 'grid',
    height: '100%',
    minHeight: 0,
    background: theme.colors.background.canvas,
  }),
  column: css({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
  }),
  visualizationColumn: css({
    justifyContent: 'flex-start',
  }),
  savedChartsColumn: css({
    gridColumn: 'span 3',
  }),
  resizeHandle: css({
    position: 'relative',
    zIndex: 2,
    width: `${RESIZE_HANDLE_WIDTH}px`,
    minWidth: `${RESIZE_HANDLE_WIDTH}px`,
    padding: 0,
    border: 0,
    background: 'transparent',
    cursor: 'col-resize',
    touchAction: 'none',
    '&::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: '3px',
      width: '2px',
      background: theme.colors.border.medium,
      transition: 'background-color 120ms ease, box-shadow 120ms ease',
    },
    '&:hover::before, &:focus-visible::before': {
      background: theme.colors.primary.main,
      boxShadow: `0 0 0 2px ${theme.colors.primary.transparent}`,
    },
    '&:focus-visible': {
      outline: 'none',
    },
  }),
  resizeHandleActive: css({
    '&::before': {
      background: theme.colors.primary.main,
      boxShadow: `0 0 0 2px ${theme.colors.primary.transparent}`,
    },
  }),
  resizeHandleDisabled: css({
    cursor: 'default',
    pointerEvents: 'none',
    '&::before': {
      background: theme.colors.border.weak,
      boxShadow: 'none',
    },
  }),
  emptyColumn: css({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing(1),
    height: '100%',
    padding: theme.spacing(2),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.sm,
    textAlign: 'center',
    '& strong': {
      color: theme.colors.text.primary,
    },
  }),
  emptyColumnTopAligned: css({
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    height: 'auto',
    minHeight: '96px',
    textAlign: 'left',
  }),
});
