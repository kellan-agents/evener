import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createCore, probeChromium } from '../src/core.js'
import { resolveDevice } from '../src/devices.js'
import { parseScreenshotBody, parsePdfBody } from '../src/validate.js'
import { WebsnapError } from '../src/errors.js'

const FIXTURE_HTML = `<!doctype html><html><body>
<div id="hero" style="width:100vw;height:10px;background:rebeccapurple"></div>
<script>
  console.log('viewport ' + window.innerWidth)
  setTimeout(() => { throw new Error('fixture-page-error') }, 0)
</script>
</body></html>`

let fixturePromise = null
async function getFixture() {
  if (fixturePromise === null) {
    fixturePromise = new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(FIXTURE_HTML)
      })
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${server.address().port}/`)
      })
    })
  }
  return fixturePromise
}

let corePromise = null
async function getCore() {
  if (corePromise === null) {
    corePromise = (async () => {
      const core = createCore()
      await core.start()
      return core
    })()
  }
  return corePromise
}

after(async () => {
  if (corePromise !== null) {
    const core = await corePromise
    await core.stop()
  }
})

async function closedPortUrl() {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}/`
}

function shot(body) {
  return parseScreenshotBody(body).req
}

test('screenshot of the fixture page produces a real PNG', async (t) => {
  const version = await probeChromium()
  if (!version) return t.skip('no usable Chromium — browser-gated test skipped')
  const core = await getCore()
  const image = await core.screenshot(shot({ url: await getFixture() }))
  assert.ok(Buffer.isBuffer(image))
  assert.deepEqual(image.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})

test('a device preset reaches the page as real emulation', async (t) => {
  const version = await probeChromium()
  if (!version) return t.skip('no usable Chromium — browser-gated test skipped')
  const core = await getCore()
  const { descriptor } = resolveDevice('iPhone 15')
  const result = await core.screenshot(shot({ url: await getFixture(), device: 'iPhone 15', console: true }))
  const entry = result.console.find((m) => m.text.startsWith('viewport '))
  assert.ok(entry, 'fixture must report its viewport width')
  // The page reports the same width the preset asked for: emulation held.
  assert.equal(Number(entry.text.slice('viewport '.length)), descriptor.viewport.width)
})

test('console capture collects the fixture log and page error', async (t) => {
  const version = await probeChromium()
  if (!version) return t.skip('no usable Chromium — browser-gated test skipped')
  const core = await getCore()
  const url = await getFixture()
  const result = await core.screenshot(shot({ url, console: true }))
  const entry = result.console.find((m) => m.text.startsWith('viewport '))
  assert.ok(entry)
  assert.equal(entry.type, 'log')
  assert.ok(result.page_errors.some((e) => e.includes('fixture-page-error')))
  assert.equal(result.final_url, url)
})

test('a selector that never appears is 404 selector_not_found', async (t) => {
  const version = await probeChromium()
  if (!version) return t.skip('no usable Chromium — browser-gated test skipped')
  const core = await getCore()
  await assert.rejects(
    core.screenshot(shot({ url: await getFixture(), selector: '#never-there', timeout_ms: 500 })),
    (err) => {
      assert.ok(err instanceof WebsnapError)
      assert.equal(err.code, 'selector_not_found')
      assert.equal(err.status, 404)
      return true
    }
  )
})

test('an unreachable URL is 502 navigation_failed', async (t) => {
  const version = await probeChromium()
  if (!version) return t.skip('no usable Chromium — browser-gated test skipped')
  const core = await getCore()
  await assert.rejects(
    core.screenshot(shot({ url: await closedPortUrl(), timeout_ms: 2000 })),
    (err) => {
      assert.ok(err instanceof WebsnapError)
      assert.equal(err.code, 'navigation_failed')
      assert.equal(err.status, 502)
      return true
    }
  )
})

test('pdf of the fixture page produces a real PDF', async (t) => {
  const version = await probeChromium()
  if (!version) return t.skip('no usable Chromium — browser-gated test skipped')
  const core = await getCore()
  const doc = await core.pdf(parsePdfBody({ url: await getFixture(), timeout_ms: 10000 }).req)
  assert.ok(Buffer.isBuffer(doc))
  assert.equal(doc.subarray(0, 4).toString(), '%PDF')
})
