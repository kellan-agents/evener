package hubcore

import (
	"sort"
	"strings"
	"testing"
	"time"

	"primeradiant.com/evener/agent/schema"
	"primeradiant.com/evener/appwire"
)

func fuzzScenarioUnixTime(t *testing.T) {
	if got := UnixTime(0); !got.IsZero() {
		t.Fatalf("UnixTime(0)=%v, want zero", got)
	}
	if got := UnixTime(-5); !got.IsZero() {
		t.Fatalf("UnixTime(-5)=%v, want zero", got)
	}
	got := UnixTime(1_700_000_000)
	if got.IsZero() || got.Unix() != 1_700_000_000 {
		t.Fatalf("UnixTime(1700000000)=%v", got)
	}
	if got.Location() != time.UTC {
		t.Fatalf("UnixTime should be UTC, got %v", got.Location())
	}
}

func fuzzScenarioUnixSeconds(t *testing.T) {
	if got := UnixSeconds(time.Time{}); got != 0 {
		t.Fatalf("UnixSeconds(zero)=%d, want 0", got)
	}
	ts := time.Unix(1_700_000_000, 0)
	if got := UnixSeconds(ts); got != 1_700_000_000 {
		t.Fatalf("UnixSeconds=%d", got)
	}
}

func fuzzScenarioAppwireThreadLess(t *testing.T) {
	newer := appwire.Thread{ID: "a", Name: "Alpha", UpdatedAt: 200, CreatedAt: 100}
	older := appwire.Thread{ID: "b", Name: "Beta", UpdatedAt: 100, CreatedAt: 100}
	// More recently updated threads sort first (Less == true).
	if !AppwireThreadLess(newer, older) {
		t.Fatal("newer thread should sort before older")
	}
	if AppwireThreadLess(older, newer) {
		t.Fatal("older thread must not sort before newer")
	}

	// Equal timestamps fall back to case-insensitive title order.
	x := appwire.Thread{ID: "x", Name: "apple", UpdatedAt: 100, CreatedAt: 100}
	y := appwire.Thread{ID: "y", Name: "banana", UpdatedAt: 100, CreatedAt: 100}
	if !AppwireThreadLess(x, y) {
		t.Fatal("apple should sort before banana at equal timestamps")
	}
}

func fuzzScenarioAppwireThreadOrderKeyTitleFallback(t *testing.T) {
	// Name wins when present.
	if got := appwireThreadOrderKey(appwire.Thread{Name: "N", Preview: "P", SessionID: "S"}); got.Title != "N" {
		t.Fatalf("title=%q, want Name", got.Title)
	}
	// Preview is the fallback when Name is empty.
	if got := appwireThreadOrderKey(appwire.Thread{Preview: "P", SessionID: "S"}); got.Title != "P" {
		t.Fatalf("title=%q, want Preview", got.Title)
	}
	// SessionID is the last resort.
	if got := appwireThreadOrderKey(appwire.Thread{SessionID: "S"}); got.Title != "S" {
		t.Fatalf("title=%q, want SessionID", got.Title)
	}
	// ID wins for the id field, falling back to SessionID.
	if got := appwireThreadOrderKey(appwire.Thread{SessionID: "S"}); got.ID != "S" {
		t.Fatalf("id=%q, want SessionID fallback", got.ID)
	}
}

func liveEntry(sessionID, address string, started time.Time) LiveEntry {
	return LiveEntry{
		Address: address, StartedAt: started,
		SessionID: sessionID,
	}
}

func fuzzScenarioLiveEntryWithPastLessNilIndex(t *testing.T) {
	newer := liveEntry("02wMz5Txv1C3Hut0M8GCeB", "addr1", time.Unix(200, 0))
	older := liveEntry("02wMz5Txv2enqVTitaig6F", "addr2", time.Unix(100, 0))
	// With no past index, ordering uses the live entry's own StartedAt.
	if !LiveEntryWithPastLess(newer, older, nil) {
		t.Fatal("more recently started entry should sort first")
	}
}

func fuzzScenarioLiveEntryWithPastLessUsesPastMeta(t *testing.T) {
	// A past index whose meta for s1 is much newer must reorder s1 ahead of s2
	// even though s1's live StartedAt is older — the past meta is authoritative.
	past := &PastIndex{
		byID: map[string]PastEntry{
			"02wMz5Txv1C3Hut0M8GCeB": {ID: "02wMz5Txv1C3Hut0M8GCeB", Meta: schema.SessionMeta{ID: "02wMz5Txv1C3Hut0M8GCeB", UpdatedAt: time.Unix(9000, 0), CreatedAt: time.Unix(9000, 0)}},
		},
	}
	s1 := liveEntry("02wMz5Txv1C3Hut0M8GCeB", "addr1", time.Unix(1, 0))    // live start is ancient
	s2 := liveEntry("02wMz5Txv2enqVTitaig6F", "addr2", time.Unix(5000, 0)) // no past entry, falls back to StartedAt

	if !LiveEntryWithPastLess(s1, s2, past) {
		t.Fatal("newer session with a newer past meta should sort before s2")
	}
	// Confirm the fallback path is what makes the difference: without the past
	// index, s2 (newer live start) sorts first instead.
	if LiveEntryWithPastLess(s1, s2, nil) {
		t.Fatal("without past index, ancient-start newer session must not sort before s2")
	}
}

func fuzzScenarioLiveEntryOrderKeyFallbackID(t *testing.T) {
	// Fallback id preference: SessionID, then ThreadID, then Address.
	le := LiveEntry{Address: "addr", ThreadID: "th"}
	if got := liveEntryFallbackOrderKey(le); got.ID != "th" {
		t.Fatalf("id=%q, want ThreadID when SessionID empty", got.ID)
	}
	le = LiveEntry{Address: "addr"}
	if got := liveEntryFallbackOrderKey(le); got.ID != "addr" {
		t.Fatalf("id=%q, want Address as last resort", got.ID)
	}
}

// orderIDs sorts a copy of keys with less and joins the sorted IDs, so a
// comparator test asserts the order a real sort produces, not one pair at a
// time.
func orderIDs(keys []SessionOrderKey, less func(a, b SessionOrderKey) bool) string {
	sorted := append([]SessionOrderKey(nil), keys...)
	sort.SliceStable(sorted, func(i, j int) bool { return less(sorted[i], sorted[j]) })
	ids := make([]string, 0, len(sorted))
	for _, key := range sorted {
		ids = append(ids, key.ID)
	}
	return strings.Join(ids, ",")
}

// The same four-row shape as
// fuzzScenarioBuildTree_OrdersProjectSessionsByCreatedTitleAndID, as bare
// order keys: creation order and activity order disagree, so one comparator
// cannot satisfy both halves of this test.
func TestProjectSessionOrderLessByActivityOrdersByUpdateThenTitleAndID(t *testing.T) {
	updated := time.Date(2026, 5, 11, 12, 0, 0, 0, time.UTC)
	keys := []SessionOrderKey{
		{ID: "02wMz5Txv2enqVTitaig6F", Created: updated.Add(-2 * time.Hour), Updated: updated, Title: "beta task"},
		{ID: "02wMz5Txv1C3Hut0M8GCeB", Created: updated.Add(-time.Hour), Updated: updated, Title: "alpha task"},
		{ID: "02wMz5Txv47YP64RR3B9YJ", Created: updated.Add(-3 * time.Hour), Updated: updated, Title: "bravo task"},
		{ID: "02wMz5Txv5aIxgf9yVdd0N", Created: updated.Add(-3 * time.Hour), Updated: updated.Add(-time.Hour), Title: "alpha task"},
	}

	// Activity-desc: the three rows sharing the update instant order by
	// title, and the oldest-activity row is last even though it ties the
	// oldest creation.
	wantActivity := "02wMz5Txv1C3Hut0M8GCeB,02wMz5Txv2enqVTitaig6F,02wMz5Txv47YP64RR3B9YJ,02wMz5Txv5aIxgf9yVdd0N"
	if got := orderIDs(keys, ProjectSessionOrderLessByActivity); got != wantActivity {
		t.Fatalf("activity order = %s, want %s (newest activity first, then title)", got, wantActivity)
	}
	// Guard the default: the same keys keep creation order, whose tail the
	// activity order cannot produce.
	wantCreation := "02wMz5Txv1C3Hut0M8GCeB,02wMz5Txv2enqVTitaig6F,02wMz5Txv5aIxgf9yVdd0N,02wMz5Txv47YP64RR3B9YJ"
	if got := orderIDs(keys, ProjectSessionOrderLess); got != wantCreation {
		t.Fatalf("creation order = %s, want %s (newest creation first, unchanged)", got, wantCreation)
	}

	// A shared update instant and title leave the ID to break the tie, and
	// the ID tiebreak opposes the creation order, so only a comparator that
	// consults the ID can produce the activity order.
	tie := []SessionOrderKey{
		{ID: "02wMz5TxvB", Created: updated.Add(-time.Hour), Updated: updated, Title: "alpha task"},
		{ID: "02wMz5TxvA", Created: updated.Add(-2 * time.Hour), Updated: updated, Title: "alpha task"},
	}
	if got, want := orderIDs(tie, ProjectSessionOrderLessByActivity), "02wMz5TxvA,02wMz5TxvB"; got != want {
		t.Fatalf("activity tie order = %s, want %s (the ID breaks the tie)", got, want)
	}
	if got, want := orderIDs(tie, ProjectSessionOrderLess), "02wMz5TxvB,02wMz5TxvA"; got != want {
		t.Fatalf("creation tie order = %s, want %s (newest creation first, unchanged)", got, want)
	}
}
