package vmclient

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/valyala/fastjson"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
)

// LabelValuesArray is LabelValues for large results. It parses the response with fastjson and
// copies every value into one pooled StringArray; the body buffer and fastjson's value tree are
// pooled too, so once the pools are warm a call allocates no object per value.
// The caller owns the returned array and must hand it back with PutStringArray once it no
// longer uses any string returned by its Get.
func (c *Client) LabelValuesArray(ctx context.Context, label string, matches []string, start, end time.Time, limit int) (*StringArray, bool, error) {
	apiPath := "/api/v1/label/" + url.PathEscape(label) + "/values"
	return c.stringArray(ctx, apiPath, seriesQuery(matches, start, end, limit))
}

// LabelNamesArray is LabelValuesArray for /api/v1/labels: the label names of the series matching
// the match[] selectors (of every series when there are none). Without selectors the names come
// straight from the index, no series is read. The caller hands the array back with PutStringArray.
func (c *Client) LabelNamesArray(ctx context.Context, matches []string, start, end time.Time, limit int) (*StringArray, bool, error) {
	return c.stringArray(ctx, "/api/v1/labels", seriesQuery(matches, start, end, limit))
}

// stringArray fetches a response whose data is an array of strings, as the label names and label
// values APIs answer, into a pooled StringArray.
func (c *Client) stringArray(ctx context.Context, apiPath string, query []byte) (*StringArray, bool, error) {
	resp, err := c.doOK(ctx, http.MethodGet, apiPath, query)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()
	maxBytes := int64(c.limits.MaxUpstreamBytes)
	// 这里使用 fastjson 来解析
	return decodeLabelValuesArray(io.LimitReader(resp.Body, maxBytes), min(resp.ContentLength, maxBytes))
}

// labelValuesDecoder holds the memory one decode needs: the response body and the fastjson
// parser, whose value tree it reuses.
type labelValuesDecoder struct {
	body []byte
	p    fastjson.Parser
}

var labelValuesDecoderPool = sync.Pool{New: func() any { return &labelValuesDecoder{} }}

// decodeLabelValuesArray reads a /api/v1/label/:name/values (or /api/v1/labels) response from r
// and decodes it into a pooled StringArray. size is the length of the body, or negative when it is unknown.
func decodeLabelValuesArray(r io.Reader, size int64) (*StringArray, bool, error) {
	d := labelValuesDecoderPool.Get().(*labelValuesDecoder)
	// The values point into d.p's memory: they are copied into the StringArray before d is reused.
	defer labelValuesDecoderPool.Put(d)
	var err error
	if d.body, err = bytesutil.AppendAll(d.body[:0], r, size); err != nil {
		return nil, false, fmt.Errorf("read response: %w", err)
	}
	v, err := d.p.ParseBytes(d.body)
	if err != nil {
		return nil, false, fmt.Errorf("decode response: %w", err)
	}
	isPartial := v.GetBool("isPartial")
	if status := v.GetStringBytes("status"); string(status) != "success" {
		return nil, isPartial, fmt.Errorf("upstream status %q: %s", status, v.GetStringBytes("error"))
	}
	var items []*fastjson.Value
	if data := v.Get("data"); data != nil && data.Type() != fastjson.TypeNull {
		if items, err = data.Array(); err != nil {
			return nil, isPartial, fmt.Errorf("decode response data: %w", err)
		}
	}

	// Size the arena first, so it is allocated (or taken from the pool) once at its final size.
	// StringBytes unescapes each value in place, so the second pass only reads them. A null
	// element reads as "", as encoding/json does.
	n := 0
	for i, item := range items {
		if item.Type() == fastjson.TypeNull {
			continue
		}
		s, err := item.StringBytes()
		if err != nil {
			return nil, isPartial, fmt.Errorf("decode response data[%d]: %w", i, err)
		}
		n += len(s)
	}
	sa := GetStringArray(n, len(items))
	for _, item := range items {
		sa.Append(bytesutil.ToUnsafeString(item.GetStringBytes()))
	}
	return sa, isPartial, nil
}
