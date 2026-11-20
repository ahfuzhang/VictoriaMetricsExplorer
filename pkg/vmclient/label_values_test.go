package vmclient

import (
	"bytes"
	"context"
	json "encoding/json/v2"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

func TestLabelValuesArray(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		_, _ = w.Write([]byte(`{"status":"success","isPartial":true,"data":["up","a\"bé","",` +
			`"process_cpu_seconds_total"]}`))
	}))
	defer srv.Close()

	c := newClient(t, srv.URL, "sa-token")
	sa, partial, err := c.LabelValuesArray(context.Background(), "__name__", []string{`{job="vm"}`},
		time.Unix(1609459200, 0), time.Unix(1609545600, 0), 50)
	if err != nil {
		t.Fatalf("LabelValuesArray: %v", err)
	}
	defer PutStringArray(sa)
	if !partial {
		t.Fatalf("isPartial was not read")
	}
	if got, want := valuesOf(sa), []string{"up", `a"bé`, "", "process_cpu_seconds_total"}; !slices.Equal(got, want) {
		t.Fatalf("values = %q, want %q", got, want)
	}
	if want := "/api/datasources/proxy/uid/vm-local/api/v1/label/__name__/values"; gotPath != want {
		t.Fatalf("path: expected %q, got %q", want, gotPath)
	}
	for _, part := range []string{"match%5B%5D=", "start=1609459200", "end=1609545600", "limit=50"} {
		if !strings.Contains(gotQuery, part) {
			t.Fatalf("query %q is missing %q", gotQuery, part)
		}
	}
}

func TestLabelValuesArrayUpstreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusBadGateway)
	}))
	defer srv.Close()

	_, _, err := newClient(t, srv.URL, "t").LabelValuesArray(context.Background(), "job", nil,
		time.Time{}, time.Time{}, 0)
	var ue *UpstreamError
	if !errors.As(err, &ue) || ue.StatusCode != http.StatusBadGateway || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("expected UpstreamError 502 carrying the body, got %v", err)
	}
}

// valuesOf returns the values of sa.
func valuesOf(sa *StringArray) []string {
	out := make([]string, len(sa.Starts))
	for i := range out {
		out[i] = sa.Get(i)
	}
	return out
}

// referenceLabelValues decodes body the way LabelValues does, with encoding/json/v2.
func referenceLabelValues(body []byte) ([]string, bool, error) {
	var resp labelValuesResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, false, err
	}
	if resp.Status != "success" {
		return nil, resp.IsPartial, errors.New("status " + resp.Status)
	}
	return resp.Data, resp.IsPartial, nil
}

// readers returns the ways the tests feed a body to the decoder: whole, one byte per Read, and
// in uneven pieces.
func readers(body []byte) map[string]func() io.Reader {
	return map[string]func() io.Reader{
		"whole":    func() io.Reader { return bytes.NewReader(body) },
		"one-byte": func() io.Reader { return iotest.OneByteReader(bytes.NewReader(body)) },
		"half":     func() io.Reader { return iotest.HalfReader(bytes.NewReader(body)) },
		"data-err": func() io.Reader { return iotest.DataErrReader(bytes.NewReader(body)) },
	}
}

// esc returns s with every ~ turned into a backslash, so that the JSON escape sequences of a
// test case read the same in the source as on the wire.
func esc(s string) string {
	return strings.ReplaceAll(s, "~", "\\")
}

// TestDecodeLabelValuesArrayMatchesJSONv2 checks that the decoder reads every response that
// encoding/json/v2 decodes as LabelValues does, however the body is split into reads.
func TestDecodeLabelValuesArrayMatchesJSONv2(t *testing.T) {
	bodies := []string{
		`{"status":"success","data":["a","b"]}`,
		esc(`{"status":"success","data":["x~u00e9~ud83d~ude00y","~u4e2d~u6587","plain"]}`),
		esc(`{"d~u0061ta":["escaped name"],"st~u0061tus":"success"}`),
		` {"isPartial":true,"data":["xé😀y","\\\"\/\b\f\n\r\t",""],"status":"success"} `,
		"{\n\t\"status\" : \"success\" ,\n\t\"data\" : [ \"a\" ,\"b\" ]\n}\n",
		`{"status":"success","stats":{"seriesFetched":"12","x":[1,-2.5e3,0,true,false,null,{"y":"]}\"{"}],"z":{}},"data":[]}`,
		`{"status":"success","warnings":["w"],"data":null,"isPartial":null,"error":null}`,
		`{"status":"success","Data":["other case"]}`,
		`{"status":"success","isPartial":false}`,
		`{"status":"success","data":["a",null]}`,
		`{"status":"success","data":["` + strings.Repeat(`long\"value`, 20000) + `","after"]}`,
		`{"status":"success","data":["` + strings.Repeat("x", 200000) + `"]}`,
		`{"status":"error","errorType":"bad_data","error":"boom"}`,
	}
	for _, body := range bodies {
		want, wantPartial, wantErr := referenceLabelValues([]byte(body))
		for name, r := range readers([]byte(body)) {
			sa, partial, err := decodeLabelValuesArray(r(), -1)
			if (err != nil) != (wantErr != nil) {
				t.Errorf("%s %.80q: err = %v, json/v2 err = %v", name, body, err, wantErr)
				continue
			}
			if partial != wantPartial {
				t.Errorf("%s %.80q: isPartial = %v, want %v", name, body, partial, wantPartial)
			}
			if err != nil {
				continue
			}
			if got := valuesOf(sa); !slices.Equal(got, want) && len(got)+len(want) > 0 {
				t.Errorf("%s %.80q: values = %.80q, want %.80q", name, body, got, want)
			}
			PutStringArray(sa)
		}
	}
}

func TestDecodeLabelValuesArrayErrors(t *testing.T) {
	tests := []struct{ body, want string }{
		{`{"status":"error","error":"boom"}`, `upstream status "error": boom`},
		{`{"status":null,"data":["a"]}`, `upstream status ""`},
		{`{"data":["a"]}`, `upstream status ""`},
		{`{}`, `upstream status ""`},
		{`[]`, `upstream status ""`},
		{`{"status":"success","data":["a",1]}`, `decode response data[1]: value doesn't contain string`},
		{`{"status":"success","data":{}}`, `decode response data: value doesn't contain array`},
		{`{"status":"success","data":"a"}`, `decode response data: value doesn't contain array`},
		{`{"status":"success","data":["a" "b"]}`, `decode response: `},
		{`{"status":"success","data":["a",]}`, `decode response: `},
		{`{"status":"success","data":["a"]`, `decode response: `},
		{`{"status":"success","data":["a"]} x`, `decode response: unexpected tail`},
		{`{"status":"success","data":["a"]}{}`, `decode response: unexpected tail`},
		{`{"status":"success","data":["a]}`, `decode response: `},
		{`{"status":"success" "data":[]}`, `decode response: `},
		{`{"status":"success","x":tru,"data":[]}`, `decode response: `},
		{`{"status":"success","x":[1 2],"data":[]}`, `decode response: `},
		{`{"status":"success","x":{"a" 1},"data":[]}`, `decode response: `},
		{`{"status":"success",}`, `decode response: `},
		{`{"status":`, `decode response: `},
		{``, `decode response: `},
	}
	for _, tt := range tests {
		for name, r := range readers([]byte(tt.body)) {
			sa, _, err := decodeLabelValuesArray(r(), int64(len(tt.body)))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("%s %q: err = %v, want it to contain %q", name, tt.body, err, tt.want)
			}
			if sa != nil {
				t.Errorf("%s %q: a failed decode must not return an array", name, tt.body)
			}
		}
	}

	// A failing read is reported as such, not as malformed JSON.
	r := io.MultiReader(strings.NewReader(`{"status":"success","data":["a","b`), iotest.ErrReader(iotest.ErrTimeout))
	if _, _, err := decodeLabelValuesArray(r, -1); !errors.Is(err, iotest.ErrTimeout) {
		t.Errorf("read error: err = %v, want %v", err, iotest.ErrTimeout)
	}
}

// TestDecodeLabelValuesArrayFastjsonEscapes pins the two corner cases where unescaping with
// fastjson differs from encoding/json, neither of which a Prometheus-compatible server sends:
// an unknown escape and a lone UTF-16 surrogate are kept as written, where json/v2 rejects the
// first and turns the second into U+FFFD.
func TestDecodeLabelValuesArrayFastjsonEscapes(t *testing.T) {
	body := esc(`{"status":"success","data":["bad ~x escape","~ud800 lone","~ud83d~ude00 pair"]}`)
	sa, _, err := decodeLabelValuesArray(strings.NewReader(body), -1)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	defer PutStringArray(sa)
	if got, want := valuesOf(sa), []string{esc("bad ~x escape"), esc("~ud800 lone"), "😀 pair"}; !slices.Equal(got, want) {
		t.Fatalf("values = %q, want %q", got, want)
	}
}

// loneSurrogate matches a \u escape of a UTF-16 surrogate, which json/v2 and fastjson may decode
// differently (see TestDecodeLabelValuesArrayFastjsonEscapes).
var loneSurrogate = regexp.MustCompile(esc(`(?i)~~ud[89a-f]`))

// FuzzDecodeLabelValuesArray checks that the decoder never panics, and that it reads every
// response encoding/json/v2 accepts to the same values, even one byte per Read. (fastjson
// accepts some that json/v2 rejects, such as invalid UTF-8, an unknown escape, a repeated
// field, a non-boolean isPartial or a number like 01.)
func FuzzDecodeLabelValuesArray(f *testing.F) {
	f.Add([]byte(esc(`{"status":"success","isPartial":true,"data":["a","b~"~u00e9",null]}`)))
	f.Add([]byte(`{"status":"success","stats":{"x":[1,-2.5e3,{"y":"]}"}]},"data":[]}`))
	f.Add([]byte(`{"status":"error","error":"boom"}`))
	f.Fuzz(func(t *testing.T, body []byte) {
		want, wantPartial, wantErr := referenceLabelValues(body)
		if loneSurrogate.Match(body) {
			wantErr = errors.New("surrogate escapes are decoded differently")
		}
		for _, r := range []io.Reader{bytes.NewReader(body), iotest.OneByteReader(bytes.NewReader(body))} {
			sa, partial, err := decodeLabelValuesArray(r, -1)
			if err != nil {
				if wantErr == nil {
					t.Fatalf("%q: err = %v, json/v2 accepts it", body, err)
				}
				continue
			}
			got := valuesOf(sa)
			PutStringArray(sa)
			if wantErr == nil && (!slices.Equal(got, want) && len(got)+len(want) > 0 || partial != wantPartial) {
				t.Fatalf("%q: values = %q partial %v, json/v2 = %q partial %v", body, got, partial, want, wantPartial)
			}
		}
	})
}

// labelValuesBody is a success response with n pod-like label values.
func labelValuesBody(n int) []byte {
	body := []byte(`{"status":"success","isPartial":false,"data":[`)
	for i := range n {
		if i > 0 {
			body = append(body, ',')
		}
		body = strconv.AppendInt(append(body, `"pod-name-abcdef-`...), int64(i), 10)
		body = append(body, '"')
	}
	return append(body, "]}"...)
}

// BenchmarkLabelValuesDecode compares decoding a large label-values response into []string
// (encoding/json/v2) with LabelValuesArray's pooled fastjson decode into a StringArray. Both
// start from the body in memory; the fastjson one also copies it into its pooled buffer.
func BenchmarkLabelValuesDecode(b *testing.B) {
	const n = 20000
	body := labelValuesBody(n)

	b.Run("json-v2", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(body)))
		for b.Loop() {
			var resp labelValuesResponse
			if err := json.Unmarshal(body, &resp); err != nil || len(resp.Data) != n {
				b.Fatalf("decode: %v", err)
			}
		}
	})
	b.Run("fastjson-StringArray", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(body)))
		r := bytes.NewReader(nil)
		for b.Loop() {
			r.Reset(body)
			sa, _, err := decodeLabelValuesArray(r, int64(len(body)))
			if err != nil || len(sa.Starts) != n {
				b.Fatalf("decode: %v", err)
			}
			PutStringArray(sa)
		}
	})
}
