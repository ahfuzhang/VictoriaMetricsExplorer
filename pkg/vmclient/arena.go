package vmclient

import (
	"sync"
	"unsafe"
)

var stringArrayPool = sync.Pool{
	New: func() any { return &StringArray{} },
}

// GetStringArray takes a StringArray from the pool, making sure it can hold at
// least l bytes and cnt strings without growing.
func GetStringArray(l int, cnt int) *StringArray {
	sa := stringArrayPool.Get().(*StringArray)
	if cap(sa.Arena) < l {
		sa.Arena = make([]byte, 0, l)
	}
	if cap(sa.Starts) < cnt {
		sa.Starts = make([]int, 0, cnt)
	}
	if cap(sa.Ends) < cnt {
		sa.Ends = make([]int, 0, cnt)
	}
	return sa
}

// PutStringArray resets sa and returns it to the pool.
// Strings returned by sa.Get must not be used after this call: the next owner
// overwrites the same Arena bytes.
func PutStringArray(sa *StringArray) {
	if sa == nil {
		return
	}
	sa.Reset()
	stringArrayPool.Put(sa)
}

type StringArray struct {
	Arena  []byte
	Starts []int
	Ends   []int
}

func NewStringArray(l int, cnt int) *StringArray {
	return &StringArray{
		Arena:  make([]byte, 0, l),
		Starts: make([]int, 0, cnt),
		Ends:   make([]int, 0, cnt),
	}
}

func (sa *StringArray) Append(s string) {
	sa.Starts = append(sa.Starts, len(sa.Arena))
	sa.Arena = append(sa.Arena, s...)
	sa.Ends = append(sa.Ends, len(sa.Arena))
}

// Len returns the number of strings in sa.
func (sa *StringArray) Len() int {
	return len(sa.Starts)
}

// Get returns the i-th string as a zero-copy view into Arena.
// Safe because Arena is append-only: bytes already written are never modified,
// and a reallocation by append leaves the old backing array alive for the GC.
// Do not Reset or PutStringArray while returned strings are still in use.
func (sa *StringArray) Get(i int) string {
	b := sa.Arena[sa.Starts[i]:sa.Ends[i]]
	return unsafe.String(unsafe.SliceData(b), len(b))
}

func (sa *StringArray) Reset() {
	sa.Arena = sa.Arena[:0]
	sa.Starts = sa.Starts[:0]
	sa.Ends = sa.Ends[:0]
}
