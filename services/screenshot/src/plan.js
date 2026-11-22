import { resolveDevice } from './devices.js'

function buildContextOptions(req) {
  if (req.device !== null) {
    const { descriptor } = resolveDevice(req.device)
    return {
      viewport: { width: descriptor.viewport.width, height: descriptor.viewport.height },
      deviceScaleFactor: descriptor.deviceScaleFactor,
      isMobile: descriptor.isMobile,
      hasTouch: descriptor.hasTouch,
      userAgent: descriptor.userAgent,
    }
  }
  if (req.viewport !== null) {
    return {
      viewport: { width: req.viewport.width, height: req.viewport.height },
      deviceScaleFactor: req.viewport.device_scale_factor,
      isMobile: req.viewport.mobile,
      hasTouch: req.viewport.touch,
    }
  }
  return { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }
}

export function buildShotPlan(req) {
  const contextOptions = buildContextOptions(req)
  if (req.dark_mode) {
    contextOptions.colorScheme = 'dark'
  }
  const screenshotOptions = { fullPage: req.full_page, type: req.format }
  if (req.format === 'jpeg') {
    screenshotOptions.quality = req.quality
  }
  return {
    contextOptions,
    gotoOptions: { waitUntil: req.wait_until, timeout: req.timeout_ms },
    screenshotOptions,
    selector: req.selector,
    captureConsole: req.console,
  }
}

export function buildPdfPlan(req) {
  return {
    contextOptions: buildContextOptions(req),
    gotoOptions: { waitUntil: 'load', timeout: req.timeout_ms },
    pdfOptions: { format: req.format, printBackground: req.print_background },
  }
}
