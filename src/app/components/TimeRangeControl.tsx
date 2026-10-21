import React, { useState } from 'react';
import { css } from '@emotion/css';
import { DateTime, GrafanaTheme2, SelectableValue, TimeRange, dateTime, rangeUtil } from '@grafana/data';
import { Button, DateTimePicker, InlineLabel, RadioButtonGroup, useStyles2 } from '@grafana/ui';

interface Props {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
}

const QUICK_RANGES: Array<SelectableValue<string>> = [
  { label: '15m', value: 'now-15m' },
  { label: '1h', value: 'now-1h' },
  { label: '6h', value: 'now-6h' },
  { label: '24h', value: 'now-24h' },
  { label: '7d', value: 'now-7d' },
];

const DATE_LABEL_WIDTH = 6;

function cloneDateTime(value: DateTime): DateTime {
  return dateTime(value.valueOf());
}

export const TimeRangeControl: React.FC<Props> = ({ value, onChange }) => {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(false);
  const [from, setFrom] = useState<DateTime>(() => cloneDateTime(value.from));
  const [to, setTo] = useState<DateTime>(() => cloneDateTime(value.to));

  const toggle = () => {
    if (!isOpen) {
      setFrom(cloneDateTime(value.from));
      setTo(cloneDateTime(value.to));
    }
    setIsOpen((open) => !open);
  };

  const cancel = () => {
    setFrom(cloneDateTime(value.from));
    setTo(cloneDateTime(value.to));
    setIsOpen(false);
  };

  const invalidRange = !from.isValid() || !to.isValid() || from.valueOf() > to.valueOf();
  const apply = () => {
    if (invalidRange) {
      return;
    }

    const nextFrom = cloneDateTime(from);
    const nextTo = cloneDateTime(to);
    onChange({ from: nextFrom, to: nextTo, raw: { from: nextFrom, to: nextTo } });
    setIsOpen(false);
  };

  const applyQuickRange = (rawFrom: string) => {
    onChange(rangeUtil.convertRawToRange({ from: rawFrom, to: 'now' }, 'browser'));
    setIsOpen(false);
  };

  const selectedQuickRange = typeof value.raw.from === 'string' && value.raw.to === 'now' ? value.raw.from : undefined;

  return (
    <div className={styles.container}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon="clock-nine"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={toggle}
      >
        {rangeUtil.describeTimeRange(value.raw, 'browser')}
      </Button>
      {isOpen && (
        <section className={styles.popover} role="dialog" aria-label="Select time range">
          <div className={styles.quickRange}>
            <span className={styles.label}>Quick range</span>
            <RadioButtonGroup
              aria-label="Quick range"
              options={QUICK_RANGES}
              value={selectedQuickRange}
              onChange={applyQuickRange}
              fullWidth
            />
          </div>
          <DateTimePicker
            label={<InlineLabel width={DATE_LABEL_WIDTH}>From</InlineLabel>}
            date={from}
            maxDate={to.toDate()}
            timeZone="browser"
            onChange={(date) => date && setFrom(date)}
          />
          <DateTimePicker
            label={<InlineLabel width={DATE_LABEL_WIDTH}>To</InlineLabel>}
            date={to}
            minDate={from.toDate()}
            timeZone="browser"
            onChange={(date) => date && setTo(date)}
          />
          {invalidRange && (
            <div className={styles.validation} role="alert">
              “From” must be before or equal to “To”.
            </div>
          )}
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={cancel}>
              Cancel
            </Button>
            <Button type="button" disabled={invalidRange} onClick={apply}>
              Apply time range
            </Button>
          </div>
        </section>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    position: 'relative',
  }),
  popover: css({
    position: 'absolute',
    top: `calc(100% + ${theme.spacing(1)})`,
    right: 0,
    zIndex: theme.zIndex.modal,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    width: '360px',
    maxWidth: `calc(100vw - ${theme.spacing(4)})`,
    padding: theme.spacing(2),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.elevated,
    boxShadow: theme.shadows.z3,
  }),
  validation: css({
    color: theme.colors.error.text,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  quickRange: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
  }),
  label: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  actions: css({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
  }),
});
