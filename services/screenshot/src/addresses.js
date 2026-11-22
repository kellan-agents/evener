import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { WebsnapError } from './errors.js'

function v4Blocked(ip) {
  const [a, b] = ip.split('.').map(Number)
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  return false
}

function v6Blocked(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  // v4-mapped: ::ffff:0:0/96 — judge the embedded v4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return v4Blocked(mapped[1])
  const headHex = lower.split(':')[0]
  const head = headHex === '' ? 0 : parseInt(headHex, 16)
  if ((head & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  return false
}

export function isBlockedIp(ip) {
  const kind = isIP(ip)
  if (kind === 4) return v4Blocked(ip)
  if (kind === 6) return v6Blocked(ip)
  return false
}

// The hostname is resolved once, here; navigation resolves it again, so a
// hostname that rebinds between the two is beyond this check — the bearer
// token is the remaining barrier (documented accepted risk on a trusted LAN).
export async function assertAllowedHost(url, { allowPrivate }) {
  if (allowPrivate) return
  const { hostname: rawHost } = new URL(url)
  // URL.hostname keeps brackets on IPv6 literals ([::1]), which isIP rejects.
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new WebsnapError('blocked_address', 400, { host: hostname })
    }
    return
  }
  let answers
  try {
    answers = await lookup(hostname, { all: true })
  } catch {
    // Unresolvable: let navigation surface the failure as a 502.
    return
  }
  for (const { address } of answers) {
    if (isBlockedIp(address)) {
      throw new WebsnapError('blocked_address', 400, { host: hostname })
    }
  }
}
