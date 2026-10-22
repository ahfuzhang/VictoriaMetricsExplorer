package bytesutil

import (
	"bytes"
	"strconv"
	"strings"
	"testing"
	"testing/iotest"
)

func TestMaxLen(t *testing.T) {
	if got := len(strconv.FormatInt(-1<<63, 10)); got != MaxIntLen {
		t.Errorf("longest int64 text is %d bytes, MaxIntLen = %d", got, MaxIntLen)
	}
	if got := len(strconv.FormatUint(1<<64-1, 10)); got != MaxUintLen {
		t.Errorf("longest uint64 text is %d bytes, MaxUintLen = %d", got, MaxUintLen)
	}
}

func TestUnsafeConversions(t *testing.T) {
	b := []byte("hello")
	if s := ToUnsafeString(b); s != "hello" {
		t.Errorf("ToUnsafeString = %q", s)
	}
	if b := ToUnsafeBytes("hello"); string(b) != "hello" {
		t.Errorf("ToUnsafeBytes = %q", b)
	}
	if s := ToUnsafeString(nil); s != "" {
		t.Errorf("ToUnsafeString(nil) = %q", s)
	}
}

func TestReadAll(t *testing.T) {
	body := strings.Repeat("0123456789", 100)
	// A wrong size (too small or too large) still reads everything.
	for _, size := range []int64{-1, 0, 10, int64(len(body)), int64(len(body)) + 50} {
		if got, err := ReadAll(strings.NewReader(body), size); err != nil || string(got) != body {
			t.Errorf("size %d: got %d bytes, err %v", size, len(got), err)
		}
		if got, err := ReadAll(iotest.OneByteReader(strings.NewReader(body)), size); err != nil || string(got) != body {
			t.Errorf("one byte reads, size %d: got %d bytes, err %v", size, len(got), err)
		}
	}
	if got, err := ReadAll(bytes.NewReader([]byte("abc")), 3); err != nil || cap(got) != 4 {
		t.Errorf("an exact size should need no growth: cap %d, err %v", cap(got), err)
	}
	if _, err := ReadAll(iotest.ErrReader(iotest.ErrTimeout), 8); err != iotest.ErrTimeout {
		t.Errorf("err = %v, want %v", err, iotest.ErrTimeout)
	}
}
