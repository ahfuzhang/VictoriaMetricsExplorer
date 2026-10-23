import React, { useEffect, useState } from 'react';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, IconButton, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { fetchMetricIndex, fetchNodeGroups, fetchPodGroups, describeError, PodGroup } from '../api';
import { useFavorites } from '../favorites/FavoritesProvider';
import { FavoritesMenu } from '../favorites/components/FavoritesMenu';
import type { MetricScope } from './Explorer';

interface Props {
  datasourceUID: string;
  timeRange: TimeRange;
  scope: MetricScope;
  collapsed: boolean;
  onScopeChange: (scope: MetricScope) => void;
  onToggleCollapsed: () => void;
}

interface GroupItem {
  name: string;
  count: number;
}

export const TreeView: React.FC<Props> = ({
  datasourceUID,
  timeRange,
  scope: currentScope,
  collapsed,
  onScopeChange,
  onToggleCollapsed,
}) => {
  const styles = useStyles2(getStyles);
  // While a favorite is open, no browse scope is highlighted; picking one returns to browsing.
  const { selection } = useFavorites();
  const scope: MetricScope | null = selection ? null : currentScope;
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [metricCount, setMetricCount] = useState(0);
  // Branches start collapsed and only fetch their data once the user first expands them.
  const [metricsExpanded, setMetricsExpanded] = useState(false);
  const [metricsRequested, setMetricsRequested] = useState(false);
  const [podGroups, setPodGroups] = useState<PodGroup[]>([]);
  const [podLabel, setPodLabel] = useState('pod');
  const [podCount, setPodCount] = useState(0);
  const [podsExpanded, setPodsExpanded] = useState(false);
  const [podsRequested, setPodsRequested] = useState(false);
  const [podsLoading, setPodsLoading] = useState(false);
  const [podsError, setPodsError] = useState('');
  const [nodes, setNodes] = useState<string[]>([]);
  const [nodeLabel, setNodeLabel] = useState('node');
  const [nodesExpanded, setNodesExpanded] = useState(false);
  const [nodesRequested, setNodesRequested] = useState(false);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!metricsRequested) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');

    fetchMetricIndex(datasourceUID, {
      groupMode: 'prefix',
      page: 1,
      pageSize: 1,
      sort: 'name',
      startMs: timeRange.from.valueOf(),
      endMs: timeRange.to.valueOf(),
    })
      .then((response) => {
        if (!cancelled) {
          setGroups(response.groups ?? []);
          setMetricCount(response.totalCount);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(describeError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasourceUID, timeRange, metricsRequested]);

  useEffect(() => {
    if (!podsRequested) {
      return;
    }
    let cancelled = false;
    setPodsLoading(true);
    setPodsError('');

    fetchPodGroups(datasourceUID, {
      startMs: timeRange.from.valueOf(),
      endMs: timeRange.to.valueOf(),
    })
      .then((response) => {
        if (!cancelled) {
          setPodGroups(response.groups ?? []);
          setPodLabel(response.label);
          setPodCount(response.podCount);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPodGroups([]);
          setPodCount(0);
          setPodsError(describeError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPodsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasourceUID, timeRange, podsRequested]);

  useEffect(() => {
    if (!nodesRequested) {
      return;
    }
    let cancelled = false;
    setNodesLoading(true);
    setNodesError('');

    fetchNodeGroups(datasourceUID, {
      startMs: timeRange.from.valueOf(),
      endMs: timeRange.to.valueOf(),
    })
      .then((response) => {
        if (!cancelled) {
          setNodes(response.nodes ?? []);
          setNodeLabel(response.label);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setNodes([]);
          setNodesError(describeError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setNodesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [datasourceUID, timeRange, nodesRequested]);

  return (
    <nav
      className={`${styles.container} ${collapsed ? styles.containerCollapsed : ''}`}
      aria-label="Explorer navigation"
    >
      <div className={`${styles.header} ${collapsed ? styles.headerCollapsed : ''}`}>
        {!collapsed && (
          <>
            <span className={styles.stepNumber}>01</span>
            <h2 className={styles.title}>Explore</h2>
          </>
        )}
        <IconButton
          className={`${styles.collapseButton} ${collapsed ? styles.collapseButtonCollapsed : ''}`}
          name={collapsed ? 'angle-right' : 'angle-left'}
          size="md"
          tooltip={collapsed ? 'Expand explorer tree' : 'Collapse explorer tree'}
          tooltipPlacement="right"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        />
      </div>

      {!collapsed && (
        <div className={styles.tree}>
          <div role="tree" aria-label="Metric scopes">
            <div role="treeitem" aria-expanded={podsExpanded}>
              <button
                type="button"
                className={styles.branch}
                onClick={() => {
                  setPodsExpanded((expanded) => !expanded);
                  setPodsRequested(true);
                }}
              >
                <span className={styles.chevron}>{podsExpanded ? '▾' : '▸'}</span>
                <span>By Pod</span>
                <span className={styles.count} title={`${podCount} pods`}>
                  {podGroups.length || '—'}
                </span>
              </button>

              {podsExpanded && (
                <div className={styles.children} role="group">
                  {podsLoading && (
                    <div className={styles.loading}>
                      <LoadingPlaceholder text="Loading pods…" />
                    </div>
                  )}
                  {!podsLoading && podGroups.length === 0 && !podsError && (
                    <div className={styles.empty}>No series carry a “{podLabel}” label.</div>
                  )}
                  {!podsLoading &&
                    podGroups.map((group) => (
                      <TreeLeaf
                        key={group.name}
                        label={group.name}
                        count={group.count}
                        countTitle={`${group.count} pod${group.count !== 1 ? 's' : ''}`}
                        selected={scope?.kind === 'pod' && scope.group === group.name}
                        onClick={() => onScopeChange({ kind: 'pod', group: group.name, pods: group.pods })}
                        styles={styles}
                        monospace
                      />
                    ))}
                </div>
              )}
            </div>

            <div role="treeitem" aria-expanded={nodesExpanded}>
              <button
                type="button"
                className={styles.branch}
                onClick={() => {
                  setNodesExpanded((expanded) => !expanded);
                  setNodesRequested(true);
                }}
              >
                <span className={styles.chevron}>{nodesExpanded ? '▾' : '▸'}</span>
                <span>By Node</span>
                <span className={styles.count} title={`${nodes.length} nodes`}>
                  {nodes.length || '—'}
                </span>
              </button>

              {nodesExpanded && (
                <div className={styles.children} role="group">
                  {nodesLoading && (
                    <div className={styles.loading}>
                      <LoadingPlaceholder text="Loading nodes…" />
                    </div>
                  )}
                  {!nodesLoading && nodes.length === 0 && !nodesError && (
                    <div className={styles.empty}>No series carry a “{nodeLabel}” label.</div>
                  )}
                  {!nodesLoading &&
                    nodes.map((node) => (
                      <TreeLeaf
                        key={node}
                        label={node}
                        selected={scope?.kind === 'node' && scope.node === node}
                        onClick={() => onScopeChange({ kind: 'node', node })}
                        styles={styles}
                        monospace
                      />
                    ))}
                </div>
              )}
            </div>

            <div role="treeitem" aria-expanded={metricsExpanded}>
              <button
                type="button"
                className={styles.branch}
                onClick={() => {
                  setMetricsExpanded((expanded) => !expanded);
                  setMetricsRequested(true);
                }}
              >
                <span className={styles.chevron}>{metricsExpanded ? '▾' : '▸'}</span>
                <span>By Name</span>
                <span className={styles.count}>{metricCount || '—'}</span>
              </button>

              {metricsExpanded && (
                <div className={styles.children} role="group">
                  <TreeLeaf
                    label="All metrics"
                    count={metricCount}
                    selected={scope?.kind === 'all'}
                    onClick={() => onScopeChange({ kind: 'all' })}
                    styles={styles}
                  />
                  {loading && (
                    <div className={styles.loading}>
                      <LoadingPlaceholder text="Loading groups…" />
                    </div>
                  )}
                  {!loading &&
                    groups.map((group) => (
                      <TreeLeaf
                        key={group.name}
                        label={group.name}
                        count={group.count}
                        selected={scope?.kind === 'group' && scope.group === group.name}
                        onClick={() => onScopeChange({ kind: 'group', group: group.name })}
                        styles={styles}
                        monospace
                      />
                    ))}
                </div>
              )}
            </div>
          </div>

          <FavoritesMenu />
        </div>
      )}

      {!collapsed && error && (
        <div className={styles.error}>
          <Alert title="Cannot load metric groups" severity="warning">
            {error}
          </Alert>
        </div>
      )}

      {!collapsed && podsError && (
        <div className={styles.error}>
          <Alert title="Cannot load pod groups" severity="warning">
            {podsError}
          </Alert>
        </div>
      )}

      {!collapsed && nodesError && (
        <div className={styles.error}>
          <Alert title="Cannot load nodes" severity="warning">
            {nodesError}
          </Alert>
        </div>
      )}

      {!collapsed && <div className={styles.footer}>Choose a group, then narrow it with labels.</div>}
    </nav>
  );
};

interface TreeLeafProps {
  label: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
  styles: ReturnType<typeof getStyles>;
  monospace?: boolean;
  countTitle?: string;
}

const TreeLeaf: React.FC<TreeLeafProps> = ({ label, count, selected, onClick, styles, monospace, countTitle }) => (
  <button
    type="button"
    role="treeitem"
    aria-selected={selected}
    className={`${styles.leaf} ${selected ? styles.leafSelected : ''}`}
    onClick={onClick}
    title={label}
  >
    <span className={styles.dot} />
    <span className={`${styles.leafLabel} ${monospace ? styles.monospace : ''}`}>{label}</span>
    {count !== undefined && (
      <span className={styles.count} title={countTitle}>
        {count}
      </span>
    )}
  </button>
);

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  }),
  containerCollapsed: css({
    alignItems: 'stretch',
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  headerCollapsed: css({
    justifyContent: 'center',
    padding: theme.spacing(1, 0.5),
  }),
  collapseButton: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
    width: '28px',
    height: '28px',
    borderRadius: theme.shape.radius.default,
    flexShrink: 0,
    '&:hover': {
      background: theme.colors.action.hover,
    },
  }),
  collapseButtonCollapsed: css({
    marginLeft: 0,
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
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  }),
  tree: css({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: theme.spacing(0.5),
  }),
  branch: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    width: '100%',
    padding: theme.spacing(0.75, 0.5),
    border: 0,
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.primary,
    cursor: 'pointer',
    fontWeight: theme.typography.fontWeightMedium,
    textAlign: 'left',
    '&:hover': {
      background: theme.colors.action.hover,
    },
  }),
  chevron: css({
    width: '14px',
    color: theme.colors.text.secondary,
    flexShrink: 0,
  }),
  children: css({
    marginLeft: theme.spacing(1.25),
    paddingLeft: theme.spacing(0.75),
    borderLeft: `1px solid ${theme.colors.border.weak}`,
  }),
  leaf: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    width: '100%',
    padding: theme.spacing(0.625, 0.75),
    border: 0,
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.primary,
    cursor: 'pointer',
    textAlign: 'left',
    '&:hover': {
      background: theme.colors.action.hover,
    },
  }),
  leafSelected: css({
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    '&:hover': {
      background: theme.colors.primary.transparent,
      color: theme.colors.primary.text,
    },
  }),
  dot: css({
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'currentColor',
    flexShrink: 0,
  }),
  leafLabel: css({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: theme.typography.size.sm,
  }),
  monospace: css({
    fontFamily: theme.typography.fontFamilyMonospace,
  }),
  count: css({
    marginLeft: 'auto',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    fontVariantNumeric: 'tabular-nums',
  }),
  loading: css({
    padding: theme.spacing(1),
  }),
  empty: css({
    padding: theme.spacing(0.625, 0.75),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  error: css({
    padding: theme.spacing(0.5),
    flexShrink: 0,
  }),
  footer: css({
    padding: theme.spacing(1),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.4,
    flexShrink: 0,
  }),
});
