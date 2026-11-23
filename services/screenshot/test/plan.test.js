import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildShotPlan, buildPdfPlan } from '../src/plan.js'
import { parseScreenshotBody, parsePdfBody } from '../src/validate.js'

const url = 'https://example.com/'

const shot = (body) => parseScreenshotBody(body).req
const pdf = (body) => parsePdfBody(body).req

test('neither device nor viewport defaults to 1280x720 at dpr 1', () => {
  const plan = buildShotPlan(shot({ url }))
  assert.deepEqual(plan.contextOptions.viewport, { width: 1280, height: 720 })
  assert.equal(plan.contextOptions.deviceScaleFactor, 1)
})

test('a device preset builds a mobile context from the registry', () => {
  const plan = buildShotPlan(shot({ url, device: 'iPhone 15' }))
  const { contextOptions: ctx } = plan
  assert.equal(ctx.isMobile, true)
  assert.equal(typeof ctx.userAgent, 'string')
  assert.notEqual(ctx.userAgent, '')
  assert.ok(Number.isInteger(ctx.viewport.width) && ctx.viewport.width > 0)
  assert.ok(Number.isInteger(ctx.viewport.height) && ctx.viewport.height > 0)
  assert.equal(typeof ctx.deviceScaleFactor, 'number')
  assert.equal(typeof ctx.hasTouch, 'boolean')
})

test('an explicit viewport maps field names to playwright names', () => {
  const plan = buildShotPlan(shot({ url, viewport: { width: 390, height: 844, device_scale_factor: 3, mobile: true, touch: true } }))
  const { contextOptions: ctx } = plan
  assert.deepEqual(ctx.viewport, { width: 390, height: 844 })
  assert.equal(ctx.deviceScaleFactor, 3)
  assert.equal(ctx.isMobile, true)
  assert.equal(ctx.hasTouch, true)
  assert.equal('userAgent' in ctx, false)
})

test('dark_mode sets colorScheme dark', () => {
  const plan = buildShotPlan(shot({ url, dark_mode: true }))
  assert.equal(plan.contextOptions.colorScheme, 'dark')
})

test('gotoOptions mirrors wait_until and timeout_ms', () => {
  const plan = buildShotPlan(shot({ url, wait_until: 'networkidle', timeout_ms: 5000 }))
  assert.deepEqual(plan.gotoOptions, { waitUntil: 'networkidle', timeout: 5000 })
})

test('jpeg screenshots carry quality; png screenshots have none', () => {
  const jpeg = buildShotPlan(shot({ url, format: 'jpeg', quality: 75 }))
  assert.deepEqual(jpeg.screenshotOptions, { fullPage: false, type: 'jpeg', quality: 75 })
  const png = buildShotPlan(shot({ url }))
  assert.deepEqual(png.screenshotOptions, { fullPage: false, type: 'png' })
  assert.equal('quality' in png.screenshotOptions, false)
})

test('full_page and selector and console carry through', () => {
  const plan = buildShotPlan(shot({ url, full_page: true }))
  assert.equal(plan.screenshotOptions.fullPage, true)
  const withSelector = buildShotPlan(shot({ url, selector: '#hero', console: true }))
  assert.equal(withSelector.selector, '#hero')
  assert.equal(withSelector.captureConsole, true)
  assert.equal(withSelector.screenshotOptions.fullPage, false)
})

test('buildPdfPlan defaults A4 with background and load wait', () => {
  const plan = buildPdfPlan(pdf({ url }))
  assert.deepEqual(plan.pdfOptions, { format: 'A4', printBackground: true })
  assert.deepEqual(plan.gotoOptions, { waitUntil: 'load', timeout: 30000 })
  assert.deepEqual(plan.contextOptions.viewport, { width: 1280, height: 720 })
})

test('buildPdfPlan mirrors overrides', () => {
  const plan = buildPdfPlan(pdf({ url, format: 'Letter', print_background: false, timeout_ms: 45000 }))
  assert.deepEqual(plan.pdfOptions, { format: 'Letter', printBackground: false })
  assert.deepEqual(plan.gotoOptions, { waitUntil: 'load', timeout: 45000 })
})
