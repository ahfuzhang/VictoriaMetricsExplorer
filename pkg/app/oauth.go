package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"sync"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

const oauthStreamType = "application/x-ndjson"

// Grafana provides OAuth credentials to its datasource proxy when the browser calls it with
// the user's session. The app sends those requests to the browser and reads back their results.
type oauthRelay struct {
	pending sync.Map // one-time request ID -> *oauthRequest
}

type oauthUser struct {
	org   int64
	login string
}

func currentOAuthUser(ctx context.Context) oauthUser {
	p := backend.PluginConfigFromContext(ctx)
	if p.User == nil {
		return oauthUser{}
	}
	return oauthUser{org: p.OrgID, login: p.User.Login}
}

type oauthRequest struct {
	user     oauthUser
	maxBytes int
	response chan *http.Response
}

type oauthEvent struct {
	ID       string `json:"id,omitempty"`
	Path     string `json:"path,omitempty"`
	MaxBytes int    `json:"maxBytes,omitempty"`
	Status   int    `json:"status,omitempty"`
	Body     []byte `json:"body,omitempty"`
}

func (o *oauthRelay) serve(w http.ResponseWriter, r *http.Request, handler http.Handler, maxBytes int) {
	user := currentOAuthUser(r.Context())
	if user.login == "" || r.Header.Get("Accept") != oauthStreamType {
		writeError(w, http.StatusConflict, "oauth_session_required", "this datasource requires an OAuth session in the Grafana browser")
		return
	}

	w.Header().Set("Content-Type", oauthStreamType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	flush := http.NewResponseController(w).Flush
	encoder := json.NewEncoder(w)
	var mu sync.Mutex
	send := func(event oauthEvent) error {
		mu.Lock()
		defer mu.Unlock()
		if err := encoder.Encode(event); err != nil {
			return err
		}
		return flush()
	}

	ctx := vmclient.WithSessionProxy(r.Context(), func(ctx context.Context, path string) (*http.Response, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		id := rand.Text()
		pending := &oauthRequest{user: user, maxBytes: maxBytes, response: make(chan *http.Response, 1)}
		o.pending.Store(id, pending)
		defer o.pending.Delete(id)
		if err := send(oauthEvent{ID: id, Path: path, MaxBytes: maxBytes}); err != nil {
			return nil, err
		}
		select {
		case response := <-pending.response:
			return response, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	result := &oauthResult{headers: make(http.Header)}
	handler.ServeHTTP(result, r.WithContext(ctx))
	if result.status == 0 {
		result.status = http.StatusOK
	}
	_ = send(oauthEvent{Status: result.status, Body: result.Bytes()})
}

func (o *oauthRelay) receive(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	value, ok := o.pending.Load(id)
	if !ok || value.(*oauthRequest).user != currentOAuthUser(r.Context()) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	pending := value.(*oauthRequest)
	status, err := strconv.Atoi(r.Header.Get("X-Explorer-Upstream-Status"))
	if err != nil || status < 200 || status > 599 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var body []byte
	if r.Body != nil {
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, int64(pending.maxBytes)))
		if err != nil {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
	}
	if _, ok := o.pending.LoadAndDelete(id); !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	pending.response <- &http.Response{
		StatusCode:    status,
		ContentLength: int64(len(body)),
		Body:          io.NopCloser(bytes.NewReader(body)),
	}
	w.WriteHeader(http.StatusNoContent)
}

type oauthResult struct {
	bytes.Buffer
	headers http.Header
	status  int
}

func (r *oauthResult) Header() http.Header { return r.headers }

func (r *oauthResult) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}

func (r *oauthResult) Write(body []byte) (int, error) {
	r.WriteHeader(http.StatusOK)
	return r.Buffer.Write(body)
}
