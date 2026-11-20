package resource

import (
	"context"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
)

// The label-values API has a limit but no paging, and one request for every value of a big label
// can time out. shardedLabelValues therefore asks for the values in shards: the values starting
// with a, b or c, those starting with d, e or f, and so on. A shard that comes back with as many
// values as the limit may have been cut short, so it is asked for again, split by its next
// character.

const (
	// labelValuesConcurrency bounds the label-values requests one sharded fetch has in flight.
	labelValuesConcurrency = 8
	// labelValuesMaxRequests bounds the requests of one sharded fetch, splits included. A shard
	// still cut short when it is reached is kept as it came back, and the result is partial.
	labelValuesMaxRequests = 256
)

// labelValueGroupChars group the characters a value can go on with after a shard's prefix: the
// first character of the value for the first shards. Metric names start with a letter, '_' or ':',
// pod names with a lowercase letter or a digit; any other character ('/', '@', non-ASCII...) falls
// into the catch-all group after these.
var labelValueGroupChars = [...]string{
	"abc", "def", "ghi", "jkl", "mno", "pqr", "stu", "vwxyz",
	"ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	"0123456789",
	"_:-.",
}

// labelValueGroup is one group of characters a value can go on with after a shard's prefix.
type labelValueGroup struct {
	chars string // the characters; "" for the catch-all, which cannot be split
	class string // the regex character class matching one of them, e.g. "[abc]"
}

// labelValueGroups are labelValueGroupChars, then the catch-all of every other character.
var labelValueGroups = buildLabelValueGroups(labelValueGroupChars[:])

func buildLabelValueGroups(sets []string) []labelValueGroup {
	all := 0
	for _, s := range sets {
		all += classCharsLen(s)
	}
	groups := make([]labelValueGroup, 0, len(sets)+1)
	other := append(make([]byte, 0, len("[^]")+all), "[^"...)
	for _, s := range sets {
		class := append(make([]byte, 0, len("[]")+classCharsLen(s)), '[')
		class = append(appendClassChars(class, s), ']')
		groups = append(groups, labelValueGroup{chars: s, class: bytesutil.ToUnsafeString(class)})
		other = appendClassChars(other, s)
	}
	return append(groups, labelValueGroup{class: bytesutil.ToUnsafeString(append(other, ']'))})
}

// classMetachars are the bytes with a meaning inside a regex character class.
const classMetachars = `\[]^-`

// classCharsLen is the number of bytes appendClassChars adds for s.
func classCharsLen(s string) int {
	n := len(s)
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(classMetachars, s[i]) >= 0 {
			n++
		}
	}
	return n
}

// appendClassChars appends the ASCII characters s to a regex character class, escaping those with
// a meaning inside one.
func appendClassChars(b []byte, s string) []byte {
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(classMetachars, s[i]) >= 0 {
			b = append(b, '\\')
		}
		b = append(b, s[i])
	}
	return b
}

// labelValueShard is a set of label values requested on its own: the values that start with
// prefix and, with a group, go on with one of its characters.
type labelValueShard struct {
	prefix string
	// group is the character after prefix; nil means every value starting with prefix, prefix
	// itself included.
	group *labelValueGroup
	// exact narrows the shard to the value prefix alone.
	exact bool
}

// prefixShards returns the shards of the values that start with prefix and go on: one per group,
// plus the shard of prefix alone when withExact.
func prefixShards(prefix string, withExact bool) []labelValueShard {
	n := len(labelValueGroups)
	if withExact {
		n++
	}
	shards := make([]labelValueShard, 0, n)
	if withExact {
		shards = append(shards, labelValueShard{prefix: prefix, exact: true})
	}
	for i := range labelValueGroups {
		shards = append(shards, labelValueShard{prefix: prefix, group: &labelValueGroups[i]})
	}
	return shards
}

// split returns narrower shards that together hold the values of s, or nil when s cannot be split.
func (s *labelValueShard) split() []labelValueShard {
	switch {
	case s.exact:
		return nil // one value at most
	case s.group == nil:
		return prefixShards(s.prefix, true)
	case s.group.chars == "":
		return nil // the catch-all
	}
	chars := s.group.chars
	shards := make([]labelValueShard, len(chars))
	for i := range chars {
		shards[i] = labelValueShard{prefix: s.prefix + chars[i:i+1]}
	}
	return shards
}

// selector returns the series selector of the shard's values on label, e.g. {pod=~"ab[cde].*"},
// or {pod="ab"} for an exact shard.
func (s *labelValueShard) selector(label string) string {
	if s.exact {
		b := make([]byte, 0, len("{=}")+len(label)+quotedLen(s.prefix))
		b = append(append(append(b, '{'), label...), '=')
		return bytesutil.ToUnsafeString(append(appendQuoted(b, s.prefix), '}'))
	}
	class := ""
	if s.group != nil {
		class = s.group.class
	}
	b := make([]byte, 0, len(`{=~".*"}`)+len(label)+escapedLen(s.prefix, true)+escapedLen(class, false))
	b = append(append(append(b, '{'), label...), `=~"`...)
	b = appendEscaped(appendEscaped(b, s.prefix, true), class, false)
	return bytesutil.ToUnsafeString(append(b, `.*"}`...))
}

// shardedLabelValues returns the values of label in [start, end), sorted. They are requested in
// shards, in parallel; a shard that comes back with MaxMetricNamesHard values may have been cut
// short and is requested again, split further. The result is partial when the datasource said so
// or a shard could not be split any further.
func (h *Handlers) shardedLabelValues(ctx context.Context, label string, start, end time.Time) ([]string, bool, error) {
	limit := h.router.limits.MaxMetricNamesHard
	shards := prefixShards("", false)
	requests := len(shards)
	var parts [][]string
	total, partial := 0, false
	for len(shards) > 0 {
		results, err := h.fetchLabelValueShards(ctx, label, shards, start, end, limit)
		if err != nil {
			return nil, false, err
		}
		var next []labelValueShard
		for i := range results {
			r := &results[i]
			partial = partial || r.partial
			if limit > 0 && len(r.values) >= limit {
				if children := shards[i].split(); len(children) > 0 && requests+len(children) <= labelValuesMaxRequests {
					requests += len(children)
					next = append(next, children...)
					continue
				}
				partial = true // keep the values that came back
			}
			parts = append(parts, r.values)
			total += len(r.values)
		}
		shards = next
	}

	values := make([]string, 0, total)
	for _, p := range parts {
		values = append(values, p...)
	}
	slices.Sort(values)
	// The shards do not overlap, so this only drops what a datasource may have sent twice.
	return slices.Compact(values), partial, nil
}

// labelValuesResult is the answer to one shard's request.
type labelValuesResult struct {
	values  []string
	partial bool
}

// fetchLabelValueShards requests the values of every shard, labelValuesConcurrency at a time. The
// first error cancels the requests still running and is returned.
func (h *Handlers) fetchLabelValueShards(ctx context.Context, label string, shards []labelValueShard, start, end time.Time, limit int) ([]labelValuesResult, error) {
	results := make([]labelValuesResult, len(shards))
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	var next atomic.Int64
	var wg sync.WaitGroup
	for range min(labelValuesConcurrency, len(shards)) {
		wg.Go(func() {
			for {
				i := int(next.Add(1) - 1)
				if i >= len(shards) || ctx.Err() != nil {
					return
				}
				// 分片拉取 label values, 例如 __name__
				values, partial, err := h.router.client.LabelValues(ctx, label, []string{shards[i].selector(label)}, start, end, limit)
				if err != nil {
					cancel(err)
					return
				}
				results[i] = labelValuesResult{values: values, partial: partial}
			}
		})
	}
	wg.Wait()
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	return results, nil
}
