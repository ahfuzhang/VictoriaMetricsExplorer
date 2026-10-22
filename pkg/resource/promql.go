package resource

import (
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
)

// PromQL text is built like every other string here: its length is counted first, one buffer of
// that size is allocated, and every part is appended. quotedLen and escapedLen count the escaped
// parts exactly, following the same rules as appendQuoted and appendEscaped.

const (
	lowerHex = "0123456789abcdef"
	// regexMetachars are the bytes regexp.QuoteMeta escapes.
	regexMetachars = `\.+*?()|[]{}^$`
	// maxStepLen is the longest text appendStep adds: an int64 and its unit.
	maxStepLen = bytesutil.MaxIntLen + 1
)

// quotedLen is len(strconv.Quote(s)).
func quotedLen(s string) int {
	return len(`""`) + escapedLen(s, false)
}

// appendQuoted appends s as a double-quoted string, exactly as strconv.Quote quotes it.
func appendQuoted(b []byte, s string) []byte {
	return append(appendEscaped(append(b, '"'), s, false), '"')
}

// escapedLen is the number of bytes appendEscaped adds for s.
func escapedLen(s string, regexMeta bool) int {
	n := 0
	for i := 0; i < len(s); {
		r, width := decodeRune(s[i:])
		if regexMeta && isRegexMetachar(r) {
			n += len(`\\`)
		}
		n += escapedRuneLen(r, width)
		i += width
	}
	return n
}

// appendEscaped appends s as the inside of a double-quoted string, escaped as strconv.Quote
// escapes it. With regexMeta, s is escaped as by regexp.QuoteMeta first, so the string is a regex
// matching s literally.
func appendEscaped(b []byte, s string, regexMeta bool) []byte {
	for i := 0; i < len(s); {
		r, width := decodeRune(s[i:])
		if regexMeta && isRegexMetachar(r) {
			b = append(b, `\\`...) // QuoteMeta's backslash, itself escaped
		}
		b = appendEscapedRune(b, r, s[i:i+width])
		i += width
	}
	return b
}

// decodeRune returns the first rune of s and its width; an invalid byte is utf8.RuneError of
// width 1.
func decodeRune(s string) (rune, int) {
	if s[0] < utf8.RuneSelf {
		return rune(s[0]), 1
	}
	return utf8.DecodeRuneInString(s)
}

func isRegexMetachar(r rune) bool {
	return r < utf8.RuneSelf && strings.IndexByte(regexMetachars, byte(r)) >= 0
}

// escapedRuneLen is the number of bytes appendEscapedRune adds for r, which is width bytes long.
func escapedRuneLen(r rune, width int) int {
	switch {
	case r == utf8.RuneError && width == 1:
		return 4 // \xNN
	case r == '"' || r == '\\':
		return 2
	case strconv.IsPrint(r):
		return width
	case shortEscape(r) != 0:
		return 2 // e.g. \n
	case r < ' ' || r == 0x7f:
		return 4 // \xNN
	case r < 0x10000:
		return 6 // \uNNNN
	default:
		return 10 // \UNNNNNNNN
	}
}

// appendEscapedRune appends r, whose UTF-8 bytes are raw, escaped as strconv.Quote escapes it.
func appendEscapedRune(b []byte, r rune, raw string) []byte {
	switch {
	case r == utf8.RuneError && len(raw) == 1:
		return append(b, '\\', 'x', lowerHex[raw[0]>>4], lowerHex[raw[0]&0xf])
	case r == '"' || r == '\\':
		return append(b, '\\', byte(r))
	case strconv.IsPrint(r):
		return append(b, raw...)
	case shortEscape(r) != 0:
		return append(b, '\\', shortEscape(r))
	case r < ' ' || r == 0x7f:
		return append(b, '\\', 'x', lowerHex[r>>4], lowerHex[r&0xf])
	case r < 0x10000:
		return append(b, '\\', 'u', lowerHex[r>>12&0xf], lowerHex[r>>8&0xf], lowerHex[r>>4&0xf], lowerHex[r&0xf])
	default:
		b = append(b, '\\', 'U')
		for shift := 28; shift >= 0; shift -= 4 {
			b = append(b, lowerHex[r>>shift&0xf])
		}
		return b
	}
}

// shortEscape returns the letter of r's one-letter escape, e.g. 'n' for a newline, or 0.
func shortEscape(r rune) byte {
	switch r {
	case '\a':
		return 'a'
	case '\b':
		return 'b'
	case '\f':
		return 'f'
	case '\n':
		return 'n'
	case '\r':
		return 'r'
	case '\t':
		return 't'
	case '\v':
		return 'v'
	}
	return 0
}

// valuesMatchLen is the number of bytes appendValuesMatch adds for values.
func valuesMatchLen(values []string) int {
	if len(values) == 1 {
		return len("=") + quotedLen(values[0])
	}
	n := len(`=~"^(?:)$"`) + len(values) - 1 // the | between values
	for _, v := range values {
		n += escapedLen(v, true)
	}
	return n
}

// appendValuesMatch appends the operator and value of a label matcher accepting any of values (at
// least one): ="v" for one value, otherwise an anchored regex matching each value literally,
// =~"^(?:v1|v2)$".
func appendValuesMatch(b []byte, values []string) []byte {
	if len(values) == 1 {
		return appendQuoted(append(b, '='), values[0])
	}
	b = append(b, `=~"^(?:`...)
	for i, v := range values {
		if i > 0 {
			b = append(b, '|')
		}
		b = appendEscaped(b, v, true)
	}
	return append(b, `)$"`...)
}

// selectorLabels returns the labels of filters that become matchers of a metric selector, sorted:
// valid label names other than __name__ that have values.
func selectorLabels(filters map[string][]string) []string {
	labels := make([]string, 0, len(filters))
	for label, values := range filters {
		if len(values) > 0 && label != "__name__" && promLabelNamePattern.MatchString(label) {
			labels = append(labels, label)
		}
	}
	sort.Strings(labels)
	return labels
}

// metricSelectorLen is the number of bytes appendMetricSelector adds.
func metricSelectorLen(metric string, filters map[string][]string, labels, matchers []string) int {
	n := len(`{__name__=}`) + quotedLen(metric)
	for _, label := range labels {
		n += len(",") + len(label) + valuesMatchLen(filters[label])
	}
	for _, m := range matchers {
		if m != "" {
			n += len(",") + len(m)
		}
	}
	return n
}

// appendMetricSelector appends the selector of metric: its name, a matcher for each of labels
// (from selectorLabels) accepting that label's filter values, then matchers; empty matchers are
// skipped.
func appendMetricSelector(b []byte, metric string, filters map[string][]string, labels, matchers []string) []byte {
	b = appendQuoted(append(b, `{__name__=`...), metric)
	for _, label := range labels {
		b = append(append(b, ','), label...)
		b = appendValuesMatch(b, filters[label])
	}
	for _, m := range matchers {
		if m != "" {
			b = append(append(b, ','), m...)
		}
	}
	return append(b, '}')
}

// appendStep appends whole seconds as a duration in the largest unit that keeps it exact, so a
// 90s step stays 90s instead of becoming 1m.
func appendStep(b []byte, sec int64) []byte {
	switch {
	case sec >= 3600 && sec%3600 == 0:
		return append(strconv.AppendInt(b, sec/3600, 10), 'h')
	case sec >= 60 && sec%60 == 0:
		return append(strconv.AppendInt(b, sec/60, 10), 'm')
	default:
		return append(strconv.AppendInt(b, sec, 10), 's')
	}
}
