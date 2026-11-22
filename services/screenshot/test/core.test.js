import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebsnapError } from '../src/errors.js'
import { createCore } from '../src/core.js'
import { parseScreenshotBody, parsePdfBody } from '../src/validate.js'

const url = 'https://example.com/'

// A fake Playwright chromium stack: launch -> browser -> newContext -> page.
// Failure injection is configured per test through the overrides.
function fakeChromium(overrides = {}) {
  const listeners = {}
  const calls = { newContext: [], goto: [], screenshot: [], pdf: [] }
  const page = {
    on: (evt, fn) => {
      listeners[evt] = fn
    },
    goto: async (gotoUrl, opts) => {
      calls.goto.push({ url: gotoUrl, opts })
      if (overrides.goto) return overrides.goto(gotoUrl, opts)
      // A loaded page emits console output and sometimes page errors.
      listeners.console?.({ type: () => 'log', text: () => 'from fixture' })
      listeners.pageerror?.(new Error('fixture page error'))
      return {}
    },
    screenshot: async (opts) => {
      calls.screenshot.push(opts)
      if (overrides.screenshot) return overrides.screenshot(opts)
      return Buffer.from('fakepng')
    },
    pdf: async (opts) => {
      calls.pdf.push(opts)
      if (overrides.pdf) return overrides.pdf(opts)
      return Buffer.from('%PDF-fake')
    },
    locator: (sel) => ({
      screenshot: async (opts) => {
        if (overrides.locatorScreenshot) return overrides.locatorScreenshot(sel, opts)
        return Buffer.from('fakepng-element')
      },
    }),
    url: () => 'https://example.com/final',
  }
  const browser = {
    version: () => '117.0.fake',
    newContext: async (opts) => {
      calls.newContext.push(opts)
      return { newPage: async () => page, close: async () => {} }
    },
    close: async () => {},
  }
  return { chromium: { launch: async () => browser }, browser, page, calls, listeners }
}

const shot = (body) => parseScreenshotBody(body).req

async function makeCore(overrides) {
  const fake = fakeChromium(overrides)
  const core = createCore({ chromium: fake.chromium })
  await core.start()
  return { core, fake }
}

async function assertRejectsWith(promise, { code, status }) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof WebsnapError)
    assert.equal(err.code, code)
    assert.equal(err.status, status)
    return true
  })
}

test('screenshot returns the page image and drives goto with the plan', async () => {
  const { core, fake } = await makeCore()
  const result = await core.screenshot(shot({ url }))
  assert.ok(Buffer.isBuffer(result))
  assert.equal(result.toString(), 'fakepng')
  assert.deepEqual(fake.calls.goto, [{ url, opts: { waitUntil: 'load', timeout: 30000 } }])
  assert.equal(fake.calls.newContext.length, 1)
  assert.deepEqual(fake.calls.newContext[0].viewport, { width: 1280, height: 720 })
})

test('each screenshot gets a fresh context', async () => {
  const { core, fake } = await makeCore()
  await core.screenshot(shot({ url }))
  await core.screenshot(shot({ url }))
  assert.equal(fake.calls.newContext.length, 2)
})

test('goto failure surfaces as 502 navigation_failed', async () => {
  const { core } = await makeCore({ goto: () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')) })
  await assertRejectsWith(core.screenshot(shot({ url })), { code: 'navigation_failed', status: 502 })
})

test('a timeout on the selector screenshot is 404 selector_not_found', async () => {
  const { core } = await makeCore({
    locatorScreenshot: () => {
      const err = new Error('locator timeout')
      err.name = 'TimeoutError'
      return Promise.reject(err)
    },
  })
  await assertRejectsWith(core.screenshot(shot({ url, selector: '#missing' })), { code: 'selector_not_found', status: 404 })
})

test('a non-timeout selector error is 400 invalid_selector', async () => {
  const { core } = await makeCore({
    locatorScreenshot: () => Promise.reject(new Error('unexpected token')),
  })
  await assertRejectsWith(core.screenshot(shot({ url, selector: '<<' })), { code: 'invalid_selector', status: 400 })
})

test('console capture returns base64 image, logs, errors, final url, elapsed', async () => {
  const { core } = await makeCore()
  const result = await core.screenshot(shot({ url, console: true }))
  assert.equal(Buffer.isBuffer(result), false)
  assert.equal(Buffer.from(result.image, 'base64').toString(), 'fakepng')
  assert.deepEqual(result.console, [{ type: 'log', text: 'from fixture' }])
  assert.deepEqual(result.page_errors, ['Error: fixture page error'])
  assert.equal(result.final_url, 'https://example.com/final')
  assert.equal(typeof result.elapsed_ms, 'number')
  assert.ok(result.elapsed_ms >= 0)
})

test('a selector shot requests the element screenshot', async () => {
  const { core, fake } = await makeCore()
  const result = await core.screenshot(shot({ url, selector: '#hero' }))
  assert.equal(result.toString(), 'fakepng-element')
  assert.equal(fake.calls.screenshot.length, 0, 'page.screenshot must not run for selector shots')
})

test('pdf returns the page pdf and passes plan options', async () => {
  const { core, fake } = await makeCore()
  const req = parsePdfBody({ url }).req
  const result = await core.pdf(req)
  assert.equal(result.toString(), '%PDF-fake')
  assert.deepEqual(fake.calls.pdf, [{ format: 'A4', printBackground: true }])
})

test('pdf navigation failure surfaces as 502 navigation_failed', async () => {
  const { core } = await makeCore({ goto: () => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED')) })
  const req = parsePdfBody({ url }).req
  await assertRejectsWith(core.pdf(req), { code: 'navigation_failed', status: 502 })
})

test('health reports the browser version', async () => {
  const { core } = await makeCore()
  assert.deepEqual(core.health(), { ok: true, chromium: '117.0.fake' })
})

test('stop closes the browser', async () => {
  let closed = false
  const fake = fakeChromium()
  fake.browser.close = async () => {
    closed = true
  }
  const core = createCore({ chromium: fake.chromium })
  await core.start()
  await core.stop()
  assert.equal(closed, true)
})
