package resource

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/protobuf/proto"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

// postProto builds a POST carrying msg in the wire format.
func postProto(t *testing.T, path string, msg proto.Message) *http.Request {
	t.Helper()
	body, err := wire.Encode(msg)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", wire.ContentType)
	req.Header.Set(wire.EncodingHeader, wire.EncodingZstd)
	return req
}

// decodeProto reverses the wire format of a response body into msg.
func decodeProto(t *testing.T, body []byte, msg proto.Message) {
	t.Helper()
	if err := wire.Decode(body, msg); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

// decodeError decodes an error response body.
func decodeError(t *testing.T, rec *httptest.ResponseRecorder) *explorerpb.Error {
	t.Helper()
	var e explorerpb.Error
	decodeProto(t, rec.Body.Bytes(), &e)
	return &e
}

// expectOK fails the test unless rec is a 200 in the wire format.
func expectOK(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusOK {
		e := decodeError(t, rec)
		t.Fatalf("status %d: %s: %s", rec.Code, e.Code, e.Message)
	}
	if ct := rec.Header().Get("Content-Type"); ct != wire.ContentType {
		t.Fatalf("unexpected content type %q", ct)
	}
}
