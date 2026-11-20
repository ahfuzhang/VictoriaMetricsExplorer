package wire

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	in := &explorerpb.FacetsRequest{
		Metric:  "up",
		Filters: []*explorerpb.LabelFilter{{Name: "job", Values: []string{"api", "web"}}},
		Range:   &explorerpb.TimeRange{StartMs: 1, EndMs: 2},
	}
	body, err := Encode(in)
	if err != nil {
		t.Fatal(err)
	}
	var out explorerpb.FacetsRequest
	if err := Decode(body, &out); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(in, &out) {
		t.Fatalf("round trip: got %v, want %v", &out, in)
	}
}

func TestDecodeEmptyBodyGivesDefaults(t *testing.T) {
	out := &explorerpb.CachePurgeRequest{Prefix: "stale"}
	if err := Decode(nil, out); err != nil {
		t.Fatal(err)
	}
	if out.Prefix != "" {
		t.Fatalf("empty body must reset the message, got %v", out)
	}
}

func TestDecodeRejectsJSON(t *testing.T) {
	var out explorerpb.MetricIndexRequest
	if err := Decode([]byte(`{"page":1}`), &out); err == nil {
		t.Fatal("a JSON body must be rejected")
	}
}

// rawZstdFrame builds a zstd frame of raw (uncompressed) blocks the same way the frontend's
// encoder does (src/explorer/api/zstd.ts).
func rawZstdFrame(data []byte) []byte {
	var frame bytes.Buffer
	frame.Write([]byte{0x28, 0xb5, 0x2f, 0xfd})
	switch n := len(data); {
	case n < 256:
		frame.WriteByte(0x20) // single segment, 1-byte content size
		frame.WriteByte(byte(n))
	case n < 65536+256:
		frame.WriteByte(0x60) // single segment, 2-byte content size (minus 256)
		_ = binary.Write(&frame, binary.LittleEndian, uint16(n-256))
	default:
		frame.WriteByte(0xa0) // single segment, 4-byte content size
		_ = binary.Write(&frame, binary.LittleEndian, uint32(n))
	}
	const maxBlock = 128 << 10
	for offset := 0; ; {
		size := min(len(data)-offset, maxBlock)
		last := offset+size == len(data)
		header := uint32(size) << 3 // block type 0 = raw
		if last {
			header |= 1
		}
		frame.Write([]byte{byte(header), byte(header >> 8), byte(header >> 16)})
		frame.Write(data[offset : offset+size])
		offset += size
		if last {
			return frame.Bytes()
		}
	}
}

func TestDecodeAcceptsRawBlockFrames(t *testing.T) {
	for _, n := range []int{0, 10, 255, 256, 70000, 300000} {
		in := &explorerpb.MetricTypesRequest{}
		for size := 0; size < n; size += 10 {
			in.Metrics = append(in.Metrics, "m_"+strings.Repeat("x", 6))
		}
		data, err := proto.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		var out explorerpb.MetricTypesRequest
		if err := Decode(rawZstdFrame(data), &out); err != nil {
			t.Fatalf("%d bytes: %v", len(data), err)
		}
		if !proto.Equal(in, &out) {
			t.Fatalf("%d bytes: decoded message differs", len(data))
		}
	}
}

func TestReadRequestRejectsOversizedBody(t *testing.T) {
	body, _ := Encode(&explorerpb.MetadataRequest{Metric: strings.Repeat("a", 4096)})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	r.Header.Set(EncodingHeader, EncodingZstd)
	var out explorerpb.MetadataRequest
	if err := ReadRequest(r, len(body)-1, &out); !IsTooLarge(err) {
		t.Fatalf("expected a too-large error, got %v", err)
	}
}

// The body's encoding comes from X-Payload-Encoding, never from its bytes.
func TestReadRequestFollowsEncodingHeader(t *testing.T) {
	in := &explorerpb.MetadataRequest{Metric: "up"}
	body, err := Encode(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, encoding := range []string{"", "gzip", "ZSTD", "identity"} {
		r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
		if encoding != "" {
			r.Header.Set(EncodingHeader, encoding)
		}
		var out explorerpb.MetadataRequest
		if err := ReadRequest(r, len(body), &out); !IsUnsupportedEncoding(err) {
			t.Fatalf("%s %q: expected an unsupported-encoding error, got %v", EncodingHeader, encoding, err)
		}
	}

	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	r.Header.Set(EncodingHeader, EncodingZstd)
	var out explorerpb.MetadataRequest
	if err := ReadRequest(r, len(body), &out); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(in, &out) {
		t.Fatal("decoded message differs")
	}

	// An empty body is the request message at its defaults and needs no encoding.
	out.Metric = "stale"
	if err := ReadRequest(httptest.NewRequest(http.MethodPost, "/", http.NoBody), len(body), &out); err != nil {
		t.Fatal(err)
	}
	if out.Metric != "" {
		t.Fatalf("empty body must reset the message, got %v", &out)
	}
}

func TestWriteErrorIsProtobuf(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, http.StatusBadGateway, "upstream_error", "boom", "req-1")
	if rec.Code != http.StatusBadGateway || rec.Header().Get("Content-Type") != ContentType ||
		rec.Header().Get(EncodingHeader) != EncodingZstd {
		t.Fatalf("unexpected response: %d %v", rec.Code, rec.Header())
	}
	var e explorerpb.Error
	if err := Decode(rec.Body.Bytes(), &e); err != nil {
		t.Fatal(err)
	}
	if e.Code != "upstream_error" || e.Message != "boom" || e.RequestId != "req-1" {
		t.Fatalf("unexpected error body: %v", &e)
	}
}

func TestDecodeRefusesLargeZstdFrame(t *testing.T) {
	data, err := proto.Marshal(&explorerpb.MetadataRequest{Metric: strings.Repeat("a", 4096)})
	if err != nil {
		t.Fatal(err)
	}
	var out explorerpb.MetadataRequest
	for _, body := range [][]byte{rawZstdFrame(data), mustEncode(t, &explorerpb.MetadataRequest{Metric: strings.Repeat("a", 4096)})} {
		if err := decode(body, len(data)-1, &out); !IsTooLarge(err) {
			t.Fatalf("expected a too-large error, got %v", err)
		}
		if err := decode(body, len(data), &out); err != nil {
			t.Fatal(err)
		}
	}
}

func mustEncode(t *testing.T, msg proto.Message) []byte {
	t.Helper()
	body, err := Encode(msg)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
