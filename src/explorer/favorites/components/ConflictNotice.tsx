import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import type { CommitFailure } from '../drafts';

export interface NoticeAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

/**
 * Why a save did not go through and what can be done (docs/plan_v3.md §7.4.6). There is never an
 * action that overwrites the server's data.
 */
export const ConflictNotice: React.FC<
  React.PropsWithChildren<{ failure: CommitFailure; actions?: NoticeAction[]; onDismiss?: () => void }>
> = ({ failure, actions = [], onDismiss, children }) => {
  const styles = useStyles2(getStyles);
  return (
    <Alert
      title={failure.title}
      severity={
        failure.kind === 'uncertain' || failure.kind === 'conflict' || failure.kind === 'busy' ? 'warning' : 'error'
      }
      onRemove={onDismiss}
    >
      <div>{failure.message}</div>
      {children}
      {actions.length > 0 && (
        <div className={styles.actions}>
          {actions.map((action) => (
            <Button key={action.label} size="sm" variant={action.variant ?? 'secondary'} onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </Alert>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  actions: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  }),
});
