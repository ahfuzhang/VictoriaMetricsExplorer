// Package wire implements the Explorer's HTTP wire format: every request and response body is a
// protobuf message compressed with zstd (see proto/explorer/explorer.proto).
package wire

import (
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/klauspost/compress/zstd"
	"google.golang.org/protobuf/proto"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

const (
	ContentType = "application/x-protobuf"
	// EncodingHeader announces the compression instead of Content-Encoding, so neither the browser
	// nor a proxy decompresses the body before the frontend does.
	EncodingHeader = "X-Payload-Encoding"
	EncodingZstd   = "zstd"

	// maxDecodedBytes bounds what one request body may decompress to.
	maxDecodedBytes = 16 << 20
)

// EncodeAll and DecodeAll are safe for concurrent use, so one encoder and decoder serve every request.
var (
	encoder *zstd.Encoder
	decoder *zstd.Decoder
)

func init() {
	var err error
	if encoder, err = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault)); err != nil {
		panic(fmt.Sprintf("wire: zstd encoder: %v", err))
	}
	if decoder, err = zstd.NewReader(nil, zstd.WithDecoderConcurrency(0), zstd.WithDecoderMaxMemory(maxDecodedBytes)); err != nil {
		panic(fmt.Sprintf("wire: zstd decoder: %v", err))
	}
}

// Encode marshals msg and compresses it: the body Write sends.
func Encode(msg proto.Message) ([]byte, error) {
	data, err := proto.Marshal(msg)
	if err != nil {
		return nil, err
	}
	return encoder.EncodeAll(data, nil), nil
}

// Decode reverses Encode into msg. An empty body leaves msg at its defaults.
func Decode(body []byte, msg proto.Message) error {
	proto.Reset(msg)
	if len(body) == 0 {
		return nil
	}
	data, err := decoder.DecodeAll(body, nil)
	if err != nil {
		return fmt.Errorf("zstd: %w", err)
	}
	if err := proto.Unmarshal(data, msg); err != nil {
		return fmt.Errorf("protobuf: %w", err)
	}
	return nil
}

var errTooLarge = errors.New("request body is too large")

// ReadRequest reads at most maxBytes of the request body and decodes it into msg.
func ReadRequest(r *http.Request, maxBytes int, msg proto.Message) error {
	// The SDK's httpadapter builds requests with a nil Body when the call carried none.
	if r.Body == nil {
		return Decode(nil, msg)
	}
	if r.ContentLength > int64(maxBytes) {
		return errTooLarge
	}
	body, err := bytesutil.ReadAll(io.LimitReader(r.Body, int64(maxBytes)+1), r.ContentLength)
	if err != nil {
		return err
	}
	if len(body) > maxBytes {
		return errTooLarge
	}
	return Decode(body, msg)
}

// Write sends a body produced by Encode.
func Write(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", ContentType)
	w.Header().Set(EncodingHeader, EncodingZstd)
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// WriteMessage encodes msg and sends it with the given status.
func WriteMessage(w http.ResponseWriter, status int, msg proto.Message) {
	body, err := Encode(msg)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "marshal_error", "failed to encode response: "+err.Error(), "")
		return
	}
	Write(w, status, body)
}

// WriteError sends an explorer.Error with the given status.
func WriteError(w http.ResponseWriter, status int, code, message, requestID string) {
	body, err := Encode(&explorerpb.Error{Code: code, Message: message, RequestId: requestID})
	if err != nil {
		// Marshalling an Error of plain strings cannot fail; keep the status regardless.
		w.WriteHeader(status)
		return
	}
	Write(w, status, body)
}
