import { devices } from 'playwright'
import { WebsnapError } from './errors.js'

const entries = Object.entries(devices)

export function listDevices() {
  return entries.map(([name, d]) => ({
    name,
    viewport: { width: d.viewport.width, height: d.viewport.height },
    device_scale_factor: d.deviceScaleFactor,
    mobile: d.isMobile,
    touch: d.hasTouch,
    user_agent: d.userAgent,
  }))
}

export function resolveDevice(name) {
  // Object.hasOwn, not property access: 'constructor'/'__proto__' must be
  // unknown device names, not inherited object members.
  if (Object.hasOwn(devices, name)) return { name, descriptor: devices[name] }
  const lower = name.toLowerCase()
  const matches = entries.filter(([n]) => n.toLowerCase() === lower).map(([n]) => n)
  if (matches.length === 1) {
    return { name: matches[0], descriptor: devices[matches[0]] }
  }
  // No match, or the case-insensitive match is ambiguous: both are caller errors.
  const names = entries.map(([n]) => n).sort()
  throw new WebsnapError('unknown_device', 400, { valid: names.slice(0, 20), total: names.length })
}
