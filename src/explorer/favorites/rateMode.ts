// The counter functions of a saved expression, rewritten while viewing a favorite. A statement saved
// from a counter chart runs `sum by () (rate(m[1m]))`, its window being the Step of the moment it
// was saved. Viewing it again sets the window to the current Step and, for per minute, the function
// to increase(): the expression the browse chart would send for the same choices. Only what is run
// and shown changes; the saved expression is untouched.

export type RateMode = 'rate' | 'increase' | 'irate';

export const RATE_MODE_OPTIONS: Array<{ label: string; value: RateMode }> = [
  { label: 'per second', value: 'rate' },
  { label: 'per minute', value: 'increase' },
  { label: 'per second (irate)', value: 'irate' },
];

// A heatmap counts bucket observations per second or per minute, like the browse heatmap.
export const HISTOGRAM_RATE_MODE_OPTIONS: Array<{ label: string; value: RateMode }> = RATE_MODE_OPTIONS.slice(0, 2);

const IDENTIFIER_START = /[A-Za-z_:]/;
const IDENTIFIER_PART = /[A-Za-z0-9_:]/;

function isRateMode(name: string): name is RateMode {
  return name === 'rate' || name === 'increase' || name === 'irate';
}

interface CounterCall {
  /** Offset of the function name. */
  start: number;
  name: RateMode;
  /** Offsets of the text between the brackets of the argument's window, e.g. "1m" of rate(m[1m]). */
  window: { start: number; end: number } | null;
}

/** The index past the string literal or comment starting at index, or index when none starts there. */
function skipLiteral(expression: string, index: number): number {
  const char = expression[index];
  if (char === '"' || char === "'" || char === '`') {
    let next = index + 1;
    while (next < expression.length && expression[next] !== char) {
      // Backtick strings are raw; the others escape with a backslash.
      next += char !== '`' && expression[next] === '\\' ? 2 : 1;
    }
    return next + 1;
  }
  if (char === '#') {
    const end = expression.indexOf('\n', index);
    return end < 0 ? expression.length : end;
  }
  return index;
}

/**
 * The window of the call whose argument list opens at `open`: the first [...] directly inside it.
 * A subquery ([1h:1m]) and a call without a window (MetricsQL allows rate(m)) have none.
 */
function callWindow(expression: string, open: number): CounterCall['window'] {
  let depth = 0;
  let index = open;
  while (index < expression.length) {
    const skipped = skipLiteral(expression, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = expression[index];
    if (char === '[' && depth === 1) {
      const close = expression.indexOf(']', index);
      return close < 0 || expression.slice(index, close).includes(':') ? null : { start: index + 1, end: close };
    }
    if (char === '(' || char === '{' || char === '[') {
      depth++;
    } else if ((char === ')' || char === '}' || char === ']') && --depth === 0) {
      return null;
    }
    index++;
  }
  return null;
}

/**
 * Every rate(), increase() and irate() call. Names inside string literals and comments, label names
 * and longer names such as rate_over_sum or increase_pure are not calls.
 */
function counterCalls(expression: string): CounterCall[] {
  const calls: CounterCall[] = [];
  let index = 0;
  while (index < expression.length) {
    const skipped = skipLiteral(expression, index);
    if (skipped !== index) {
      index = skipped;
    } else if (IDENTIFIER_START.test(expression[index])) {
      const start = index;
      while (index < expression.length && IDENTIFIER_PART.test(expression[index])) {
        index++;
      }
      const name = expression.slice(start, index);
      let next = index;
      while (next < expression.length && /\s/.test(expression[next])) {
        next++;
      }
      if (isRateMode(name) && expression[next] === '(') {
        calls.push({ start, name, window: callWindow(expression, next) });
      }
    } else {
      index++;
    }
  }
  return calls;
}

/**
 * The counter function an expression is drawn with, or null when it has none or mixes several
 * (e.g. a rate divided by an increase), where switching all of them would change its meaning.
 */
export function detectRateMode(expression: string): RateMode | null {
  const calls = counterCalls(expression);
  if (calls.length === 0 || calls.some((call) => call.name !== calls[0].name)) {
    return null;
  }
  return calls[0].name;
}

/**
 * The expression with every counter call renamed to `mode` and its window set to `window`, either
 * one when given; everything else is kept as written.
 */
export function rewriteCounterCalls(expression: string, change: { mode?: RateMode; window?: string }): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const call of counterCalls(expression)) {
    if (change.mode) {
      edits.push({ start: call.start, end: call.start + call.name.length, text: change.mode });
    }
    if (change.window && call.window) {
      edits.push({ ...call.window, text: change.window });
    }
  }
  if (edits.length === 0) {
    return expression;
  }
  // Applied in text order, however the calls nest.
  edits.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let from = 0;
  for (const edit of edits) {
    parts.push(expression.slice(from, edit.start), edit.text);
    from = edit.end;
  }
  parts.push(expression.slice(from));
  return parts.join('');
}

// Unit ids of a per-second rate and their per-minute twins, as a counter chart saves them.
const PER_MINUTE_UNITS: Record<string, string> = {
  Bps: 'bytes/min',
  's/s': 's/min',
  'suffix:/s': 'suffix:/min',
};
const PER_SECOND_UNITS: Record<string, string> = Object.fromEntries(
  Object.entries(PER_MINUTE_UNITS).map(([perSecond, perMinute]) => [perMinute, perSecond])
);

/** The unit id that matches a switched counter function; other units are kept as saved. */
export function unitForRateMode(unitId: string, mode: RateMode): string {
  const units = mode === 'increase' ? PER_MINUTE_UNITS : PER_SECOND_UNITS;
  return units[unitId] ?? unitId;
}
