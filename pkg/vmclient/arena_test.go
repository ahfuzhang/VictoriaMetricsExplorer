package vmclient

import "testing"

func TestStringArrayPool(t *testing.T) {
	sa := GetStringArray(16, 4)
	if cap(sa.Arena) < 16 || cap(sa.Starts) < 4 || cap(sa.Ends) < 4 {
		t.Fatalf("capacity too small: arena=%d starts=%d ends=%d", cap(sa.Arena), cap(sa.Starts), cap(sa.Ends))
	}
	sa.Append("foo")
	sa.Append("barbaz")
	if got := sa.Get(0); got != "foo" {
		t.Fatalf("Get(0) = %q, want foo", got)
	}
	if got := sa.Get(1); got != "barbaz" {
		t.Fatalf("Get(1) = %q, want barbaz", got)
	}

	PutStringArray(sa)
	if len(sa.Arena) != 0 || len(sa.Starts) != 0 || len(sa.Ends) != 0 {
		t.Fatalf("Put did not reset: arena=%d starts=%d ends=%d", len(sa.Arena), len(sa.Starts), len(sa.Ends))
	}

	sa = GetStringArray(1024, 100)
	defer PutStringArray(sa)
	if len(sa.Arena) != 0 || len(sa.Starts) != 0 || len(sa.Ends) != 0 {
		t.Fatalf("pooled array not empty: arena=%d starts=%d ends=%d", len(sa.Arena), len(sa.Starts), len(sa.Ends))
	}
	if cap(sa.Arena) < 1024 || cap(sa.Starts) < 100 || cap(sa.Ends) < 100 {
		t.Fatalf("capacity not grown: arena=%d starts=%d ends=%d", cap(sa.Arena), cap(sa.Starts), cap(sa.Ends))
	}

	PutStringArray(nil)
}
