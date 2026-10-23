import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

// The column chrome of the Explorer (numbered header, scrolling body, footer), shared by the
// saved-mode columns so they look like the browse columns they replace.
export const columnStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  }),
  header: css({
    padding: theme.spacing(1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  headingRow: css({
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
    flexShrink: 0,
  }),
  title: css({
    margin: 0,
    flex: 1,
    minWidth: 0,
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightBold,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  body: css({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
  }),
  footer: css({
    padding: theme.spacing(0.5, 1),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  empty: css({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(3, 2),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.sm,
    textAlign: 'center',
    '& strong': {
      color: theme.colors.text.primary,
    },
  }),
});
