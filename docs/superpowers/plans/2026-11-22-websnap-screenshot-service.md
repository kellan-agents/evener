# Websnap screenshot service implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build *websnap*, a standalone Node HTTP service that screenshots and prints web pages to PDF at device presets, per the approved spec.

**Architecture:** Single Node process using `node:http` with no framework. One Playwright Chromium instance, one page at a time behind a bounded queue. Auth and address policy are enforced in the HTTP layer; the core is policy-free plumbing so browser-gated tests can shoot loopback fixtures. Unit tests inject fake browsers — this host stays browser-free.

**Tech Stack:** Node ≥22 (ESM), `node:test` (built-in runner), one runtime dependency: `playwright`, exact-pinned.

**Spec:** `docs/superpowers/specs/2026-11-22-screenshot-service-design.md` — approved as written by the partner, 2026-11-22. The plan argues from the spec; executors read both.

**Post-review amendment (2026-11-22):** the spec was revised after this plan
was drafted ("Reviewer questions and their resolutions"): `/pdf` carries no
`device`/`viewport`; the service host's own loopback is always refused and
`ALLOW_PRIVATE_ADDRESSES` lifts only private LAN and link-local; tokens
distribute via the `websnap.env` env-var convention. This plan's Global
Constraints, Task 2 pdf rules, and Task 4 allowPrivate short-circuit predate
those resolutions — where plan and spec disagree, the spec wins. The drift was
caught in the whole-branch review and corrected in the review fix pass.

## Global Constraints

- New code lives only under `services/screenshot/`. Nothing outside it changes except the spec's status line (Task 10).
- Work happens in an isolated git worktree (repo AGENTS.md mandates it for feature work). Commit with the repo's Co-Authored-By provenance trailer.
- This host stays browser-free (partner decision): never run `npx playwright install` here; install the dependency with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Browser-dependent tests self-skip with a printed reason when Chromium is unusable.
- Default tests are deterministic and need no external network (repo AGENTS.md): address-policy tests use IP literals, `localhost`, and the reserved `.invalid` TLD only.
- Copy is not a test oracle (repo AGENTS.md): tests assert status codes, machine `code`/`field` values, and shapes — never message text.
- Auth: `WEBSNAP_TOKEN` required at startup — missing or empty means refuse to start. Bearer token on every route, timing-safe compare.
- Errors are JSON `{error, detail}` where `error` is a machine code and `detail` is data or null. Statuses: 400 validation, 401 token, 404 selector-not-found and unknown route, 413 body cap (16384 bytes), 502 navigation failure, 503 queue full (capacity 8).
- Address policy blocks v4 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16 and v6 ::1, fc00::/7, fe80::/10, plus v4-mapped ::ffff:0:0/96 (checked as its embedded v4), unless `ALLOW_PRIVATE_ADDRESSES=true`. The check lives in the HTTP layer, not the core.
- Defaults: viewport 1280×720 dpr 1 when neither `device` nor `viewport` given; wait_until "load"; timeout 30000 ms; PNG; JPEG quality 80; PDF A4 with print_background true. `device` XOR `viewport` (both → 400); `selector` XOR `full_page` (both → 400); unknown JSON keys → 400 naming the key.

## Review Focus

The five inputs/failure modes most likely to bite a caller, each pinned by a test in the owning task:

1. **Empty or missing `WEBSNAP_TOKEN` at launch** — the service must refuse to start, never run open (Task 1).
2. **`device` and `viewport` both sent** — 400, not one silently winning (Task 2).
3. **IPv6-literal or v4-mapped private hosts** (`http://[::1]/`, `::ffff:10.0.0.1`) — blocked exactly like their v4 forms (Task 4).
4. **Queue full while a slow shot holds the browser** — the overflowing request gets an immediate 503, and later requests run once capacity frees (Task 5).
5. **A selector that never appears vs a navigation that times out** — 404 and 502 respectively; the two TimeoutErrors must not be confused (Tasks 7 and 9).

---

### Task 1: Scaffold, config, error types

**Files:**
- Create: `services/screenshot/package.json`, `services/screenshot/.gitignore`, `services/screenshot/src/errors.js`, `services/screenshot/src/config.js`
- Test: `services/screenshot/test/config.test.js`

**Interfaces:**
- Produces: `class WebsnapError extends Error` with `constructor(code, status, detail)` and readonly `.code`, `.status`, `.detail`. Produces: `loadConfig(env) → { port, token, allowPrivateAddresses }`; throws on missing/empty token. Produces: an npm tree with `playwright` exact-pinned and a committed `package-lock.json`.

- [ ] **Step 1: Scaffold the npm tree**

`package.json`: `name: "websnap"`, `private: true`, `type: "module"`, `engines: {node: ">=22"}`, `scripts: {start: "node src/main.js", test: "node --test test/"}`. No dependencies yet. `.gitignore`: `node_modules/` only.

- [ ] **Step 2: Install the dependency browser-free**

Run: `cd services/screenshot && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --save-exact playwright`
Expected: `node_modules/` created (gitignored), `playwright` pinned to one exact version in `package.json`, `package-lock.json` written, no browser download.

- [ ] **Step 3: Write the failing config test**

`test/config.test.js`, `node:test` + `node:assert/strict`. Cases:
- `loadConfig({})` and `loadConfig({WEBSNAP_TOKEN: "   "})` each throw.
- `loadConfig({WEBSNAP_TOKEN: "t"})` → `{port: 8080, token: "t", allowPrivateAddresses: false}`.
- `PORT` overrides the port; `ALLOW_PRIVATE_ADDRESSES: "true"` (exact string) → true; any other value → false.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd services/screenshot && node --test test/config.test.js`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `errors.js` and `config.js`**

`config.js`: trim the token, throw on empty; default port 8080; `allowPrivateAddresses = env.ALLOW_PRIVATE_ADDRESSES === 'true'`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd services/screenshot && node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/screenshot/package.json services/screenshot/package-lock.json services/screenshot/.gitignore services/screenshot/src/errors.js services/screenshot/src/config.js services/screenshot/test/config.test.js
git commit -m "feat(websnap): scaffold service npm tree, config, error type"
```

### Task 2: Request validation

**Files:**
- Create: `services/screenshot/src/validate.js`
- Test: `services/screenshot/test/validate.test.js`

**Interfaces:**
- Consumes: `WebsnapError` from Task 1.
- Produces: `parseScreenshotBody(raw) → {ok: true, req} | {ok: false, field, code}`; `parsePdfBody(raw)` same shape. Normalized `ScreenshotRequest`: `{url, device: string|null, viewport: {width, height, device_scale_factor, mobile, touch}|null, full_page: bool, selector: string|null, dark_mode: bool, wait_until, timeout_ms, format, quality: int|null, console: bool}`. Produces: `readJsonBody(req, {limitBytes = 16384}) → Promise<object>`, throwing `WebsnapError('body_too_large', 413, {limit_bytes})` or `WebsnapError('invalid_json', 400, null)`.

- [ ] **Step 1: Write the failing table test**

Table cases, asserting `{ok, field, code}` (never message text):
- Missing/invalid `url`, or protocol not http/https → `{ok:false, field:'url'}`.
- `device` and `viewport` both → `field:'device'`, code `'invalid_request'`.
- `viewport` missing width or height, non-integer, or outside 1–16384 → `field:'viewport'`; `device_scale_factor` outside 1–10 → `field:'viewport'`.
- `selector` + `full_page` both → `field:'selector'`.
- `quality` with `format:'png'` → `field:'quality'`; `quality` outside 1–100 → `field:'quality'`.
- `wait_until` outside the three allowed values → `field:'wait_until'`; `timeout_ms` outside 100–120000 → `field:'timeout_ms'`.
- Unknown key (e.g. `fullPage`) → `field:'fullPage'`, code `'unknown_field'`.
- Happy paths: minimal body defaults to `{device:null, viewport:null, full_page:false, selector:null, dark_mode:false, wait_until:'load', timeout_ms:30000, format:'png', quality:null, console:false}`; jpeg body gets `quality:80` defaulted; explicit values round-trip.
- `parsePdfBody`: `format` enum Letter/Legal/Tabloid/Ledger/A0–A5 defaulting 'A4'; `print_background` default true; same url/device/viewport rules; unknown keys rejected.
- `readJsonBody`: over-limit body rejects with status 413; non-JSON rejects with status 400; valid JSON parses.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/screenshot && node --test test/validate.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement `validate.js`**

Pure functions; shared url/device/viewport checks between the two parsers; boolean fields coerced strictly (`typeof === 'boolean'`); `readJsonBody` counts bytes as it chunks.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/screenshot && node --test test/validate.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/validate.js services/screenshot/test/validate.test.js
git commit -m "feat(websnap): screenshot and pdf request validation"
```

### Task 3: Device registry wrapper

**Files:**
- Create: `services/screenshot/src/devices.js`
- Test: `services/screenshot/test/devices.test.js`

**Interfaces:**
- Consumes: `devices` from the `playwright` package (import only — importing launches nothing).
- Produces: `listDevices() → [{name, viewport: {width, height}, device_scale_factor, mobile, touch, user_agent}]`; `resolveDevice(name) → {name, descriptor}` or throws `WebsnapError('unknown_device', 400, {valid})` where `valid` lists registry names (truncated to 20) plus `total`.

- [ ] **Step 1: Write the failing test**

Against the real registry (no pinned dimensions — they change across Playwright versions):
- `listDevices()` is nonempty; every entry has a nonempty `name` and positive width/height.
- `resolveDevice('iPhone 15')` succeeds; descriptor has truthy `isMobile`.
- `resolveDevice('iphone 15')` (case-insensitive) succeeds.
- `resolveDevice('Nokia 3310')` throws with `code:'unknown_device'`, `status:400`, `detail.valid` an array not containing the bogus name.

- [ ] **Step 2: Run test to verify it fails** — `node --test test/devices.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement `devices.js`**

Exact match first; else unique case-insensitive match; ambiguous or none → the 400 with truncated `valid` list. Map Playwright descriptor fields (`deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`) to the entry shape above.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/devices.js services/screenshot/test/devices.test.js
git commit -m "feat(websnap): playwright device registry wrapper"
```

### Task 4: Address policy

**Files:**
- Create: `services/screenshot/src/addresses.js`
- Test: `services/screenshot/test/addresses.test.js`

**Interfaces:**
- Consumes: `WebsnapError`; `isIP` from `node:net`; `lookup` from `node:dns/promises`.
- Produces: `isBlockedIp(ip) → bool`; `assertAllowedHost(url, {allowPrivate}) → Promise<void>`, throwing `WebsnapError('blocked_address', 400, {host})`.

- [ ] **Step 1: Write the failing test**

`isBlockedIp`: blocked — `127.0.0.1`, `10.0.0.5`, `192.168.1.1`, `172.16.0.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`, `::1`, `fe80::1`, `fc00::1`, `fd12::1`, `::ffff:127.0.0.1`, `::ffff:10.0.0.1`; allowed — `8.8.8.8`, `1.1.1.1`, `2606:4700::1111`.
`assertAllowedHost`: `http://localhost/x` throws `blocked_address` (no network — resolves locally, both answers blocked); `http://8.8.8.8/` passes; `http://[::1]/` throws; with `allowPrivate:true` nothing above throws; `http://no-such-host-websnap.invalid/` does not throw (DNS failure is left to navigation, which 502s).

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Implement `addresses.js`**

`isIP` classifies; ranges per Global Constraints; `::ffff:0:0/96` unwraps to the embedded v4 and re-checks. Hostname path: `lookup(host, {all: true})`, throw if **any** answer is blocked; lookup errors pass through. `allowPrivate` short-circuits.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/addresses.js services/screenshot/test/addresses.test.js
git commit -m "feat(websnap): private address policy"
```

### Task 5: Bounded serial queue

**Files:**
- Create: `services/screenshot/src/queue.js`
- Test: `services/screenshot/test/queue.test.js`

**Interfaces:**
- Consumes: `WebsnapError`.
- Produces: `createQueue({capacity = 8}) → {run(job) → Promise<job result>, get pending()}`. Jobs run FIFO, strictly one at a time. `run` rejects immediately with `WebsnapError('queue_full', 503, {capacity})` when `pending >= capacity` (pending counts running + waiting).

- [ ] **Step 1: Write the failing test**

With fake jobs (10 ms timers) tracking overlap: completion order equals start order; max observed concurrency is 1; the 9th `run` while 8 are pending rejects with `status:503` immediately; after draining, a new `run` resolves.

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Implement `queue.js`**

A promise chain: each job waits on the previous one; a counter gates admission before chaining.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/queue.js services/screenshot/test/queue.test.js
git commit -m "feat(websnap): bounded serial request queue"
```

### Task 6: Playwright plan builders (pure)

**Files:**
- Create: `services/screenshot/src/plan.js`
- Test: `services/screenshot/test/plan.test.js`

**Interfaces:**
- Consumes: `resolveDevice` (Task 3), normalized requests (Task 2).
- Produces: `buildShotPlan(req) → {contextOptions, gotoOptions, screenshotOptions, selector: string|null, captureConsole: bool}` and `buildPdfPlan(req) → {contextOptions, gotoOptions, pdfOptions}`. `contextOptions` is a Playwright `newContext` bundle; `gotoOptions` `{waitUntil, timeout}`; `screenshotOptions` `{fullPage, type, quality?}`; `pdfOptions` `{format, printBackground}`.

- [ ] **Step 1: Write the failing test**

- Neither device nor viewport → `contextOptions.viewport` is `{width:1280, height:720}`, `deviceScaleFactor:1`.
- `device:'iPhone 15'` → `contextOptions.isMobile === true`, truthy `userAgent`, positive viewport ints (registry-sourced, not pinned).
- Explicit `viewport` → `{width, height, deviceScaleFactor: device_scale_factor, isMobile: mobile, hasTouch: touch}`.
- `dark_mode:true` → `contextOptions.colorScheme === 'dark'`.
- `wait_until:'networkidle'`, `timeout_ms:5000` → `gotoOptions` mirrors both.
- jpeg + `quality:75` → `screenshotOptions.type:'jpeg'`, `quality:75`; png → no `quality` key.
- `selector` present → `plan.selector` echoes it; `console:true` → `captureConsole:true`.
- `buildPdfPlan` → `pdfOptions` `{format:'A4', printBackground:true}` defaults, mirroring overrides; `gotoOptions.waitUntil:'load'`.

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Implement `plan.js`**

Pure mapping only — no playwright imports, no I/O. Device presets come from `resolveDevice`'s descriptor, never copied into our code.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/plan.js services/screenshot/test/plan.test.js
git commit -m "feat(websnap): playwright option plan builders"
```

### Task 7: Core (browser runner, screenshot/pdf execution)

**Files:**
- Create: `services/screenshot/src/core.js`
- Test: `services/screenshot/test/core.test.js` (fake browser — no Chromium needed)

**Interfaces:**
- Consumes: `buildShotPlan`, `buildPdfPlan`, `createQueue`, `WebsnapError`; `chromium` from `playwright`.
- Produces: `createCore({chromium} = {}) → core` with:
  - `start()` — launch Chromium once; `stop()` — close it.
  - `health() → {ok: true, chromium: version}`.
  - `screenshot(req) → Promise<Buffer | {image, console, page_errors, final_url, elapsed_ms}>` — serialized through the queue.
  - `pdf(req) → Promise<Buffer>` — same.
  - `probeChromium() → Promise<string|null>` — launch-and-close probe returning the version or null; module-level cached. Browser-gated tests import this.

- [ ] **Step 1: Write the failing test with a fake browser**

Inject a fake `chromium`: fake `browser.newContext() → ctx`, `ctx.newPage() → page`, `ctx.close()`, plus a fake `page` recording calls (`goto(url, opts)`, `screenshot(opts)`, `locator(sel)`, `on(evt, fn)`, `url()`), with configurable failure injection.
- Happy path screenshot: returns the fake page's Buffer; `goto` called with `req.url` and plan `gotoOptions`; a fresh context per call (two screenshots → two `newContext` calls).
- `goto` rejects → `screenshot` rejects with `code:'navigation_failed'`, `status:502` (any error class — DNS, timeout, TLS).
- Fake page throws `{name:'TimeoutError'}` from `locator(...).screenshot` → `code:'selector_not_found'`, `status:404`; a non-timeout selector error → `code:'invalid_selector'`, `status:400`.
- `console:true` → the fake page's registered `console`/`pageerror` listeners feed the result: base64 image, `console` array of `{type, text}`, `page_errors` array, `final_url` from `page.url()`, `elapsed_ms` a nonnegative number.
- PDF happy path: fake page's `pdf(opts)` called with plan `pdfOptions`, Buffer returned.
- `health()` reports the fake browser's version string.

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Implement `core.js`**

Constructor builds the queue (capacity 8) and keeps the injected-or-real `chromium`. Each request: one context, one page, `finally ctx.close()`. Console listeners attach before `goto`. Phase-scoped catch: `goto` errors → 502; selector phase: `err.name === 'TimeoutError'` → 404, else → 400. Timeout errors are detected by `.name`, never by message (works with real Playwright and fakes alike).

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/core.js services/screenshot/test/core.test.js
git commit -m "feat(websnap): browser core with injectable chromium"
```

### Task 8: HTTP server

**Files:**
- Create: `services/screenshot/src/server.js`
- Test: `services/screenshot/test/server.test.js`

**Interfaces:**
- Consumes: `loadConfig` shape, `WebsnapError`, `parseScreenshotBody`, `parsePdfBody`, `readJsonBody`, `assertAllowedHost`, `listDevices`, and a `core` (injected; real one from Task 7).
- Produces: `createApp({config, core}) → (req, res) => void` for `http.createServer`. Every route requires the bearer token (401 JSON otherwise). Routes: `GET /health` → `core.health()`; `GET /devices` → `{devices: listDevices()}`; `POST /screenshot`; `POST /pdf`; anything else → 404 `not_found`. Screenshot success: raw bytes with `Content-Type: image/png|image/jpeg`, or JSON when `console:true`. PDF success: `application/pdf`. Errors: `{error: code, detail}` at the `WebsnapError` status.

- [ ] **Step 1: Write the failing test with a fake core**

Start the handler via `http.createServer` on an ephemeral port (loopback only). Fake `core` records requests and returns canned Buffers/objects.
- No/invalid `Authorization` header → 401 on every route, including `/health`.
- Valid token (`sha256` + `timingSafeEqual` path) → 200s.
- `POST /screenshot` minimal body → 200, `image/png`, body equals the fake core's Buffer; `device` + `viewport` both → 400 with `error:'invalid_request'`; body over 16384 bytes → 413 `body_too_large`; garbage JSON → 400 `invalid_json`.
- Fake core throwing `WebsnapError('navigation_failed', 502, ...)` → 502 with that code; `queue_full` → 503.
- Address policy wired: a body with `url:'http://localhost/x'` reaches the fake core **never**, and the response is 400 `blocked_address`; with the config's `allowPrivateAddresses:true` the request reaches the fake core.
- `GET /devices` → JSON array with named entries; unknown route → 404.

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Implement `server.js`**

Route table first, auth before everything. `readJsonBody` cap 16384. For `/screenshot` and `/pdf`: validate → `assertAllowedHost` (config's `allowPrivateAddresses`) → `core.screenshot/pdf`. Map `WebsnapError` to status; unexpected exceptions → 500 `{error:'internal'}` (and keep serving).

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/server.js services/screenshot/test/server.test.js
git commit -m "feat(websnap): HTTP server with auth and address policy"
```

### Task 9: Entrypoint and browser-gated end-to-end tests

**Files:**
- Create: `services/screenshot/src/main.js`, `services/screenshot/test/browser.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `node src/main.js` — loads config (missing token → stderr line + exit 1, never listens), starts core, listens on `config.port`, handles SIGTERM/SIGINT by closing server and core. Browser-gated tests that verify real Playwright behavior on the deployment host and self-skip here.

- [ ] **Step 1: Write the browser-gated test**

Each test begins `const version = await probeChromium(); if (!version) t.skip('no usable Chromium — browser-gated test skipped')` (reason prints in the run log). Serve a fixture page from `node:http` on `127.0.0.1:0` in-process (legal because the core is policy-free; the HTTP layer is what enforces addresses). Fixture logs one console message and throws one page error. Tests, calling the core directly:
- screenshot → Buffer starting with the PNG magic bytes `\x89PNG`.
- `device:'iPhone 15'` shot → PNG bytes; a marker element styled `width: 100vw` reports the preset's viewport width (registry-sourced, not pinned) via a scripted probe in the fixture — proves emulation reached the page.
- `console:true` → JSON with the fixture's console entry, page error, `final_url`.
- missing selector → `code:'selector_not_found'`, 404.
- unreachable URL (closed local port) → `code:'navigation_failed'`, 502.
- `pdf()` → Buffer starting `%PDF`.

- [ ] **Step 2: Run on this host and verify the skips**

Run: `cd services/screenshot && npm test`
Expected: all unit tests pass; every browser-gated test skips with the printed reason; exit 0.

- [ ] **Step 3: Implement `main.js`**

Thin wiring only per the Interfaces block. No config parsing beyond `loadConfig`.

- [ ] **Step 4: Verify missing-token refusal**

Run: `cd services/screenshot && WEBSNAP_TOKEN= node src/main.js`
Expected: nonzero exit before listening; no port opened. Restore nothing (no state was created).

- [ ] **Step 5: Commit**

```bash
git add services/screenshot/src/main.js services/screenshot/test/browser.test.js
git commit -m "feat(websnap): entrypoint and browser-gated end-to-end tests"
```

### Task 10: README, spec status, full verification

**Files:**
- Create: `services/screenshot/README.md`
- Modify: `docs/superpowers/specs/2026-11-22-screenshot-service-design.md` (status line only)

**Interfaces:**
- Consumes: the finished service.
- Produces: the deploy-and-call documentation the spec's "Client flow" and "Deploy" sections require.

- [ ] **Step 1: Write `README.md`**

Cover, in this order: what websnap is (one paragraph); setup — `npm ci` (deploy host: plus `npx playwright install chromium`; dev/test host: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci`); env vars `PORT` (default 8080), `WEBSNAP_TOKEN` (required — refuses to start without it), `ALLOW_PRIVATE_ADDRESSES` (`true` for home-LAN dev-server targets); a curl example for every endpoint — `/screenshot` minimal, with `device`, with `viewport` + `dark_mode`, with `console:true`, `/pdf`, `/health`, `/devices`; the agent loop (`curl -o shot.png … ` → `read_file shot.png` → vision model); a first-call smoke check; testing note (unit tests run everywhere; browser-gated tests skip where no Chromium); and the accepted-risk note that hostname-based blocking is resolved once at validation — a hostname that rebinds between check and connect is covered by the token, not the range check (trusted-network posture).

- [ ] **Step 2: Update the spec status line**

`Status: awaiting approval.` → `Status: approved 2026-11-22; implemented in services/screenshot/.` No other spec edits.

- [ ] **Step 3: Full verification**

Run, in order, each expected green:
- `cd services/screenshot && npm test` — all unit tests pass, browser tests skip with reasons.
- `git status` — clean tree, everything under `services/screenshot/` plus the one spec line.
- From the repo root, `make lint` once (repo rule: once before push; heavy gates never in parallel).

- [ ] **Step 4: Commit**

```bash
git add services/screenshot/README.md docs/superpowers/specs/2026-11-22-screenshot-service-design.md
git commit -m "docs(websnap): README, setup, and spec status"
```
