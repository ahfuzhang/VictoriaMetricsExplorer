package resource

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

const (
	podGroupsCacheTTL = 2 * time.Minute
	// k8sRandomAlphabet is the alphabet Kubernetes uses for generated name suffixes (ReplicaSet
	// pod-template hashes and the random pod suffix): no vowels and no 0, 1 or 3.
	k8sRandomAlphabet = "bcdfghjklmnpqrstvwxz2456789"
)

// podGroupEntry is one workload: the pods whose names share a prefix once generated suffixes are
// removed.
type podGroupEntry struct {
	Name  string
	Count int
	Pods  []string
}

// podPrefix returns the workload part of a pod name by removing generated trailing segments, e.g.
// "mahjong-ways-7d4f8c9b7-k8pnx" -> "mahjong-ways" and "mahjong-ways2-5c6b8d9f4-xq2zr" ->
// "mahjong-ways2". Segments are only removed from the end, and the first segment is always kept,
// so names that merely contain digits ("ways2", "worker10") stay distinct workloads.
func podPrefix(pod string) string {
	end := len(pod)
	for {
		i := strings.LastIndexByte(pod[:end], '-')
		if i < 0 || !isGeneratedPodSegment(pod[i+1:end]) {
			return pod[:end]
		}
		end = i
	}
}

// isGeneratedPodSegment reports whether one '-'-separated segment of a pod name looks generated
// rather than chosen by a person.
func isGeneratedPodSegment(seg string) bool {
	if seg == "" {
		return true
	}
	letters, digits := 0, 0
	safe := true
	// letterAfterDigit marks a digit followed later by a letter, i.e. the digits are not just a
	// trailing version or index such as "ways2" or "worker10".
	letterAfterDigit := false
	for _, c := range seg {
		switch {
		case c >= '0' && c <= '9':
			digits++
		case c >= 'a' && c <= 'z':
			letters++
			if digits > 0 {
				letterAfterDigit = true
			}
		default:
			return false
		}
		if !strings.ContainsRune(k8sRandomAlphabet, c) {
			safe = false
		}
	}
	switch {
	case letters == 0:
		// StatefulSet ordinal, CronJob schedule timestamp, date suffix.
		return true
	case safe && len(seg) >= 5:
		// ReplicaSet hash or the random suffix of a Deployment / DaemonSet / Job pod.
		return true
	default:
		// Other hashes, e.g. hex ids; a single digit is too weak a signal ("s3proxy").
		return len(seg) >= 5 && digits >= 2 && letterAfterDigit
	}
}

// buildPodGroups groups pod names by podPrefix, sorted by group name.
func buildPodGroups(pods []string) []podGroupEntry {
	byPrefix := make(map[string][]string)
	for _, pod := range pods {
		if pod == "" {
			continue
		}
		prefix := podPrefix(pod)
		byPrefix[prefix] = append(byPrefix[prefix], pod)
	}
	groups := make([]podGroupEntry, 0, len(byPrefix))
	for prefix, members := range byPrefix {
		sort.Strings(members)
		groups = append(groups, podGroupEntry{Name: prefix, Count: len(members), Pods: members})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Name < groups[j].Name })
	return groups
}

// podPrefixMatcher returns the label matcher selecting the series of one pod group by its prefix,
// e.g. pod=~"mahjong-ways-.*".
func podPrefixMatcher(label, prefix string) string {
	b := make([]byte, 0, len(label)+len(`=~"-.*"`)+escapedLen(prefix, true))
	b = append(append(b, label...), `=~"`...)
	b = appendEscaped(b, prefix, true)
	return bytesutil.ToUnsafeString(append(b, `-.*"`...))
}

// labelSelector returns the selector made of matchers, e.g. {pod=~"web-.*",node="n1"}, leaving out
// empty matchers; it is "" when every matcher is empty.
func labelSelector(matchers ...string) string {
	n := 0
	for _, m := range matchers {
		if m != "" {
			n += len(",") + len(m)
		}
	}
	if n == 0 {
		return ""
	}
	b := make([]byte, 0, n+len("}")) // '{' takes the place of the first ','
	for _, m := range matchers {
		if m == "" {
			continue
		}
		if len(b) == 0 {
			b = append(b, '{')
		} else {
			b = append(b, ',')
		}
		b = append(b, m...)
	}
	return bytesutil.ToUnsafeString(append(b, '}'))
}

// podGroupMatcher is podPrefixMatcher for the datasource's pod label, or "" without a pod group.
func (h *Handlers) podGroupMatcher(podGroup string) string {
	if podGroup == "" {
		return ""
	}
	return podPrefixMatcher(h.podLabel(), podGroup)
}

func (h *Handlers) podLabel() string {
	if label := h.router.config.PodLabel; promLabelNamePattern.MatchString(label) {
		return label
	}
	return "pod"
}

// loadPodGroups fetches the pod label's values for the day-aligned range and groups them.
func (h *Handlers) loadPodGroups(ctx context.Context, startTime, endTime time.Time) (*explorerpb.PodGroupsCacheEntry, error) {
	dayStart := startTime.Truncate(24 * time.Hour)
	dayEnd := endTime.Truncate(24 * time.Hour).Add(24 * time.Hour)
	label := h.podLabel()

	cfg := &h.router.config
	key := make([]byte, 0, cache.KeySize("pod-groups-v2", cfg.UID, cfg.ConfigFingerprint, label)+2*cache.MaxIntKeySize)
	key = cache.AppendKey(key, "pod-groups-v2", cfg.UID, cfg.ConfigFingerprint, label)
	key = cache.AppendKeyInt(key, dayStart.Unix())
	cacheKey := cache.HashKey(cache.AppendKeyInt(key, dayEnd.Unix()))
	var cached explorerpb.PodGroupsCacheEntry
	if h.router.cache.Get(cacheKey, podGroupsCacheTTL, &cached) {
		h.router.obs.RecordCacheHit()
		return &cached, nil
	}
	h.router.obs.RecordCacheMiss()

	pods, isPartial, err := h.router.client.LabelValues(ctx, label, nil, dayStart, dayEnd, h.router.limits.MaxMetricNamesHard)
	if err != nil {
		return nil, err
	}
	result := &explorerpb.PodGroupsCacheEntry{Label: label, Partial: isPartial}
	for _, group := range buildPodGroups(pods) {
		result.Groups = append(result.Groups, &explorerpb.PodGroup{Name: group.Name, Count: uint32(group.Count), Pods: group.Pods})
	}
	h.router.cache.Set(cacheKey, result)
	return result, nil
}

func (h *Handlers) handlePodGroups(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	var req explorerpb.PodGroupsRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}
	startTime, endTime := h.timeRange(req.Range)

	result, err := h.loadPodGroups(r.Context(), startTime, endTime)
	if err != nil {
		log.DefaultLogger.Error("pod-groups: failed to fetch pods", "error", err, "requestId", requestID)
		h.router.obs.RecordError("upstream_error")
		writeError(w, http.StatusBadGateway, "upstream_error", "failed to fetch pod names: "+err.Error(), requestID)
		return
	}

	var podCount uint32
	for _, group := range result.Groups {
		podCount += group.Count
	}
	resp := &explorerpb.PodGroupsResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId: requestID,
			Partial:   result.Partial,
			ElapsedMs: uint64(time.Since(started).Milliseconds()),
		},
		Label:    result.Label,
		Groups:   result.Groups,
		PodCount: podCount,
	}
	writeMessage(w, resp, requestID)
}
