# websnap — web screenshot service

Websnap is a small HTTP service that screenshots web pages and prints them to
PDF, at desktop defaults or with real device emulation (named Playwright
presets or a custom viewport). It exists so evener sessions on browser-free
sprites can see the web apps they build: `curl` a URL, save the PNG, and read
it back through a vision model. Design: `docs/superpowers/specs/2026-11-22-screenshot-service-design.md`.

## Setup

Deploy host (any sprite with Node ≥ 22):

```bash
cd services/screenshot
npm ci
npx playwright install chromium   # ~150 MB, once
```

Dev/test host that must stay browser-free (e.g. the evener sprite):

```bash
cd services/screenshot
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `WEBSNAP_TOKEN` | — | **Required.** Bearer token clients must present; the service refuses to start without it. |
| `ALLOW_PRIVATE_ADDRESSES` | unset (`false`) | Set to `true` to allow loopback/private/LAN targets (e.g. dev servers on other sprites on the home network). |

Start: `WEBSNAP_TOKEN=<token> node src/main.js`

Token distribution follows the lunaroute precedent: the value lives in
`~/.config/evener/websnap.env` (`export WEBSNAP_TOKEN=…`, plus `WEBSNAP_URL`
for clients); every example below references the env var — a token is never
pasted inline into a curl command, so it never lands in a transcript or log.

## Endpoints

Every route requires `Authorization: Bearer <token>`.

### `POST /screenshot`

Body: `{url (required, http/https), device? | viewport?, full_page?, selector?,
dark_mode?, wait_until? ("load"|"domcontentloaded"|"networkidle", default
"load"), timeout_ms? (default 30000), format? ("png"|"jpeg", default "png"),
quality? (jpeg only, default 80), console? (bool)}`. `device` and `viewport`
are mutually exclusive; so are `selector` and `full_page`. Errors are JSON
`{error, detail}`: 400 validation, 401 token, 404 selector not found, 413 body
over 16 KB, 502 navigation failure, 503 queue full (one page at a time, 8
waiting).

Minimal:

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/"}' \
  "$HOST:8080/screenshot" -o shot.png
```

Named device preset (see `GET /devices` for names):

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/", "device": "iPhone 15"}' \
  "$HOST:8080/screenshot" -o shot-mobile.png
```

Custom viewport with dark mode:

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/", "viewport": {"width": 390, "height": 844, "device_scale_factor": 3, "mobile": true, "touch": true}, "dark_mode": true}' \
  "$HOST:8080/screenshot" -o shot-dark.png
```

Console capture — JSON with base64 image, console log, page errors, final URL,
elapsed ms:

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/", "console": true}' \
  "$HOST:8080/screenshot" -o shot-with-console.json
```

### `POST /pdf`

Body: `{url, format? (Letter|Legal|Tabloid|Ledger|A0–A5, default A4),
print_background? (default true), timeout_ms?}` → PDF bytes. No
`device`/`viewport` on `/pdf`: Playwright's PDF layout renders at print media
and paper size, so emulation would be a silent no-op — the parameters are
absent rather than decorative.

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/"}' \
  "$HOST:8080/pdf" -o page.pdf
```

### `GET /health`

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" "$HOST:8080/health"
# {"ok":true,"chromium":"131.0.6778.108"}
```

### `GET /devices`

The device preset list (name, viewport, DPR, mobile, touch, user agent).

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" "$HOST:8080/devices"
```

## The agent loop

```
dev server (detached shell) → curl $HOST/screenshot → read_file shot.png
        → vision model (e.g. lunaroute/glm-5.3-vision) → design critique
        → edit code → repeat
```

## First-call smoke check

After deploy: `GET /health` must answer `{"ok": true, ...}` (auth included),
then take one real screenshot and check the file starts with the PNG magic:

```bash
curl -sS -H "Authorization: Bearer $WEBSNAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/"}' \
  "$HOST:8080/screenshot" -o /tmp/smoke.png
head -c8 /tmp/smoke.png | od -An -tx1   # expect: 89 50 4e 47 0d 0a 1a 0a
```

## Testing

`npm test` runs everywhere: unit tests need no browser and no network beyond
loopback. Browser-gated end-to-end tests (real Playwright against a local
fixture page) run on hosts with a usable Chromium and skip with a printed
reason where none is installed.

## Security posture

- The token is required on every route; a missing `WEBSNAP_TOKEN` at launch
  means the process refuses to start, so it never runs open.
- The service host's own loopback (`127.0.0.0/8`, `::1`, and v4-mapped forms)
  is **always refused**, regardless of flags — a token-holder can never
  probe the deploy host's localhost services. All other private and
  link-local ranges are refused by default; `ALLOW_PRIVATE_ADDRESSES=true`
  lifts exactly those — private LAN and link-local, needed on the home
  network to screenshot dev servers on other sprites — never loopback.
- **Accepted risk:** the policy check resolves the target once, at
  validation; navigation resolves it again and follows HTTP redirects. A
  public hostname that rebinds to a private address, or a public URL that
  redirects to a private target, renders unchecked — those are stopped by
  the token, not by the range check. This is a trusted-network posture, not
  an internet-facing one; do not expose the service to an untrusted
  network.
