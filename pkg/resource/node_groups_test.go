package resource

import (
	"testing"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

func TestNodeMatcher(t *testing.T) {
	h := &Handlers{router: &Router{config: vmclient.Config{NodeLabel: "kubernetes_node"}}}
	if got, want := h.nodeMatcher("ip-10-0-1-2"), `kubernetes_node="ip-10-0-1-2"`; got != want {
		t.Errorf("nodeMatcher = %s, want %s", got, want)
	}
	if got := h.nodeMatcher(""); got != "" {
		t.Errorf("nodeMatcher(\"\") = %s, want empty", got)
	}

	h = &Handlers{router: &Router{config: vmclient.Config{NodeLabel: "not a label"}}}
	if got, want := h.nodeMatcher(`a"b`), `node="a\"b"`; got != want {
		t.Errorf("nodeMatcher (fallback label) = %s, want %s", got, want)
	}
}
