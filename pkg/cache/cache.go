package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// L1Config holds the configuration for the L1 in-memory cache.
type L1Config struct {
	MaxEntries int
	MaxBytes   int
	DefaultTTL time.Duration
}

// entry is a single cache entry.
type entry struct {
	key       string
	value     []byte
	expires   time.Time
	size      int
	// LRU bookkeeping
	prev, next *entry
}

// L1Cache is a bounded in-memory LRU cache with TTL.
// It is safe for concurrent use.
type L1Cache struct {
	mu         sync.Mutex
	config     L1Config
	items      map[string]*entry
	head, tail *entry // LRU list: head = most recent, tail = least recent
	totalBytes int
}

// NewL1 creates a new L1 cache.
func NewL1(config L1Config) *L1Cache {
	c := &L1Cache{
		config: config,
		items:  make(map[string]*entry),
	}
	// Sentinel nodes for easier LRU manipulation
	c.head = &entry{}
	c.tail = &entry{}
	c.head.next = c.tail
	c.tail.prev = c.head
	return c
}

// Close releases resources (currently a no-op, but required for the interface).
func (c *L1Cache) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = nil
	c.head = nil
	c.tail = nil
	c.totalBytes = 0
}

// Get retrieves a value from the cache.
// Returns nil, false if not found or expired.
func (c *L1Cache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.items[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.expires) {
		c.removeEntry(e)
		delete(c.items, key)
		return nil, false
	}

	// Move to front (most recently used)
	c.moveToFront(e)
	return e.value, true
}

// Set stores a value in the cache.
func (c *L1Cache) Set(key string, value []byte, ttl time.Duration) {
	if ttl <= 0 {
		ttl = c.config.DefaultTTL
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// If key already exists, remove old entry
	if e, ok := c.items[key]; ok {
		c.removeEntry(e)
		delete(c.items, key)
	}

	// Create new entry
	e := &entry{
		key:     key,
		value:   value,
		expires: time.Now().Add(ttl),
		size:    len(key) + len(value),
	}

	c.items[key] = e
	c.addToFront(e)
	c.totalBytes += e.size

	// Evict if over limits
	c.evict()
}

// Delete removes a specific key from the cache.
func (c *L1Cache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[key]; ok {
		c.removeEntry(e)
		delete(c.items, key)
	}
}

// PurgeByPrefix removes all keys with the given prefix.
func (c *L1Cache) PurgeByPrefix(prefix string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for key, e := range c.items {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			c.removeEntry(e)
			delete(c.items, key)
			count++
		}
	}
	return count
}

// Stats returns cache statistics.
func (c *L1Cache) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Stats{
		Entries:    len(c.items),
		TotalBytes: c.totalBytes,
		MaxEntries: c.config.MaxEntries,
		MaxBytes:   c.config.MaxBytes,
	}
}

// Stats holds cache statistics.
type Stats struct {
	Entries    int
	TotalBytes int
	MaxEntries int
	MaxBytes   int
}

// CacheKey builds a cache key from the security context and parameters.
// The key includes all fields necessary for tenant isolation.
func CacheKey(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0}) // separator
	}
	return hex.EncodeToString(h.Sum(nil))
}

// CacheKeyString builds a readable cache key (not hashed) for debugging.
func CacheKeyString(parts ...string) string {
	result := ""
	for i, p := range parts {
		if i > 0 {
			result += "|"
		}
		result += p
	}
	return result
}

// evict removes entries until under both limits.
// Must be called with the mutex held.
func (c *L1Cache) evict() {
	for (len(c.items) > c.config.MaxEntries || c.totalBytes > c.config.MaxBytes) &&
		c.tail.prev != c.head {
		oldest := c.tail.prev
		c.removeEntry(oldest)
		delete(c.items, oldest.key)
	}
}

// LRU list operations (must be called with mutex held)

func (c *L1Cache) addToFront(e *entry) {
	e.prev = c.head
	e.next = c.head.next
	c.head.next.prev = e
	c.head.next = e
}

func (c *L1Cache) removeEntry(e *entry) {
	e.prev.next = e.next
	e.next.prev = e.prev
	c.totalBytes -= e.size
}

func (c *L1Cache) moveToFront(e *entry) {
	c.removeEntry(e)
	c.addToFront(e)
}

// String returns a string representation for diagnostics.
func (s Stats) String() string {
	return fmt.Sprintf("entries=%d/%d bytes=%d/%d",
		s.Entries, s.MaxEntries, s.TotalBytes, s.MaxBytes)
}
