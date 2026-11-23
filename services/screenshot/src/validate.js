import { WebsnapError } from './errors.js'

const fail = (field, code = 'invalid_request') => ({ ok: false, field, code })

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseUrl(body) {
  const raw = body.url
  if (typeof raw !== 'string' || raw === '') return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return raw
}

function rejectUnknownKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return key
  }
  return null
}

// Shared by both parsers: url, device XOR viewport, timeout_ms.
function parseCommon(body, field) {
  const url = parseUrl(body)
  if (url === null) return { error: fail('url') }

  if (body.device !== undefined && body.viewport !== undefined) {
    return { error: fail('device') }
  }

  let device = null
  if (body.device !== undefined) {
    if (typeof body.device !== 'string' || body.device === '') return { error: fail('device') }
    device = body.device
  }

  let viewport = null
  if (body.viewport !== undefined) {
    const vp = body.viewport
    if (!isPlainObject(vp)) return { error: fail('viewport') }
    if (!Number.isInteger(vp.width) || vp.width < 1 || vp.width > 16384) return { error: fail('viewport') }
    if (!Number.isInteger(vp.height) || vp.height < 1 || vp.height > 16384) return { error: fail('viewport') }
    const dpr = vp.device_scale_factor === undefined ? 1 : vp.device_scale_factor
    if (typeof dpr !== 'number' || dpr < 1 || dpr > 10) return { error: fail('viewport') }
    const mobile = vp.mobile === undefined ? false : vp.mobile
    if (typeof mobile !== 'boolean') return { error: fail('viewport') }
    const touch = vp.touch === undefined ? false : vp.touch
    if (typeof touch !== 'boolean') return { error: fail('viewport') }
    viewport = { width: vp.width, height: vp.height, device_scale_factor: dpr, mobile, touch }
  }

  const timeout_ms = body.timeout_ms === undefined ? 30000 : body.timeout_ms
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 120000) {
    return { error: fail('timeout_ms') }
  }

  return { url, device, viewport, timeout_ms }
}

export function parseScreenshotBody(raw) {
  if (!isPlainObject(raw)) return fail('body')
  const unknown = rejectUnknownKeys(raw, new Set([
    'url', 'device', 'viewport', 'full_page', 'selector', 'dark_mode',
    'wait_until', 'timeout_ms', 'format', 'quality', 'console',
  ]))
  if (unknown !== null) return fail(unknown, 'unknown_field')

  const common = parseCommon(raw)
  if (common.error) return common.error
  const { url, device, viewport, timeout_ms } = common

  const full_page = raw.full_page === undefined ? false : raw.full_page
  if (typeof full_page !== 'boolean') return fail('full_page')

  let selector = null
  if (raw.selector !== undefined) {
    if (typeof raw.selector !== 'string' || raw.selector === '') return fail('selector')
    selector = raw.selector
  }
  if (selector !== null && full_page) return fail('selector')

  const dark_mode = raw.dark_mode === undefined ? false : raw.dark_mode
  if (typeof dark_mode !== 'boolean') return fail('dark_mode')

  const wait_until = raw.wait_until === undefined ? 'load' : raw.wait_until
  if (!['load', 'domcontentloaded', 'networkidle'].includes(wait_until)) return fail('wait_until')

  const format = raw.format === undefined ? 'png' : raw.format
  if (format !== 'png' && format !== 'jpeg') return fail('format')

  let quality = null
  if (format === 'jpeg') {
    quality = raw.quality === undefined ? 80 : raw.quality
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) return fail('quality')
  } else if (raw.quality !== undefined) {
    return fail('quality')
  }

  const console_ = raw.console === undefined ? false : raw.console
  if (typeof console_ !== 'boolean') return fail('console')

  return {
    ok: true,
    req: { url, device, viewport, full_page, selector, dark_mode, wait_until, timeout_ms, format, quality, console: console_ },
  }
}

const PDF_FORMATS = new Set(['Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'])

export function parsePdfBody(raw) {
  if (!isPlainObject(raw)) return fail('body')
  // device/viewport are deliberately absent from pdf bodies: Playwright's
  // page.pdf() lays out at print media and paper size, so emulation would be
  // a silent no-op — absent rather than decorative (spec).
  const unknown = rejectUnknownKeys(raw, new Set(['url', 'format', 'print_background', 'timeout_ms']))
  if (unknown !== null) return fail(unknown, 'unknown_field')

  const common = parseCommon(raw)
  if (common.error) return common.error
  const { url, timeout_ms } = common

  const format = raw.format === undefined ? 'A4' : raw.format
  if (!PDF_FORMATS.has(format)) return fail('format')

  const print_background = raw.print_background === undefined ? true : raw.print_background
  if (typeof print_background !== 'boolean') return fail('print_background')

  return {
    ok: true,
    req: { url, format, print_background, timeout_ms },
  }
}

export async function readJsonBody(req, { limitBytes = 16384 } = {}) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += bytes.length
    if (total > limitBytes) {
      throw new WebsnapError('body_too_large', 413, { limit_bytes: limitBytes })
    }
    chunks.push(bytes)
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new WebsnapError('invalid_json', 400, null)
  }
  if (!isPlainObject(parsed)) throw new WebsnapError('invalid_json', 400, null)
  return parsed
}
