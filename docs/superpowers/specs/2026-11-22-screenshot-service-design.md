# Web screenshot service — design (2026-11-22)

Status: approved 2026-11-22; implemented in `services/screenshot/`. Companion survey:
`docs/design/2026-11-22-web-app-tooling-survey.md`. Reference product:
Shelley (`boldsoftware/shelley`), whose chromedp `browser` tool sets the bar for
device-configured screenshots.

## Intent and why

Evener sessions can build web apps but cannot see them: this sprite has no
browser and stays browser-free (partner decision, 2026-11-22), and evener has
no screenshot tool. The vision models are ready — `lunaroute/glm-5.3-vision`
plus `read_file`'s image path — the missing piece is producing the PNG,
especially at mobile configurations (Shelley's `emulate_device` /
`emulate_custom`).

Decision: a separate callable HTTP service, deployed on a different sprite
(host not yet chosen), called over the network by whatever session needs it.

## Goals

- Screenshot a URL at a named device preset (viewport, DPR, touch, user-agent)
  or a custom viewport — Shelley `emulate_device`/`emulate_custom` parity.
- Full-page, element-selector, dark-mode, wait-until, PNG/JPEG options.
- Console and page-error capture alongside the image.
- Print the page to PDF.
- Callable from any evener session: `curl` → save PNG → `read_file` → vision
  model. No evener core changes required.
- Deployable on any sprite with Node; single process; Chromium via Playwright's
  bundled install.
- Unit-testable on this host with no browser: validation, device mapping, and
  address policy are plain unit tests; browser-dependent tests skip when no
  browser is present and run on the deployment host.

## Non-goals (v1)

- No interactive automation (no eval/click/type; Shelley's `eval`, network
  monitoring, a11y snapshots, and profiling come later if design loops need
  them).
- No MCP surface. HTTP only; an MCP wrapper is a thin later layer.
- No core evener tool wrapping it yet; `curl` via shell is the client.
- No browser pool: one browser, a small request queue.

## Anti-goals

- Never an open proxy: token required on every route; private/loopback/link-local
  addresses blocked unless the deployment explicitly allows them (the service
  must sometimes reach dev servers on other sprites' LAN addresses).
- No browser installs on the evener sprite.

## Constraints

- Dev host (this sprite): Node 24, no Chromium, none to be installed.
  Browser-required verification happens after deployment.
- Deploy host: any sprite with Node; `npx playwright install chromium`
  (~150 MB) at setup.
- Sprites share a trusted home network; token auth is posture, not the only
  barrier.

## Approaches considered

1. **Playwright script run via `shell` on the evener sprite** — rejected:
   needs Chromium on this host, which the partner ruled out.
2. **Playwright MCP server (`@playwright/mcp`) on the deploy host** — evener
   speaks MCP already, but its schema is generic, screenshot control is
   coarser than we want, and the server is someone else's executable. A future
   wrapper, not v1.
3. **chromedp Go service (Shelley's stack)** — works, but Go + raw CDP is more
   machinery for the same result and we would hand-roll the device descriptors
   Playwright ships.
4. **Chosen: standalone Node service, plain HTTP JSON + Playwright.** One real
   dependency (playwright), `node:http` with no framework, callable by curl from
   anything, deploy-anywhere. At this size a framework would be most of the
   code.

## How (decided)

- **Location:** new top-level `services/screenshot/` in this repo (the repo
  already hosts `docs-site/`, `mobile-native/`; one checkout, one review
  surface). Service name in prose: *websnap*.
- **API** — JSON in; image/PDF bytes out unless console capture is requested:
  - `POST /screenshot` — `{url (required, http/https), device? | viewport?,
    full_page?, selector?, dark_mode?, wait_until? ("load"|"domcontentloaded"|
    "networkidle", default "load"), timeout_ms? (default 30000), format?
    ("png"|"jpeg", default "png"), quality? (jpeg only), console? (bool)}`.
    `viewport` is `{width, height, device_scale_factor?, mobile?, touch?}`;
    `device` and `viewport` are mutually exclusive. Unknown device name → 400
    listing valid names (truncated).
    - `console=false` (default): raw image bytes, `Content-Type: image/*` —
      the curl-to-file flow.
    - `console=true`: JSON `{image (base64), console: [{type, text}],
      page_errors: [...], final_url, elapsed_ms}`.
  - `POST /pdf` — `{url, format? ("A4"|"Letter"|…), print_background?
    (default true), timeout_ms?}` → PDF bytes. No `device`/`viewport` here:
    Playwright's `page.pdf()` lays out at print media and paper size, so device
    emulation would be a silent no-op — absent rather than decorative. A
    mobile-scaled PDF render would be new work, not v1.
  - `GET /health` — `{ok: true, chromium: "<version>"}`.
  - `GET /devices` — the device preset list, so sessions can discover names.
  - Errors: JSON `{error, detail}`; 400 validation, 401 token, 502 navigation
    failure (timeout, DNS, TLS), 503 queue full.
- **Auth:** `Authorization: Bearer $WEBSNAP_TOKEN` on every route. No token
  configured at launch → the service refuses to start (never silently open).
  Token distribution follows the lunaroute precedent: server-side value in an
  env file (`~/.config/evener/websnap.env`, `export WEBSNAP_TOKEN=…`),
  sessions read `$WEBSNAP_TOKEN`/`$WEBSNAP_URL` from the environment, and every
  README example references the env var — a token is never pasted inline into
  a curl command, so it never lands in a transcript or log (gitleaks
  posture).
- **Address policy:** resolve the URL's host; the service host's own loopback
  (`127.0.0.0/8`, `::1`) is always refused. All other private/link-local
  ranges are refused by default; `ALLOW_PRIVATE_ADDRESSES=true` lifts exactly
  those — private LAN and link-local, needed on the home-network deployment
  where the service screenshots dev servers on other sprites — while own
  loopback stays blocked regardless, so a token-holder can never probe the
  deploy host's localhost services. The token stays a second barrier, never
  the only one.
- **Concurrency:** one browser instance, one page at a time; bounded queue
  (8) → 503 when full. Mobile-DPR full-page shots are the slow case; keep it
  simple and sequential.
- **Client flow (README):** `curl -H "Authorization: Bearer …" -d '{"url": …,
  "device": "iPhone 15"}' $HOST/screenshot -o shot.png`, then `read_file
  shot.png` with the vision model. Examples for every endpoint.
- **Tests and definition of done:** this sprite has no browser and no deploy
  sprite exists yet, so the build's definition of done is: every no-browser
  unit test green (request validation, device/viewport mapping and mutual
  exclusion, address policy including the always-blocked loopback case, queue
  bounds — page layer mocked), plus a README smoke-check section for whoever
  deploys. Browser-dependent tests ship gated on Playwright reporting a usable
  Chromium: they skip with a printed reason here and are the deployer's first
  post-install step.
- **Deploy:** README covers `npm install`, `npx playwright install chromium`,
  env (`PORT`, `WEBSNAP_TOKEN`, `ALLOW_PRIVATE_ADDRESSES`), and a first-call
  smoke check. No systemd unit in v1 — the host is not yet chosen.

## Left to the builder

- Use Playwright's device registry directly; do not copy device names into our
  code.
- Queue implementation details; JPEG default quality (pick 80).
- Node version floor and the PDF paper-format list from Playwright's supported
  set.
- Deployment host, port, and token values — configuration at deploy time, not
  code.

## Reviewer questions and their resolutions (builder check, 2026-11-22)

1. *What does `ALLOW_PRIVATE_ADDRESSES` lift?* Resolved above: it lifts
   private/link-local LAN ranges only; the service host's own loopback is
   always refused, keeping the token a second barrier.
2. *Who runs the browser tests, and what is "done" without a browser here?*
   No deploy sprite exists yet, so the builder has nowhere to run them:
   definition of done is unit tests plus the README smoke check; browser tests
   are the deployer's first step.
3. *Does `device`/`viewport` do anything on `/pdf`?* No — Playwright's PDF
   layout ignores it, so the parameters are absent from `/pdf` rather than
   silently decorative. Mobile-scaled PDFs are future work if ever wanted.
4. *How do sessions discover the service and token without leaking it?*
   The lunaroute env-file precedent: `~/.config/evener/websnap.env` exports
   `WEBSNAP_TOKEN` (and `WEBSNAP_URL` for clients); README examples use the env
   vars, never inline values.
