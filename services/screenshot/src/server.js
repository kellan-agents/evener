import { createHash, timingSafeEqual } from 'node:crypto'
import { WebsnapError } from './errors.js'
import { parseScreenshotBody, parsePdfBody, readJsonBody } from './validate.js'
import { assertAllowedHost } from './addresses.js'
import { listDevices } from './devices.js'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function createApp({ config, core }) {
  const tokenHash = createHash('sha256').update(config.token).digest()

  function authorized(req) {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    if (!match) return false
    // Compare digests so token length leaks nothing and the compare is
    // constant-time.
    const presented = createHash('sha256').update(match[1]).digest()
    return timingSafeEqual(tokenHash, presented)
  }

  async function handle(req, res) {
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'unauthorized', detail: null })
    }
    const route = `${req.method} ${req.url}`
    if (route === 'GET /health') return sendJson(res, 200, core.health())
    if (route === 'GET /devices') return sendJson(res, 200, { devices: listDevices() })
    if (route === 'POST /screenshot') return await handleScreenshot(req, res)
    if (route === 'POST /pdf') return await handlePdf(req, res)
    throw new WebsnapError('not_found', 404, { path: req.url })
  }

  async function handleScreenshot(req, res) {
    const parsed = parseScreenshotBody(await readJsonBody(req))
    if (!parsed.ok) throw new WebsnapError(parsed.code, 400, { field: parsed.field })
    const request = parsed.req
    await assertAllowedHost(request.url, { allowPrivate: config.allowPrivateAddresses })
    const result = await core.screenshot(request)
    if (request.console) {
      return sendJson(res, 200, result)
    }
    const contentType = request.format === 'jpeg' ? 'image/jpeg' : 'image/png'
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': result.length })
    res.end(result)
  }

  async function handlePdf(req, res) {
    const parsed = parsePdfBody(await readJsonBody(req))
    if (!parsed.ok) throw new WebsnapError(parsed.code, 400, { field: parsed.field })
    const request = parsed.req
    await assertAllowedHost(request.url, { allowPrivate: config.allowPrivateAddresses })
    const result = await core.pdf(request)
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': result.length })
    res.end(result)
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      const e = err instanceof WebsnapError ? err : new WebsnapError('internal', 500, null)
      if (!res.headersSent) {
        sendJson(res, e.status, { error: e.code, detail: e.detail })
      } else {
        // Bytes already went out; the best recovery is ending the stream.
        res.destroy()
      }
    })
  }
}
