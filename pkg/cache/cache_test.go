package cache

import (
	"testing"
	"time"
)

func TestL1Cache_SetGet(t *testing.T) {
	c := NewL1(L1Config{
		MaxEntries: 100,
		MaxBytes:   1024 * 1024,
		DefaultTTL: 1 * time.Minute,
	})
	defer c.Close()

	c.Set("key1", []byte("value1"), 0)

	val, ok := c.Get("key1")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if string(val) != "value1" {
		t.Fatalf("expected 'value1', got '%s'", string(val))
	}
}

func TestL1Cache_Expiration(t *testing.T) {
	c := NewL1(L1Config{
		MaxEntries: 100,
		MaxBytes:   1024 * 1024,
		DefaultTTL: 50 * time.Millisecond,
	})
	defer c.Close()

	c.Set("key1", []byte("value1"), 0)

	// Should be present immediately
	_, ok := c.Get("key1")
	if !ok {
		t.Fatal("expected cache hit before expiration")
	}

	// Wait for expiration
	time.Sleep(100 * time.Millisecond)

	_, ok = c.Get("key1")
	if ok {
		t.Fatal("expected cache miss after expiration")
	}
}

func TestL1Cache_LRU_Eviction(t *testing.T) {
	c := NewL1(L1Config{
		MaxEntries: 3,
		MaxBytes:   1024 * 1024,
		DefaultTTL: 1 * time.Minute,
	})
	defer c.Close()

	c.Set("k1", []byte("v1"), 0)
	c.Set("k2", []byte("v2"), 0)
	c.Set("k3", []byte("v3"), 0)

	// Access k1 to make it recently used
	c.Get("k1")

	// Add k4, should evict k2 (least recently used)
	c.Set("k4", []byte("v4"), 0)

	_, ok := c.Get("k1")
	if !ok {
		t.Fatal("k1 should still be in cache (recently used)")
	}
	_, ok = c.Get("k2")
	if ok {
		t.Fatal("k2 should have been evicted (LRU)")
	}
	_, ok = c.Get("k3")
	if !ok {
		t.Fatal("k3 should still be in cache")
	}
	_, ok = c.Get("k4")
	if !ok {
		t.Fatal("k4 should be in cache")
	}
}

func TestL1Cache_PurgeByPrefix(t *testing.T) {
	c := NewL1(L1Config{
		MaxEntries: 100,
		MaxBytes:   1024 * 1024,
		DefaultTTL: 1 * time.Minute,
	})
	defer c.Close()

	c.Set("ds1:metrics", []byte("v1"), 0)
	c.Set("ds1:labels", []byte("v2"), 0)
	c.Set("ds2:metrics", []byte("v3"), 0)

	purged := c.PurgeByPrefix("ds1:")
	if purged != 2 {
		t.Fatalf("expected 2 purged, got %d", purged)
	}

	_, ok := c.Get("ds2:metrics")
	if !ok {
		t.Fatal("ds2:metrics should still be in cache")
	}
	_, ok = c.Get("ds1:metrics")
	if ok {
		t.Fatal("ds1:metrics should have been purged")
	}
}

func TestL1Cache_Stats(t *testing.T) {
	c := NewL1(L1Config{
		MaxEntries: 100,
		MaxBytes:   1024 * 1024,
		DefaultTTL: 1 * time.Minute,
	})
	defer c.Close()

	c.Set("k1", []byte("v1"), 0)
	c.Get("k1") // hit
	c.Get("k2") // miss

	stats := c.Stats()
	if stats.Entries != 1 {
		t.Fatalf("expected 1 entry, got %d", stats.Entries)
	}
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
}
