// Package bytesutil holds the helpers for building strings the way this module does everywhere:
// count the length first (a number by its longest text), allocate one buffer of that size, append
// every part, and turn the buffer into the string without copying it.
package bytesutil

import (
	"io"
	"slices"
	"unsafe"
)

const (
	// MaxIntLen is the longest decimal text of an int64: "-9223372036854775808".
	MaxIntLen = 20
	// MaxUintLen is the longest decimal text of a uint64: "18446744073709551615".
	MaxUintLen = 20
)

// ToUnsafeString returns b as a string sharing its memory. b must not be modified afterwards.
func ToUnsafeString(b []byte) string {
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// ToUnsafeBytes returns the bytes of s without copying them. They must not be modified.
func ToUnsafeBytes(s string) []byte {
	return unsafe.Slice(unsafe.StringData(s), len(s))
}

// ReadAll reads r to its end. When size >= 0 (an HTTP Content-Length) the buffer is allocated
// once at that size; a negative size grows the buffer as io.ReadAll does.
func ReadAll(r io.Reader, size int64) ([]byte, error) {
	if size < 0 {
		return io.ReadAll(r)
	}
	// The spare byte lets the read that finds the end of r happen without growing the buffer.
	return AppendAll(make([]byte, 0, size+1), r, size)
}

// AppendAll reads r to its end and appends what it read to dst, reusing dst's memory. When
// size >= 0 (an HTTP Content-Length) dst grows at most once, to fit it; a negative size grows
// dst as needed.
func AppendAll(dst []byte, r io.Reader, size int64) ([]byte, error) {
	if size >= 0 {
		// The spare byte lets the read that finds the end of r happen without growing dst.
		dst = slices.Grow(dst, int(size)+1)
	}
	for {
		if len(dst) == cap(dst) {
			// r holds more than size said, or size is unknown.
			dst = slices.Grow(dst, 512)
		}
		n, err := r.Read(dst[len(dst):cap(dst)])
		dst = dst[:len(dst)+n]
		if err == io.EOF {
			return dst, nil
		}
		if err != nil {
			return dst, err
		}
	}
}
