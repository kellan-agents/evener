# Project Session Order Opt-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an upstreamable, opt-in "sort a project's sessions by last activity" — a `sortKey` parameter on `project_page` navigation reads, served by the hub, driven by a web-client preference with a Settings toggle. The default (no `sortKey`, or `sortKey: "createdAt"`) is byte-for-byte today's behavior.

**Architecture:** The read request carries an optional `sortKey` ("createdAt" | "lastActivity"); it becomes part of the navigation resource key (different mode = different cached resource, independent etag/revision/delta). The hub sorts a copy of the project's authoritative tier rows per request before paging; the tree build and the default comparator (`ProjectSessionOrderLess`, newest-created first) are untouched. The web client keys loaded pages by `sortKey`, sends it from a new persisted preference (`evener.prefs.projectSessionOrder`, default `"createdAt"`), picks the join comparator by it, and exposes the toggle in Settings → Display.

**Tech stack:** Go (hub: `appwire`, `cmd/evener-hub`, `hubcore`), generated TS types (`make generate` → `appwire-client/typescript/types.gen.ts`), TS client library (`appwire-client/typescript/state/navigation`), React SPA (`cmd/evener-hub/frontend`), vitest.

**Spec:** this document is the spec and the plan (the design conversation is the 2026-11-24 session with Kellan; the running proof is branch `project-sessions-activity-order`, which hard-swaps the default — this branch makes that behavior opt-in instead).

## Global Constraints

- Heavy builds on this sprite: `GOMAXPROCS=4 nice -n 19 ionice -c3 <command>`; never two heavy builds concurrently.
- The default comparator's behavior (newest-created first) must not change: no test that passes today may be altered, only added to.
- Commits end with the Evener co-author trailer (see repo instructions).
- `gofmt`-clean; `go vet ./cmd/evener-hub/... ./appwire/...` clean.
- Pre-existing test failures on this sprite (~29 in `cmd/evener-hub` + 4 `FuzzHubcoreScenarios` seeds, the chmod failure-injection family) are NOT ours — verify by running the same test on `main` before touching anything (see project memory `evener/evener-test-failures-on-sprite.md`).
- Frontend tests: `npx vitest run <files>` from `cmd/evener-hub/frontend` (node_modules already provisioned).
- Non-goals: `sortKey` on the `project` resource or the archived list (follow-ups), changing any default, deploying this branch to graygoo (the sprite keeps running `project-sessions-activity-order` until upstream decides).

## Review Focus

- A request with `sortKey: "lastActivity"` on a project whose rows were built creation-ordered must return activity-ordered rows WITHOUT reordering other readers' pages (the sort must be on a copy, never the shared `TierRows` slice).
- An unknown `sortKey` value (e.g. `"activity"`, `" updatedAt"`) must be rejected with InvalidParams, never silently treated as a default.
- `sortKey` on a resource other than `project_page` (e.g. `catalog`) must be rejected with InvalidParams.
- Two clients reading the same project/tier/offset with different sortKeys must never share an etag/revision/unchanged answer (key must include sortKey).
- A stored pref value that predates this feature (unset) must read as `"createdAt"`; a corrupted stored value must fall back to `"createdAt"`, never crash the rail.

---

### Task 1: Wire — `sortKey` on navigation read params and the resource key

**Files:**
- Modify: `appwire/types_session.go` (NavigationReadParams), `appwire/protocol.go` (MethodEvenerNavigationRead description)
- Modify: `cmd/evener-hub/app_navigation.go` (param-names map, `navigationReadKeyWithFields`, validation)
- Modify: `cmd/evener-hub/navigation_projection.go` (navigationResourceKey struct, Resource dispatch)
- Test: `cmd/evener-hub/app_navigation_test.go`

**Interfaces:**
- Produces: `appwire.NavigationReadParams.SortKey string` (`json:"sortKey,omitempty"`); `navigationResourceKey.SortKey string`; `navigationResourceKey` for `project_page` carries it; `ProjectPageIn(catalog navigationResourceKind, key, tier string, offset uint32, limit int, sortKey string)` — Task 2 implements the sorting, Task 1 threads the value (upstream main's `ProjectPageIn` has no sortKey param yet; this task adds it and passes it through to `projectTier`, whose signature also gains `sortKey string` and which ignores it until Task 2).

- [ ] **Step 1: Write failing tests in `cmd/evener-hub/app_navigation_test.go`** (mirror the file's existing decode/key table-test style):
  - `TestNavigationReadKeyAcceptsSortKeyOnProjectPage`: a raw params JSON with `resource: "project_page"`, `projectKey: "p"`, `tier: "current"`, `sortKey: "lastActivity"` decodes and builds a key with `SortKey: "lastActivity"`.
  - `TestNavigationReadKeyRejectsSortKeyEverywhereElse`: the same `sortKey` on a `catalog` read returns the invalid-params error.
  - `TestNavigationReadKeyRejectsUnknownSortKeyValue`: `sortKey: "activity"` on a `project_page` read returns the invalid-params error.
- [ ] **Step 2: Run to verify they fail.** `GOMAXPROCS=4 nice -n 19 ionice -c3 go test ./cmd/evener-hub/ -run 'TestNavigationReadKey' -count=1` — expect FAIL (unknown field / missing key field).
- [ ] **Step 3: Implement.** Add `SortKey` to `NavigationReadParams` (+ `navigationReadParamNames` entry `"sortKey"`); in `navigationReadKeyWithFields` allow `"sortKey"` only on the `project_page` case (add to its `rejectNavigationReadFields` allow-list) and validate value ∈ `{"", "createdAt", "lastActivity"}` (anything else → error); add `SortKey string` to `navigationResourceKey`; in `Resource(key)` pass `key.SortKey` into `ProjectPageIn` (new last parameter); `ProjectPageIn` and `projectTier` pass it through unimplemented. Update the `MethodEvenerNavigationRead` protocol-table description to mention the optional project_page `sortKey` (`createdAt` default, `lastActivity` orders by the row's last activity with `created_at` as fallback).
- [ ] **Step 4: Run to verify they pass**, then run the package: `... go test ./cmd/evener-hub/ -count=1` and confirm only the pre-existing failures remain.
- [ ] **Step 5: Commit** `git add appwire/types_session.go appwire/protocol.go cmd/evener-hub/app_navigation.go cmd/evener-hub/app_navigation_test.go cmd/evener-hub/navigation_projection.go` + trailer, message `feat(hub): sortKey on project_page navigation reads`.

### Task 2: Hub — sort the page's rows by the requested key

**Files:**
- Modify: `cmd/evener-hub/internal/hubcore/session_order.go` (new comparator)
- Modify: `cmd/evener-hub/navigation_projection.go` (`projectTier` sorts a rows copy per sortKey)
- Test: `cmd/evener-hub/navigation_projection_test.go`

**Interfaces:**
- Consumes: `ProjectPageIn(..., sortKey string)` from Task 1.
- Produces: `hubcore.ProjectSessionOrderLessByActivity(a, b SessionOrderKey) bool` — newest `OrderUpdatedAt(a.Updated, a.Created)` first, then `compareOrderText(a.Title, b.Title)`, then `compareOrderText(a.ID, b.ID)`; leaves `ProjectSessionOrderLess` untouched.

- [ ] **Step 1: Write failing tests.**
  - In `hubcore` (extend `tree_test.go`'s order-scenario block or a new `session_order_test.go`): `TestProjectSessionOrderLessByActivityOrdersByUpdateThenTitleAndID` — same four-row fixture shape as `fuzzScenarioBuildTree_OrdersProjectSessionsByCreatedTitleAndID`, asserting activity-desc with title/ID tiebreaks, and asserting `ProjectSessionOrderLess` still returns creation-order for the same keys (guard the default).
  - In `navigation_projection_test.go`: a projection-level test whose fixture project has tier rows where creation order ≠ activity order (copy the fixture style from `TestNavigationMergeProjectGroupsKeepsProjectSessionsInCreationOrder` at ~line 1249); assert `ProjectPageIn("", key, "current", 0, 50, "lastActivity")` returns rows newest-activity first, `ProjectPageIn(..., "")` returns newest-created first, and a second call with the default after an activity call still returns creation order (proves the shared rows were not mutated).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Add `ProjectSessionOrderLessByActivity` in `session_order.go` (doc comment: the opt-in order for project_page reads that name `sortKey: "lastActivity"`; the default comparator's row-stability ruling is untouched). In `projectTier`: `rows, ok := project.TierRows(tier)`; when `sortKey == "lastActivity"`, `rows = append([]hubcore.TreeNode(nil), rows...)` then `sort.SliceStable(rows, func(i,j) bool { return hubcore.TreeNodeOrderLessByActivity(rows[i], rows[j]) })` — `TreeNodeOrderLessByActivity` mirrors `TreeNodeLess` with the activity comparator (`TreeNodeOrderKey(n)` already carries `Updated/Created/Title/ID`); no copying or sorting when sortKey is the default.
- [ ] **Step 4: Run tests, then the two packages** (`./cmd/evener-hub/internal/hubcore/ ./cmd/evener-hub/`), confirming only pre-existing failures.
- [ ] **Step 5: Commit** `feat(hub): serve project pages by last activity on request`.

### Task 3: Regenerate the wire types

**Files:**
- Generated: `appwire-client/typescript/types.gen.ts`, `docs/appwire-protocol.md`
- Command: `GOMAXPROCS=4 nice -n 19 ionice -c3 make generate`

- [ ] **Step 1: Run `make generate`** and inspect the diff: `types.gen.ts` gains `sortKey?: string` on `NavigationReadParams`; `docs/appwire-protocol.md`'s navigation-read row gains the description text.
- [ ] **Step 2: Verify nothing unrelated regenerated** (`git diff --stat` — only the two named files may change).
- [ ] **Step 3: Commit** `chore(wire): regenerate types and protocol doc for sortKey`.

### Task 4: Client library — key, codec, store

**Files:**
- Modify: `appwire-client/typescript/state/navigation/types.ts` (ResourceKey project_page variant, `navigationParamsToResourceKey`, `keyID`), `state/navigation/codec.ts` (params built from a key), `state/navigation/store.ts` (`loadProjectPage`)
- Test: extend the existing tests covering `loadProjectPage` and the key↔params roundtrip (`grep -rln 'loadProjectPage\|navigationParamsToResourceKey' appwire-client/typescript --include='*.test.ts'` → e.g. `store.test.ts`, `codec.test.ts`)

**Interfaces:**
- Produces: `loadProjectPage(projectKey, tier, offset?, limit?, sortKey?: "" | "createdAt" | "lastActivity")`; `ResourceKey` project_page variant gains `sortKey?: string`; `keyID` includes it; `navigationParamsToResourceKey` maps `params.sortKey` into the key; the codec includes `sortKey` in the request params it builds from a project_page key.

- [ ] **Step 1: Write failing tests** — `loadProjectPage("p", "current", 0, 50, "lastActivity")` issues a read whose params carry `sortKey: "lastActivity"` and stores the result under a keyID distinct from the same page without sortKey; `navigationParamsToResourceKey` roundtrips sortKey.
- [ ] **Step 2: Run to verify they fail** (`npx vitest run <those files>`).
- [ ] **Step 3: Implement** the type, keyID, params→key, codec params, and the store method's passthrough (default `""`).
- [ ] **Step 4: Run the navigation store/codec tests**; expect pass.
- [ ] **Step 5: Commit** `feat(client): project_page reads keyed and issued with sortKey`.

### Task 5: Preference + Settings toggle

**Files:**
- Modify: `cmd/evener-hub/frontend/src/stores/prefs.ts`, `cmd/evener-hub/frontend/src/panes/settings/sections/display.tsx`
- Test: `prefs.test.ts` (extend), `display.test.tsx` (extend)

**Interfaces:**
- Produces: `type ProjectSessionOrderPref = "createdAt" | "lastActivity"`; state `projectSessionOrder`; setter `setProjectSessionOrder(value)`; key `evener.prefs.projectSessionOrder`, read via `readEnum` (values `["createdAt", "lastActivity"]`, default `"createdAt"`).

- [ ] **Step 1: Write failing tests** — prefs store: default reads `"createdAt"`; set → writeRaw + state update; a corrupted stored value (e.g. `"bogus"`) reads as `"createdAt"` (readEnum's contract). Display section: renders a "Project session order" row with the two options; choosing "Last activity" calls `setProjectSessionOrder("lastActivity")` (mirror the `enterToSend` row's test style in `display.test.tsx`).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** in `prefs.ts` (follow the `sidebarGrouping` enum pattern exactly: `readEnum` at hydration, `writeRaw` in the setter) and `display.tsx` (mirror the enterToSend row: label "Project session order", options "Creation time" / "Last activity", help text naming the fallback).
- [ ] **Step 4: Run prefs + display tests**, expect pass.
- [ ] **Step 5: Commit** `feat(web): project session order preference and settings toggle`.

### Task 6: Rail wiring — request by the pref, render by the pref

**Files:**
- Modify: `cmd/evener-hub/frontend/src/shell/rail/railResources.ts` (`projectPageStates` filter, comparator selection, `all.sort`), `src/shell/rail/Rail.tsx` (load sites pass the pref), `src/shell/rail/useProjectRootLoads.ts` (if it issues loads)
- Test: `src/shell/rail/railResources.test.ts`, `src/shell/rail/Rail.test.tsx`

**Interfaces:**
- Consumes: `usePrefsStore`'s `projectSessionOrder` (Task 5), `loadProjectPage`'s sortKey (Task 4).
- Produces: `compareProjectSessionsByMode(a, b, mode: "createdAt" | "lastActivity")` (or `compareProjectSessions(a, b, mode)` — one function, mode parameter); `projectPageStates(pages, projectKey, sortKey)` filters by the mode.

- [ ] **Step 1: Write failing tests** — comparator: mode "createdAt" keeps today's creation-first expectations, mode "lastActivity" orders by `updated_at` (reuse the fixtures from the activity-order tests on the sibling branch: old-created-fresh first, title/ID tiebreak, untimestamped last). Rail: with the pref set to `"lastActivity"` and a loaded project_page fixture whose rows carry created/updated stamps in opposite orders, the rendered rows are activity-ordered and the read the store issued carried `sortKey: "lastActivity"`; toggling the pref re-issues loads under the new key (empty-until-loaded is acceptable: assert the new read was issued, not that rows appear synchronously).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — filter `projectPageStates` by the current pref's sortKey so stale-mode pages never join; select the comparator by the pref at `all.sort(compare...)`; pass the pref into every `loadProjectPage` call site in the rail (`Rail.tsx`'s expansion/retry paths and `useProjectRootLoads.ts`); rely on the rail's existing demand-load for the new key (a project whose pages are all filtered out reads as loading and triggers its loads — verify this behavior; if the rail does not auto-load in this state, add a pref-change effect in `Rail.tsx` that reloads loaded projects).
- [ ] **Step 4: Run the whole rail suite** `npx vitest run src/shell/rail/` — all green.
- [ ] **Step 5: Commit** `feat(web): rail renders project rows by the order preference`.

### Task 7: Whole-branch verification

- [ ] Run `GOMAXPROCS=4 nice -n 19 ionice -c3 go test ./cmd/evener-hub/... ./appwire/... ./hubapi/... -count=1`; classify any failure against `main` before touching it (see Global Constraints).
- [ ] Run `GOMAXPROCS=4 nice -n 19 ionice -c3 npx vitest run src/shell/rail src/panes/settings` from `cmd/evener-hub/frontend`, plus the appwire-client navigation tests from `appwire-client/typescript`.
- [ ] `gofmt -l` on changed Go files; `go vet` on changed packages.
- [ ] `make build-web` (nice'd) to prove the SPA builds, then revert nothing — do NOT deploy to graygoo (non-goal).
- [ ] Push the branch to the `kellan-agents` fork.
