import { chromium as playwrightChromium } from 'playwright'
import { WebsnapError } from './errors.js'
import { createQueue } from './queue.js'
import { buildShotPlan, buildPdfPlan } from './plan.js'

let probePromise = null

// Launch-and-close probe: returns the Chromium version, or null when no
// usable browser exists on this host. Cached module-level so repeated
// browser-gated checks do not relaunch.
export function probeChromium() {
  if (probePromise === null) {
    probePromise = (async () => {
      try {
        const browser = await playwrightChromium.launch()
        const version = browser.version()
        await browser.close()
        return version
      } catch {
        return null
      }
    })()
  }
  return probePromise
}

export function createCore({ chromium } = {}) {
  const engine = chromium ?? playwrightChromium
  const queue = createQueue({ capacity: 8 })
  let browser = null

  return {
    async start() {
      browser = await engine.launch()
    },

    async stop() {
      if (browser !== null) {
        const b = browser
        browser = null
        await b.close()
      }
    },

    health() {
      return { ok: true, chromium: browser.version() }
    },

    screenshot(req) {
      return queue.run(() => screenshotJob(req))
    },

    pdf(req) {
      return queue.run(() => pdfJob(req))
    },
  }

  async function newPage(contextOptions) {
    if (browser === null) {
      throw new WebsnapError('not_started', 500, null)
    }
    const context = await browser.newContext(contextOptions)
    const page = await context.newPage()
    return { context, page }
  }

  async function gotoOr502(page, req, gotoOptions) {
    try {
      await page.goto(req.url, gotoOptions)
    } catch {
      // Any navigation failure — DNS, timeout, TLS — is a bad gateway from
      // this service's point of view.
      throw new WebsnapError('navigation_failed', 502, { url: req.url })
    }
  }

  async function screenshotJob(req) {
    const plan = buildShotPlan(req)
    const startedAt = Date.now()
    const { context, page } = await newPage(plan.contextOptions)
    try {
      let logs = null
      let pageErrors = null
      if (plan.captureConsole) {
        logs = []
        pageErrors = []
        page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }))
        page.on('pageerror', (e) => pageErrors.push(String(e)))
      }
      await gotoOr502(page, req, plan.gotoOptions)

      let image
      if (plan.selector !== null) {
        try {
          const options = { timeout: req.timeout_ms, type: plan.screenshotOptions.type }
          if (plan.screenshotOptions.quality !== undefined) {
            options.quality = plan.screenshotOptions.quality
          }
          image = await page.locator(plan.selector).screenshot(options)
        } catch (err) {
          // Phase-scoped: only selector-phase timeouts are 404; everything
          // else about the selector (syntax, not attached) is a 400.
          if (err.name === 'TimeoutError') {
            throw new WebsnapError('selector_not_found', 404, { selector: plan.selector })
          }
          throw new WebsnapError('invalid_selector', 400, { selector: plan.selector })
        }
      } else {
        image = await page.screenshot(plan.screenshotOptions)
      }

      if (!plan.captureConsole) {
        return image
      }
      return {
        image: image.toString('base64'),
        console: logs,
        page_errors: pageErrors,
        final_url: page.url(),
        elapsed_ms: Date.now() - startedAt,
      }
    } finally {
      await context.close()
    }
  }

  async function pdfJob(req) {
    const plan = buildPdfPlan(req)
    const { context, page } = await newPage(plan.contextOptions)
    try {
      await gotoOr502(page, req, plan.gotoOptions)
      return await page.pdf(plan.pdfOptions)
    } finally {
      await context.close()
    }
  }
}
