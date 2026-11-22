import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from '../src/server.js'
import { WebsnapError } from '../src/errors.js'

// Every server lands in a module-level after() so a failing assertion that
// skips a test's own stop() cannot leave a listener holding the event loop.
const live = []
after(async () => {
  for (const server of live.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function startServer({ configOverrides = {}, coreOverrides = {} } = {}) {
  const seen = []
  const core = {
    health: () => (coreOverrides.health ? coreOverrides.health() : { ok: true, chromium: '117.0.fake' }),
    screenshot: async (req) => {
      seen.push(['screenshot', req])
      if (coreOverrides.screenshot) return coreOverrides.screenshot(req)
      if (req.console) {
        // The core's contract: console mode returns the JSON payload.
        return {
          image: Buffer.from('fakepng').toString('base64'),
          console: [],
          page_errors: [],
          final_url: 'https://example.com/final',
          elapsed_ms: 1,
        }
      }
      return Buffer.from('fakepng')
    },
    pdf: async (req) => {
      seen.push(['pdf', req])
      if (coreOverrides.pdf) return coreOverrides.pdf(req)
      return Buffer.from('%PDF-fake')
    },
  }
  const config = { port: 0, token: 'secret', allowPrivateAddresses: false, ...configOverrides }
  const server = http.createServer(createApp({ config, core }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  live.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    seen,
    async stop() {
      // fetch keeps idle connections alive, and close() would wait out the
      // keep-alive timeout per test; drop them so teardown is immediate.
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function call(base, { method = 'GET', path = '/health', body, token = 'secret' } = {}) {
  const headers = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  let payload = body
  if (body !== undefined && typeof body === 'object') {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload })
  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()
  const json = contentType.includes('application/json') ? JSON.parse(text) : null
  return { status: res.status, contentType, text, json }
}

test('every route requires the bearer token', async () => {
  const s = await startServer()
  for (const callSpec of [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/devices' },
    { method: 'POST', path: '/screenshot', body: { url: 'https://example.com/' } },
    { method: 'POST', path: '/pdf', body: { url: 'https://example.com/' } },
  ]) {
    for (const token of [null, 'wrong']) {
      const { status, json } = await call(s.base, { ...callSpec, token })
      assert.equal(status, 401, `${callSpec.path} with token=${token}`)
      assert.equal(json.error, 'unauthorized')
    }
  }
  await s.stop()
})

test('valid token reaches /health', async () => {
  const s = await startServer()
  const { status, json } = await call(s.base, { path: '/health' })
  assert.equal(status, 200)
  assert.deepEqual(json, { ok: true, chromium: '117.0.fake' })
  await s.stop()
})

test('POST /screenshot returns raw png bytes', async () => {
  const s = await startServer()
  const { status, contentType, text } = await call(s.base, {
    method: 'POST',
    path: '/screenshot',
    body: { url: 'https://example.com/' },
  })
  assert.equal(status, 200)
  assert.ok(contentType.startsWith('image/png'))
  assert.equal(text, 'fakepng')
  assert.equal(s.seen.length, 1)
  assert.equal(s.seen[0][0], 'screenshot')
  await s.stop()
})

test('jpeg screenshots come back as image/jpeg', async () => {
  const s = await startServer()
  const { status, contentType } = await call(s.base, {
    method: 'POST',
    path: '/screenshot',
    body: { url: 'https://example.com/', format: 'jpeg' },
  })
  assert.equal(status, 200)
  assert.ok(contentType.startsWith('image/jpeg'))
  await s.stop()
})

test('console mode returns JSON carrying the core result', async () => {
  const s = await startServer()
  const { status, json } = await call(s.base, {
    method: 'POST',
    path: '/screenshot',
    body: { url: 'https://example.com/', console: true },
  })
  assert.equal(status, 200)
  assert.equal(Buffer.from(json.image, 'base64').toString(), 'fakepng')
  await s.stop()
})

test('device and viewport together is a 400 invalid_request', async () => {
  const s = await startServer()
  const { status, json } = await call(s.base, {
    method: 'POST',
    path: '/screenshot',
    body: { url: 'https://example.com/', device: 'iPhone 15', viewport: { width: 10, height: 10 } },
  })
  assert.equal(status, 400)
  assert.equal(json.error, 'invalid_request')
  assert.deepEqual(json.detail, { field: 'device' })
  assert.equal(s.seen.length, 0)
  await s.stop()
})

test('an oversized body is rejected with 413 body_too_large', async () => {
  const s = await startServer()
  const { status, json } = await call(s.base, {
    method: 'POST',
    path: '/screenshot',
    body: { url: 'https://example.com/', pad: 'x'.repeat(17000) },
  })
  assert.equal(status, 413)
  assert.equal(json.error, 'body_too_large')
  assert.equal(s.seen.length, 0)
  await s.stop()
})

test('garbage JSON is rejected with 400 invalid_json', async () => {
  const s = await startServer()
  const res = await fetch(`${s.base}/screenshot`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: '{nope',
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'invalid_json')
  await s.stop()
})

test('core navigation failure maps to 502, queue full to 503', async () => {
  const failing = {
    screenshot: () => Promise.reject(new WebsnapError('navigation_failed', 502, { url: 'https://example.com/' })),
  }
  const s = await startServer({ coreOverrides: failing })
  const r502 = await call(s.base, { method: 'POST', path: '/screenshot', body: { url: 'https://example.com/' } })
  assert.equal(r502.status, 502)
  assert.equal(r502.json.error, 'navigation_failed')
  assert.deepEqual(r502.json.detail, { url: 'https://example.com/' })
  await s.stop()

  const full = {
    screenshot: () => Promise.reject(new WebsnapError('queue_full', 503, { capacity: 8 })),
  }
  const s2 = await startServer({ coreOverrides: full })
  const r503 = await call(s2.base, { method: 'POST', path: '/screenshot', body: { url: 'https://example.com/' } })
  assert.equal(r503.status, 503)
  assert.equal(r503.json.error, 'queue_full')
  await s2.stop()
})

test('a private URL is blocked before the core and never reaches it', async () => {
  const s = await startServer()
  const { status, json } = await call(s.base, {
    method: 'POST',
    path: '/screenshot',
    body: { url: 'http://localhost/x' },
  })
  assert.equal(status, 400)
  assert.equal(json.error, 'blocked_address')
  assert.equal(s.seen.length, 0, 'the core must not see a blocked request')
  await s.stop()
})

test('allowPrivateAddresses lets the same request through to the core', async () => {
  const s = await startServer({ configOverrides: { allowPrivateAddresses: true } })
  const { status, text } = await call(s.base, {
    method: 'POST',
    path: '/screenshot',
    body: { url: 'http://localhost/x' },
  })
  assert.equal(status, 200)
  assert.equal(text, 'fakepng')
  assert.equal(s.seen.length, 1)
  await s.stop()
})

test('POST /pdf returns pdf bytes', async () => {
  const s = await startServer()
  const { status, contentType, text } = await call(s.base, {
    method: 'POST',
    path: '/pdf',
    body: { url: 'https://example.com/' },
  })
  assert.equal(status, 200)
  assert.ok(contentType.startsWith('application/pdf'))
  assert.equal(text, '%PDF-fake')
  await s.stop()
})

test('GET /devices lists the registry', async () => {
  const s = await startServer()
  const { status, json } = await call(s.base, { path: '/devices' })
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.devices))
  assert.ok(json.devices.length > 0)
  assert.equal(typeof json.devices[0].name, 'string')
  await s.stop()
})

test('an unknown route is 404 not_found', async () => {
  const s = await startServer()
  const { status, json } = await call(s.base, { path: '/nope' })
  assert.equal(status, 404)
  assert.equal(json.error, 'not_found')
  await s.stop()
})

test('an unexpected core exception is 500 and the server keeps serving', async () => {
  const s = await startServer({
    coreOverrides: {
      screenshot: () => Promise.reject(new Error('surprise')),
      health: () => ({ ok: true, chromium: 'still-alive' }),
    },
  })
  const r500 = await call(s.base, { method: 'POST', path: '/screenshot', body: { url: 'https://example.com/' } })
  assert.equal(r500.status, 500)
  assert.equal(r500.json.error, 'internal')
  const rHealth = await call(s.base, { path: '/health' })
  assert.equal(rHealth.status, 200)
  assert.deepEqual(rHealth.json, { ok: true, chromium: 'still-alive' })
  await s.stop()
})
