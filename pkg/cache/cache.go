// Package cache is the backend's local cache: one fastcache, shared by every datasource of the
// app, holding protobuf messages.
//
// fastcache has a fixed capacity (when full it overwrites its oldest entries) and keeps its memory
// off the Go heap, but it has no expiry and cannot enumerate keys. So every value is stored as an
// explorer.CacheValue stamped with its write time, which readers compare with their TTL, and each
// datasource goes through its own Scope, whose Purge drops all of its entries at once.
package cache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/VictoriaMetrics/fastcache"
	"github.com/klauspost/compress/zstd"
	"google.golang.org/protobuf/proto"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

const (
	// DefaultMaxBytes is the capacity used when none is configured.
	DefaultMaxBytes = 1 << 30

	// compressThreshold is the payload size above which values are zstd-compressed.
	compressThreshold = 256
)

// EncodeAll and DecodeAll are safe for concurrent use, so one encoder and decoder serve every entry.
var (
	encoder *zstd.Encoder
	decoder *zstd.Decoder
)

func init() {
	var err error
	if encoder, err = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault)); err != nil {
		panic(fmt.Sprintf("cache: zstd encoder: %v", err))
	}
	if decoder, err = zstd.NewReader(nil, zstd.WithDecoderConcurrency(0)); err != nil {
		panic(fmt.Sprintf("cache: zstd decoder: %v", err))
	}
}

// Cache is a fixed-capacity in-memory cache of protobuf messages, read and written through
// Scopes. It is safe for concurrent use.
type Cache struct {
	fc     *fastcache.Cache
	closed atomic.Bool
	lastNS atomic.Uint64 // the last key namespace handed to a Scope
	now    func() time.Time
}

// New creates a cache of maxBytes, or DefaultMaxBytes when maxBytes <= 0. Memory is allocated as
// the cache fills; fastcache rounds capacities below 32MB up to 32MB.
func New(maxBytes int) *Cache {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	return &Cache{fc: fastcache.New(maxBytes), now: time.Now}
}

// Close empties the cache and hands its memory back to fastcache's free list, where the next cache
// reuses it. The memory is outside the Go heap: a cache dropped without Close keeps it forever.
// A closed cache stores nothing.
func (c *Cache) Close() {
	c.closed.Store(true)
	c.fc.Reset()
}

// Stats describes the whole cache, every scope included.
type Stats struct {
	Entries    uint64 // fastcache records: a value takes 1 + ceil(size/64KB) of them
	TotalBytes uint64 // memory allocated so far
	MaxBytes   uint64 // capacity
}

// Stats returns the cache statistics.
func (c *Cache) Stats() Stats {
	var s fastcache.Stats
	c.fc.UpdateStats(&s)
	return Stats{Entries: s.EntriesCount, TotalBytes: s.BytesSize, MaxBytes: s.MaxBytesSize}
}

// Scope returns a new, empty view of the cache whose keys never collide with another scope's.
func (c *Cache) Scope() *Scope {
	s := &Scope{c: c}
	s.ns.Store(c.lastNS.Add(1))
	return s
}

// Scope is one datasource's view of a Cache. It is safe for concurrent use.
type Scope struct {
	c  *Cache
	ns atomic.Uint64 // prefixed to every key; Purge moves to an unused one
}

// Get decodes the entry stored under key into msg, provided it was written at most maxAge ago.
// A missing, expired or undecodable entry is a miss, and so is every entry when maxAge <= 0.
func (s *Scope) Get(key string, maxAge time.Duration, msg proto.Message) bool {
	v, ok := s.get(key, maxAge)
	if !ok {
		return false
	}
	payload := v.Payload
	if v.Zstd {
		var err error
		if payload, err = decoder.DecodeAll(payload, nil); err != nil {
			return false
		}
	}
	return proto.Unmarshal(payload, msg) == nil
}

// GetZstd is Get for a message that is sent on unchanged: it returns the message's protobuf
// zstd-compressed (the wire format of pkg/wire) without decoding it.
func (s *Scope) GetZstd(key string, maxAge time.Duration) ([]byte, bool) {
	v, ok := s.get(key, maxAge)
	if !ok {
		return nil, false
	}
	if v.Zstd {
		return v.Payload, true
	}
	return encoder.EncodeAll(v.Payload, nil), true
}

// get returns the CacheValue stored under key if it was written at most maxAge ago. Expired
// entries are left in place: fastcache overwrites them as it fills.
func (s *Scope) get(key string, maxAge time.Duration) (*explorerpb.CacheValue, bool) {
	if maxAge <= 0 {
		return nil, false
	}
	raw := s.c.fc.GetBig(nil, s.key(key))
	if raw == nil {
		return nil, false
	}
	var v explorerpb.CacheValue
	if proto.Unmarshal(raw, &v) != nil {
		return nil, false
	}
	// A write time in the future means the clock went back; the entry's age is unknown.
	age := s.c.now().Sub(time.UnixMilli(v.WrittenAtMs))
	if age < 0 || age > maxAge {
		return nil, false
	}
	return &v, true
}

// Set stores msg under key, stamped with the current time. It is best effort: a message that
// cannot be marshalled is not stored, and fastcache may drop any entry at any time.
func (s *Scope) Set(key string, msg proto.Message) {
	if s.c.closed.Load() {
		return
	}
	payload, err := proto.Marshal(msg)
	if err != nil {
		return
	}
	v := &explorerpb.CacheValue{WrittenAtMs: s.c.now().UnixMilli(), Payload: payload}
	if len(payload) > compressThreshold {
		v.Payload, v.Zstd = encoder.EncodeAll(payload, nil), true
	}
	raw, err := proto.Marshal(v)
	if err != nil {
		return
	}
	// SetBig, unlike Set, also stores values of 64KB and more.
	s.c.fc.SetBig(s.key(key), raw)
}

// Purge drops every entry of the scope. fastcache cannot enumerate keys, so the scope moves to a
// fresh namespace instead; the old entries are unreachable and get overwritten as the cache fills.
func (s *Scope) Purge() {
	s.ns.Store(s.c.lastNS.Add(1))
}

// Stats returns the statistics of the whole cache, which all scopes share.
func (s *Scope) Stats() Stats {
	return s.c.Stats()
}

// key is the fastcache key of key: the scope's namespace, then key.
func (s *Scope) key(key string) []byte {
	b := binary.BigEndian.AppendUint64(make([]byte, 0, 8+len(key)), s.ns.Load())
	return append(b, key...)
}

// A cache key is written into one buffer, every part followed by keySeparator, and HashKey hashes
// it. A key with more than strings is sized with KeySize and the Max*KeySize constants, written
// with the AppendKey* functions, and hashed with HashKey; CacheKey does all of that for strings.
const keySeparator = 0

const (
	// MaxIntKeySize, MaxUintKeySize and MaxBoolKeySize are the most bytes AppendKeyInt,
	// AppendKeyUint and AppendKeyBool add.
	MaxIntKeySize  = bytesutil.MaxIntLen + 1
	MaxUintKeySize = bytesutil.MaxUintLen + 1
	MaxBoolKeySize = len("false") + 1
)

// KeySize is the number of bytes AppendKey adds for parts.
func KeySize(parts ...string) int {
	n := len(parts) // the separators
	for _, p := range parts {
		n += len(p)
	}
	return n
}

// AppendKey appends parts to the key b.
func AppendKey(b []byte, parts ...string) []byte {
	for _, p := range parts {
		b = append(b, p...)
		b = append(b, keySeparator)
	}
	return b
}

// AppendKeyInt appends v to the key b.
func AppendKeyInt(b []byte, v int64) []byte {
	return append(strconv.AppendInt(b, v, 10), keySeparator)
}

// AppendKeyUint appends v to the key b.
func AppendKeyUint(b []byte, v uint64) []byte {
	return append(strconv.AppendUint(b, v, 10), keySeparator)
}

// AppendKeyBool appends v to the key b.
func AppendKeyBool(b []byte, v bool) []byte {
	return append(strconv.AppendBool(b, v), keySeparator)
}

// HashKey returns the cache key for the key bytes b: their SHA-256, in hex.
func HashKey(b []byte) string {
	sum := sha256.Sum256(b)
	dst := make([]byte, hex.EncodedLen(len(sum)))
	hex.Encode(dst, sum[:])
	return bytesutil.ToUnsafeString(dst)
}

// CacheKey builds a cache key from the security context and parameters.
// The key includes all fields necessary for tenant isolation.
func CacheKey(parts ...string) string {
	return HashKey(AppendKey(make([]byte, 0, KeySize(parts...)), parts...))
}

// CacheKeyString builds a readable cache key (not hashed) for debugging: parts joined by "|".
func CacheKeyString(parts ...string) string {
	if len(parts) == 0 {
		return ""
	}
	n := len(parts) - 1 // the separators
	for _, p := range parts {
		n += len(p)
	}
	b := make([]byte, 0, n)
	for i, p := range parts {
		if i > 0 {
			b = append(b, '|')
		}
		b = append(b, p...)
	}
	return bytesutil.ToUnsafeString(b)
}
