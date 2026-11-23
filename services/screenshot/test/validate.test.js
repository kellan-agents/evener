import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { WebsnapError } from '../src/errors.js'
import { parseScreenshotBody, parsePdfBody, readJsonBody } from '../src/validate.js'

const url = 'https://example.com/'

function assertInvalid(result, field, code = 'invalid_request') {
  assert.equal(result.ok, false, `expected failure at ${field}`)
  assert.equal(result.field, field)
  assert.equal(result.code, code)
}

const screenshotFailures = [
  ['missing url', {}, 'url'],
  ['non-string url', { url: 5 }, 'url'],
  ['ftp protocol rejected', { url: 'ftp://example.com/' }, 'url'],
  ['unparseable url', { url: 'not a url' }, 'url'],
  ['device and viewport are mutually exclusive', { url, device: 'iPhone 15', viewport: { width: 100, height: 100 } }, 'device'],
  ['viewport missing height', { url, viewport: { width: 100 } }, 'viewport'],
  ['viewport non-integer width', { url, viewport: { width: 100.5, height: 100 } }, 'viewport'],
  ['viewport width zero', { url, viewport: { width: 0, height: 100 } }, 'viewport'],
  ['viewport width too large', { url, viewport: { width: 20000, height: 100 } }, 'viewport'],
  ['viewport not an object', { url, viewport: 'big' }, 'viewport'],
  ['device_scale_factor zero', { url, viewport: { width: 100, height: 100, device_scale_factor: 0 } }, 'viewport'],
  ['device_scale_factor too large', { url, viewport: { width: 100, height: 100, device_scale_factor: 11 } }, 'viewport'],
  ['selector and full_page are mutually exclusive', { url, selector: 'a', full_page: true }, 'selector'],
  ['quality with png format', { url, quality: 80 }, 'quality'],
  ['quality zero', { url, format: 'jpeg', quality: 0 }, 'quality'],
  ['quality over 100', { url, format: 'jpeg', quality: 101 }, 'quality'],
  ['wait_until outside enum', { url, wait_until: 'interactive' }, 'wait_until'],
  ['timeout_ms too small', { url, timeout_ms: 50 }, 'timeout_ms'],
  ['timeout_ms too large', { url, timeout_ms: 200000 }, 'timeout_ms'],
  ['unknown key rejected', { url, fullPage: true }, 'fullPage', 'unknown_field'],
  ['unknown key code', { url, nope: 1 }, 'nope', 'unknown_field'],
  ['full_page must be a real boolean', { url, full_page: 'yes' }, 'full_page'],
  ['dark_mode must be a real boolean', { url, dark_mode: 1 }, 'dark_mode'],
  ['console must be a real boolean', { url, console: 'true' }, 'console'],
  ['device must be a string', { url, device: 5 }, 'device'],
  ['selector must be a non-empty string', { url, selector: '' }, 'selector'],
  ['format outside enum', { url, format: 'webp' }, 'format'],
]

for (const [name, body, field, code] of screenshotFailures) {
  test(`screenshot rejects: ${name}`, () => {
    assertInvalid(parseScreenshotBody(body), field, code)
  })
}

test('screenshot minimal body normalizes with all defaults', () => {
  const result = parseScreenshotBody({ url })
  assert.deepEqual(result, {
    ok: true,
    req: {
      url,
      device: null,
      viewport: null,
      full_page: false,
      selector: null,
      dark_mode: false,
      wait_until: 'load',
      timeout_ms: 30000,
      format: 'png',
      quality: null,
      console: false,
    },
  })
})

test('screenshot jpeg body defaults quality to 80', () => {
  const result = parseScreenshotBody({ url, format: 'jpeg' })
  assert.equal(result.req.format, 'jpeg')
  assert.equal(result.req.quality, 80)
})

test('screenshot explicit values round-trip', () => {
  const body = {
    url,
    device: 'iPhone 15',
    full_page: true,
    dark_mode: true,
    wait_until: 'networkidle',
    timeout_ms: 5000,
    format: 'jpeg',
    quality: 75,
    console: true,
  }
  const { ok, req } = parseScreenshotBody(body)
  assert.equal(ok, true)
  assert.deepEqual(req, { url, device: 'iPhone 15', viewport: null, full_page: true, selector: null, dark_mode: true, wait_until: 'networkidle', timeout_ms: 5000, format: 'jpeg', quality: 75, console: true })
})

test('screenshot viewport normalizes optional fields', () => {
  const result = parseScreenshotBody({ url, viewport: { width: 390, height: 844 } })
  assert.deepEqual(result.req.viewport, { width: 390, height: 844, device_scale_factor: 1, mobile: false, touch: false })
  const full = parseScreenshotBody({ url, viewport: { width: 390, height: 844, device_scale_factor: 3, mobile: true, touch: true } })
  assert.deepEqual(full.req.viewport, { width: 390, height: 844, device_scale_factor: 3, mobile: true, touch: true })
})

test('screenshot selector round-trips', () => {
  const result = parseScreenshotBody({ url, selector: '#hero' })
  assert.equal(result.req.selector, '#hero')
})

const pdfFailures = [
  ['missing url', {}, 'url'],
  ['bad protocol', { url: 'gopher://example.com/' }, 'url'],
  ['device is absent from pdf bodies', { url, device: 'iPhone 15' }, 'device', 'unknown_field'],
  ['viewport is absent from pdf bodies', { url, viewport: { width: 10, height: 10 } }, 'viewport', 'unknown_field'],
  ['format outside enum', { url, format: 'A6' }, 'format'],
  ['unknown key', { url, margin: 1 }, 'margin', 'unknown_field'],
  ['print_background must be boolean', { url, print_background: 'yes' }, 'print_background'],
]

for (const [name, body, field, code] of pdfFailures) {
  test(`pdf rejects: ${name}`, () => {
    assertInvalid(parsePdfBody(body), field, code)
  })
}

test('pdf minimal body normalizes with defaults', () => {
  assert.deepEqual(parsePdfBody({ url }), {
    ok: true,
    req: {
      url,
      format: 'A4',
      print_background: true,
      timeout_ms: 30000,
    },
  })
})

test('pdf explicit values round-trip', () => {
  const { ok, req } = parsePdfBody({ url, format: 'Letter', print_background: false, timeout_ms: 45000 })
  assert.equal(ok, true)
  assert.deepEqual(req, { url, format: 'Letter', print_background: false, timeout_ms: 45000 })
})

async function assertRejects(promise, { status, code, detailCheck }) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof WebsnapError)
    assert.equal(err.status, status)
    assert.equal(err.code, code)
    if (detailCheck) detailCheck(err)
    return true
  })
}

test('readJsonBody parses a valid JSON object', async () => {
  const body = await readJsonBody(Readable.from(['{"a":1}']))
  assert.deepEqual(body, { a: 1 })
})

test('readJsonBody rejects invalid JSON with 400 invalid_json', async () => {
  await assertRejects(readJsonBody(Readable.from(['{nope'])), { status: 400, code: 'invalid_json' })
})

test('readJsonBody rejects JSON that is not an object with 400 invalid_json', async () => {
  await assertRejects(readJsonBody(Readable.from(['42'])), { status: 400, code: 'invalid_json' })
})

test('readJsonBody rejects over the explicit limit with 413 body_too_large', async () => {
  await assertRejects(readJsonBody(Readable.from(['x'.repeat(64)]), { limitBytes: 16 }), {
    status: 413,
    code: 'body_too_large',
    detailCheck: (err) => assert.equal(err.detail.limit_bytes, 16),
  })
})

test('readJsonBody default limit is 16384 bytes', async () => {
  const big = JSON.stringify({ url, pad: 'x'.repeat(17000) })
  assert.ok(big.length > 16384)
  await assertRejects(readJsonBody(Readable.from([big])), {
    status: 413,
    code: 'body_too_large',
    detailCheck: (err) => assert.equal(err.detail.limit_bytes, 16384),
  })
})
