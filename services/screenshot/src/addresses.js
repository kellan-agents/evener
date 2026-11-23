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

function classifyV4(ip) {
  if (ip.split('.')[0] === '127') return 'loopback'
  if (v4Blocked(ip)) return 'private'
  return 'public'
}

// Parse an IPv6 literal into 8 hextet numbers, expanding '::' and an embedded
// dotted quad. Node's URL parser re-serializes v4-mapped addresses in hex
// (::ffff:7f00:1), so the dotted form must never be assumed.
function parseV6Groups(ip) {
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const left = halves.length === 2 ? halves[0] : ip
  const right = halves.length === 2 ? halves[1] : null
  const leftGroups = left === '' ? [] : left.split(':')
  const rightGroups = right == null || right === '' ? [] : right.split(':')
  const expand = (groups) => {
    const out = []
    for (const g of groups) {
      if (g.includes('.')) {
        const quads = g.split('.').map(Number)
        if (quads.length !== 4 || quads.some((q) => !Number.isInteger(q) || q < 0 || q > 255)) return null
        out.push((quads[0] << 8) | quads[1], (quads[2] << 8) | quads[3])
      } else {
        const v = parseInt(g, 16)
        if (Number.isNaN(v)) return null
        out.push(v)
      }
    }
    return out
  }
  const l = expand(leftGroups)
  const r = expand(rightGroups)
  if (l === null || r === null) return null
  const total = l.length + r.length
  if (total > 8) return null
  if (halves.length !== 2 && total !== 8) return null
  return [...l, ...new Array(8 - total).fill(0), ...r]
}

function classifyV6(groups) {
  if (groups.slice(0, 7).every((x) => x === 0) && groups[7] === 1) return 'loopback'
  // ::ffff:0:0/96 — v4-mapped: judge the embedded v4 address.
  if (groups.slice(0, 5).every((x) => x === 0) && groups[5] === 0xffff) {
    const embedded = `${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`
    return classifyV4(embedded)
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private' // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return 'private' // fe80::/10 link-local
  return 'public'
}

// 'loopback' | 'private' | 'public' — the policy's three classes. Own
// loopback is always refused; private/link-local unless allowPrivate.
export function classifyIp(ip) {
  const kind = isIP(ip)
  if (kind === 4) return classifyV4(ip)
  if (kind === 6) {
    const groups = parseV6Groups(ip.toLowerCase())
    // Unparseable literals fail closed: blocked by default.
    return groups === null ? 'private' : classifyV6(groups)
  }
  return 'public'
}

export function isBlockedIp(ip) {
  return classifyIp(ip) !== 'public'
}

export function isLoopbackIp(ip) {
  return classifyIp(ip) === 'loopback'
}

function blockedError(hostname) {
  return new WebsnapError('blocked_address', 400, { host: hostname })
}

function assertAddress(address, hostname, allowPrivate) {
  if (isLoopbackIp(address)) throw blockedError(hostname)
  if (!allowPrivate && isBlockedIp(address)) throw blockedError(hostname)
}

// The target host is resolved once, here; navigation resolves it again and
// follows redirects, so rebinding and redirects are beyond this check — the
// bearer token is the remaining barrier (documented accepted risk on a
// trusted LAN).
export async function assertAllowedHost(url, { allowPrivate }) {
  const { hostname: rawHost } = new URL(url)
  // URL.hostname keeps brackets on IPv6 literals ([::1]), which isIP rejects.
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (isIP(hostname) !== 0) {
    assertAddress(hostname, hostname, allowPrivate)
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
    assertAddress(address, hostname, allowPrivate)
  }
}
