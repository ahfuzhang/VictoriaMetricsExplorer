package cache

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

// clock is a settable time source for Cache.now.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

// newTestCache returns a cache of maxBytes driven by a clock that only moves when told to.
func newTestCache(t *testing.T, maxBytes int) (*Cache, *clock) {
	t.Helper()
	c := New(maxBytes)
	t.Cleanup(c.Close)
	clk := &clock{t: time.UnixMilli(1_700_000_000_000)}
	c.now = clk.now
	return c, clk
}

// stored returns the CacheValue under key as fastcache holds it.
func stored(t *testing.T, s *Scope, key string) *explorerpb.CacheValue {
	t.Helper()
	raw := s.c.fc.GetBig(nil, s.key(key))
	if raw == nil {
		t.Fatalf("nothing stored under %q", key)
	}
	var v explorerpb.CacheValue
	if err := proto.Unmarshal(raw, &v); err != nil {
		t.Fatalf("value under %q is not a CacheValue: %v", key, err)
	}
	return &v
}

func marshal(t *testing.T, msg proto.Message) []byte {
	t.Helper()
	data, err := proto.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// sized returns a message whose protobuf is exactly n bytes long.
func sized(t *testing.T, n int) *explorerpb.MetricTypeCacheEntry {
	t.Helper()
	// The string field costs a tag byte and a length varint on top of its length.
	for l := max(0, n-11); l <= n; l++ {
		if m := (&explorerpb.MetricTypeCacheEntry{Type: strings.Repeat("a", l)}); proto.Size(m) == n {
			return m
		}
	}
	t.Fatalf("no message is %d bytes long", n)
	return nil
}

func TestSetGet(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	s := c.Scope()

	want := &explorerpb.NodeGroupsCacheEntry{Label: "node", Nodes: []string{"n1", "n2"}, Partial: true}
	s.Set("k", want)

	var got explorerpb.NodeGroupsCacheEntry
	if !s.Get("k", time.Minute, &got) {
		t.Fatal("expected a hit")
	}
	if !proto.Equal(&got, want) {
		t.Fatalf("got %v, want %v", &got, want)
	}
	if s.Get("never-set", time.Minute, &got) {
		t.Fatal("expected a miss for a key that was never set")
	}
}

func TestValuesCarryTheirWriteTime(t *testing.T) {
	c, clk := newTestCache(t, 32<<20)
	s := c.Scope()

	s.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "gauge"})
	if got, want := stored(t, s, "k").WrittenAtMs, clk.t.UnixMilli(); got != want {
		t.Fatalf("written_at_ms = %d, want %d", got, want)
	}

	// Writing the key again replaces both the value and its write time.
	clk.advance(90 * time.Second)
	s.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "counter"})
	if got, want := stored(t, s, "k").WrittenAtMs, clk.t.UnixMilli(); got != want {
		t.Fatalf("after a rewrite written_at_ms = %d, want %d", got, want)
	}
	var got explorerpb.MetricTypeCacheEntry
	if !s.Get("k", time.Minute, &got) || got.Type != "counter" {
		t.Fatalf("expected the rewritten value, got %v", &got)
	}
}

func TestCompressesPayloadsLongerThan256Bytes(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	s := c.Scope()

	for _, tc := range []struct {
		size int
		zstd bool
	}{
		// An empty message is still a hit: the write time keeps the stored value non-empty, which
		// fastcache would otherwise not tell apart from a miss.
		{0, false},
		{3, false},
		{256, false},
		{257, true},
		{64 << 10, true},
	} {
		key := fmt.Sprint(tc.size)
		msg := sized(t, tc.size)
		s.Set(key, msg)

		v := stored(t, s, key)
		if v.Zstd != tc.zstd {
			t.Errorf("%d-byte payload: zstd = %v, want %v", tc.size, v.Zstd, tc.zstd)
			continue
		}
		payload := v.Payload
		if tc.zstd {
			if len(payload) >= tc.size {
				t.Errorf("%d-byte payload: compressed to %d bytes", tc.size, len(payload))
			}
			var err error
			if payload, err = decoder.DecodeAll(payload, nil); err != nil {
				t.Errorf("%d-byte payload: not a zstd frame: %v", tc.size, err)
				continue
			}
		}
		if !bytes.Equal(payload, marshal(t, msg)) {
			t.Errorf("%d-byte payload: stored bytes are not the message's protobuf", tc.size)
		}

		var got explorerpb.MetricTypeCacheEntry
		if !s.Get(key, time.Minute, &got) || !proto.Equal(&got, msg) {
			t.Errorf("%d-byte payload: did not round-trip", tc.size)
		}
	}
}

// fastcache's Set drops values of 64KB and more; they must still be stored.
func TestValuesOver64KBAreStored(t *testing.T) {
	// Big enough that the value's 64KB pieces never evict each other.
	c, _ := newTestCache(t, 256<<20)
	s := c.Scope()

	big := make([]byte, 300<<10)
	_, _ = rand.Read(big) // incompressible, so the stored payload stays over 64KB
	s.Set("big", wrapperspb.Bytes(big))

	if v := stored(t, s, "big"); !v.Zstd || len(v.Payload) < 64<<10 {
		t.Fatalf("expected a compressed payload over 64KB, got zstd=%v len=%d", v.Zstd, len(v.Payload))
	}
	var got wrapperspb.BytesValue
	if !s.Get("big", time.Minute, &got) || !bytes.Equal(got.Value, big) {
		t.Fatal("a 300KB value should round-trip")
	}
}

func TestGetZstdReturnsAWireBody(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	s := c.Scope()

	for _, size := range []int{0, 100, 256, 257, 4000} {
		key := fmt.Sprint(size)
		want := sized(t, size)
		s.Set(key, want)

		body, ok := s.GetZstd(key, time.Minute)
		if !ok {
			t.Fatalf("%d-byte payload: expected a hit", size)
		}
		var got explorerpb.MetricTypeCacheEntry
		if err := wire.Decode(body, &got); err != nil || !proto.Equal(&got, want) {
			t.Fatalf("%d-byte payload: body does not decode to the message (err=%v)", size, err)
		}
		// A payload that is already compressed is returned as stored.
		if v := stored(t, s, key); v.Zstd && !bytes.Equal(body, v.Payload) {
			t.Fatalf("%d-byte payload: compressed payload was not returned as is", size)
		}
	}
	if _, ok := s.GetZstd("never-set", time.Minute); ok {
		t.Fatal("expected a miss for a key that was never set")
	}
}

func TestFreshnessIsJudgedOnReadFromTheWriteTime(t *testing.T) {
	for _, tc := range []struct {
		name   string
		age    time.Duration // read time minus write time
		maxAge time.Duration
		hit    bool
	}{
		{"just written", 0, time.Minute, true},
		{"exactly maxAge old", time.Minute, time.Minute, true},
		{"older than maxAge", time.Minute + time.Millisecond, time.Minute, false},
		{"a reader with a longer TTL still accepts it", time.Minute + time.Millisecond, 2 * time.Minute, true},
		{"zero maxAge never hits", 0, 0, false},
		{"negative maxAge never hits", 0, -time.Minute, false},
		{"written in the future: the clock went back", -time.Second, time.Hour, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, clk := newTestCache(t, 32<<20)
			s := c.Scope()
			s.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "gauge"})
			clk.advance(tc.age)

			var got explorerpb.MetricTypeCacheEntry
			if hit := s.Get("k", tc.maxAge, &got); hit != tc.hit {
				t.Fatalf("Get hit = %v, want %v", hit, tc.hit)
			}
			if _, hit := s.GetZstd("k", tc.maxAge); hit != tc.hit {
				t.Fatalf("GetZstd hit = %v, want %v", hit, tc.hit)
			}
		})
	}
}

func TestBadEntriesAreMisses(t *testing.T) {
	c, clk := newTestCache(t, 32<<20)
	s := c.Scope()
	now := clk.t.UnixMilli()

	for name, raw := range map[string][]byte{
		"not a CacheValue":         {0xff, 0xff, 0xff},
		"zstd flag on plain bytes": marshal(t, &explorerpb.CacheValue{WrittenAtMs: now, Zstd: true, Payload: []byte("plain")}),
		"payload is not protobuf":  marshal(t, &explorerpb.CacheValue{WrittenAtMs: now, Payload: []byte{0xff, 0xff}}),
		"no write time":            marshal(t, &explorerpb.CacheValue{Payload: marshal(t, &explorerpb.MetricTypeCacheEntry{Type: "gauge"})}),
	} {
		s.c.fc.SetBig(s.key(name), raw)
		var got explorerpb.MetricTypeCacheEntry
		if s.Get(name, time.Hour, &got) {
			t.Errorf("%s: expected a miss", name)
		}
	}
}

func TestUnmarshallableMessagesAreNotStored(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	s := c.Scope()

	s.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "\xff"}) // proto3 strings must be valid UTF-8
	if c.fc.GetBig(nil, s.key("k")) != nil {
		t.Fatal("a message that cannot be marshalled must not be stored")
	}
}

func TestScopesDoNotShareKeys(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	a, b := c.Scope(), c.Scope()

	a.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "gauge"})
	var got explorerpb.MetricTypeCacheEntry
	if b.Get("k", time.Minute, &got) {
		t.Fatal("scope b must not see scope a's entry")
	}

	b.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "counter"})
	if !a.Get("k", time.Minute, &got) || got.Type != "gauge" {
		t.Fatalf("scope a: got %v, want gauge", &got)
	}
	if !b.Get("k", time.Minute, &got) || got.Type != "counter" {
		t.Fatalf("scope b: got %v, want counter", &got)
	}
}

func TestPurgeDropsOnlyTheScopesEntries(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	a, b := c.Scope(), c.Scope()
	keys := []string{"k1", "k2", "k3"}
	for _, s := range []*Scope{a, b} {
		for _, k := range keys {
			s.Set(k, &explorerpb.MetricTypeCacheEntry{Type: "gauge"})
		}
	}

	a.Purge()
	var got explorerpb.MetricTypeCacheEntry
	for _, k := range keys {
		if a.Get(k, time.Minute, &got) {
			t.Fatalf("%s: purged scope still hits", k)
		}
		if !b.Get(k, time.Minute, &got) {
			t.Fatalf("%s: purging scope a dropped scope b's entry", k)
		}
	}

	// A later scope must not land in the namespace a just left.
	if c.Scope().Get("k1", time.Minute, &got) {
		t.Fatal("a new scope sees entries purged from another scope")
	}

	// The purged scope keeps working.
	a.Set("k1", &explorerpb.MetricTypeCacheEntry{Type: "counter"})
	if !a.Get("k1", time.Minute, &got) || got.Type != "counter" {
		t.Fatalf("after a purge: got %v, want counter", &got)
	}
}

func TestCloseEmptiesTheCacheAndStopsWrites(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	s := c.Scope()
	s.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "gauge"})

	c.Close()
	var got explorerpb.MetricTypeCacheEntry
	if s.Get("k", time.Minute, &got) {
		t.Fatal("a closed cache must be empty")
	}
	if st := c.Stats(); st.Entries != 0 || st.TotalBytes != 0 {
		t.Fatalf("a closed cache must hand back its memory, stats %+v", st)
	}

	s.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "gauge"})
	if s.Get("k", time.Minute, &got) {
		t.Fatal("a closed cache must store nothing")
	}
}

func TestNewSizesTheCache(t *testing.T) {
	for _, tc := range []struct {
		maxBytes int
		want     uint64
	}{
		{0, DefaultMaxBytes},
		{-1, DefaultMaxBytes},
		{64 << 20, 64 << 20},
		{1 << 20, 32 << 20}, // fastcache's minimum
	} {
		c := New(tc.maxBytes)
		got := c.Stats().MaxBytes
		c.Close()
		if got != tc.want {
			t.Errorf("New(%d): capacity %d, want %d", tc.maxBytes, got, tc.want)
		}
	}
	if DefaultMaxBytes != 1<<30 {
		t.Fatalf("the default capacity should be 1GB, is %d", DefaultMaxBytes)
	}
}

func TestStats(t *testing.T) {
	c, _ := newTestCache(t, 32<<20)
	if st := c.Stats(); st.Entries != 0 || st.TotalBytes != 0 || st.MaxBytes != 32<<20 {
		t.Fatalf("a new cache: stats %+v", st)
	}

	s := c.Scope()
	s.Set("k", &explorerpb.MetricTypeCacheEntry{Type: "gauge"})
	st := s.Stats()
	if st != c.Stats() {
		t.Fatalf("a scope reports the shared cache: %+v != %+v", st, c.Stats())
	}
	// A small value takes two fastcache records: its metadata and one piece.
	if st.Entries != 2 || st.TotalBytes == 0 || st.TotalBytes > st.MaxBytes {
		t.Fatalf("after one Set: stats %+v", st)
	}
}

// written reports whether v is a whole value of a TestConcurrentUse writer: writer w writes the
// w-th letter 100*(w+1) times, so a value mixing two writes is not one of them.
func written(v string) bool {
	return v != "" && v == strings.Repeat(v[:1], 100*int(v[0]-'a'+1))
}

func TestConcurrentUse(t *testing.T) {
	c, _ := newTestCache(t, 64<<20)
	s := c.Scope()

	const writers, rounds, keys = 8, 300, 20
	var wg sync.WaitGroup
	for w := range writers {
		wg.Go(func() {
			// 100 to 800 bytes: payloads on both sides of the compression threshold.
			value := strings.Repeat(string(rune('a'+w)), 100*(w+1))
			for i := range rounds {
				key := fmt.Sprint(i % keys)
				s.Set(key, &explorerpb.MetricTypeCacheEntry{Type: value})

				var got explorerpb.MetricTypeCacheEntry
				if s.Get(key, time.Minute, &got) && !written(got.Type) {
					t.Errorf("Get under %s: torn value of %d bytes", key, len(got.Type))
					return
				}
				if body, ok := s.GetZstd(key, time.Minute); ok {
					if err := wire.Decode(body, &got); err != nil || !written(got.Type) {
						t.Errorf("GetZstd under %s: bad body (err=%v)", key, err)
						return
					}
				}
				if i%100 == 99 {
					s.Purge()
				}
			}
		})
	}
	wg.Wait()
}

func TestCacheKey(t *testing.T) {
	key1 := CacheKey("metrics", "ds1", "fingerprint1")
	key2 := CacheKey("metrics", "ds1", "fingerprint1")
	key3 := CacheKey("metrics", "ds1", "fingerprint2")

	if key1 != key2 {
		t.Fatal("same inputs should produce same key")
	}
	if key1 == key3 {
		t.Fatal("different fingerprints should produce different keys")
	}
	// The separators keep the parts apart: "ab"+"c" is not "a"+"bc".
	if CacheKey("ab", "c") == CacheKey("a", "bc") {
		t.Fatal("moving a byte between parts should change the key")
	}
	if len(key1) != 64 {
		t.Fatalf("key length = %d, want 64 hex digits", len(key1))
	}
}

func TestAppendKey(t *testing.T) {
	size := KeySize("metric-index", "") + MaxIntKeySize + MaxUintKeySize + MaxBoolKeySize
	b := make([]byte, 0, size)
	b = AppendKey(b, "metric-index", "")
	b = AppendKeyInt(b, -1<<63)
	b = AppendKeyUint(b, 1<<64-1)
	b = AppendKeyBool(b, false)
	if len(b) != size || cap(b) != size {
		t.Fatalf("the largest values should fill the sized buffer exactly: len %d, cap %d, size %d", len(b), cap(b), size)
	}
	want := "metric-index\x00\x00-9223372036854775808\x0018446744073709551615\x00false\x00"
	if string(b) != want {
		t.Fatalf("key bytes = %q, want %q", b, want)
	}
	if HashKey(AppendKey(nil, "a", "b")) != CacheKey("a", "b") {
		t.Fatal("CacheKey should be HashKey of AppendKey")
	}
}

func BenchmarkCacheKey(b *testing.B) {
	parts := []string{"facets-v2", "datasource-uid-abcdef",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"http_requests_total", `job="api-server",namespace="production",pod=~"api-.*"`}
	b.ReportAllocs()
	for b.Loop() {
		_ = CacheKey(parts...)
	}
}

func TestCacheKeyString(t *testing.T) {
	for _, tc := range []struct {
		parts []string
		want  string
	}{
		{nil, ""},
		{[]string{""}, ""},
		{[]string{"metrics"}, "metrics"},
		{[]string{"metrics", "ds1", "fingerprint1"}, "metrics|ds1|fingerprint1"},
		{[]string{"", "a", ""}, "|a|"},
	} {
		if got := CacheKeyString(tc.parts...); got != tc.want {
			t.Errorf("CacheKeyString(%q) = %q, want %q", tc.parts, got, tc.want)
		}
	}
}

func BenchmarkCacheKeyString(b *testing.B) {
	parts := []string{"metrics", "tenant-0001", "datasource-uid-abcdef", "fingerprint-0123456789abcdef"}
	b.ReportAllocs()
	for b.Loop() {
		_ = CacheKeyString(parts...)
	}
}
