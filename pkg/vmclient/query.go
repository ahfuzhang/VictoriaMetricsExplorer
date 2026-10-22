package vmclient

import (
	"strconv"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
)

// A request's query string is built like every other string here: its length is counted first
// with queryParamLen and intParamLen, one buffer of that size is allocated, and the parameters are
// appended with appendQueryParam and appendIntParam.

const upperHex = "0123456789ABCDEF"

// queryParamLen is the number of bytes appendQueryParam adds.
func queryParamLen(name, value string) int {
	return len("&=") + queryEscapedLen(name) + queryEscapedLen(value)
}

// intParamLen is the most bytes appendIntParam adds.
func intParamLen(name string) int {
	return len("&=") + queryEscapedLen(name) + bytesutil.MaxIntLen
}

// appendQueryParam appends name=value to the query string b, both escaped as by url.QueryEscape.
func appendQueryParam(b []byte, name, value string) []byte {
	return appendQueryEscaped(appendParamName(b, name), value)
}

// appendIntParam appends name=v to the query string b.
func appendIntParam(b []byte, name string, v int64) []byte {
	return strconv.AppendInt(appendParamName(b, name), v, 10)
}

func appendParamName(b []byte, name string) []byte {
	if len(b) > 0 {
		b = append(b, '&')
	}
	return append(appendQueryEscaped(b, name), '=')
}

// queryEscapedLen is len(url.QueryEscape(s)).
func queryEscapedLen(s string) int {
	n := len(s)
	for i := 0; i < len(s); i++ {
		if s[i] != ' ' && shouldQueryEscape(s[i]) {
			n += len("%XX") - 1
		}
	}
	return n
}

// appendQueryEscaped appends s escaped as url.QueryEscape escapes it.
func appendQueryEscaped(b []byte, s string) []byte {
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == ' ':
			b = append(b, '+')
		case shouldQueryEscape(c):
			b = append(b, '%', upperHex[c>>4], upperHex[c&0xf])
		default:
			b = append(b, c)
		}
	}
	return b
}

// shouldQueryEscape reports whether a query component must escape c: everything but the
// unreserved characters of RFC 3986.
func shouldQueryEscape(c byte) bool {
	switch {
	case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9':
		return false
	case c == '-' || c == '_' || c == '.' || c == '~':
		return false
	default:
		return true
	}
}
