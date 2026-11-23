import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebsnapError } from '../src/errors.js'
import { isBlockedIp, assertAllowedHost } from '../src/addresses.js'

const blockedIps = [
  '127.0.0.1',
  '10.0.0.5',
  '192.168.1.1',
  '172.16.0.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '::1',
  'fe80::1',
  'fc00::1',
  'fd12::1',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
  '::ffff:7f00:1',
  '::ffff:a9fe:a9fe',
]

for (const ip of blockedIps) {
  test(`isBlockedIp blocks ${ip}`, () => {
    assert.equal(isBlockedIp(ip), true)
  })
}

const allowedIps = ['8.8.8.8', '1.1.1.1', '2606:4700::1111']

for (const ip of allowedIps) {
  test(`isBlockedIp allows ${ip}`, () => {
    assert.equal(isBlockedIp(ip), false)
  })
}

test('isBlockedIp rejects things that are not IP literals', () => {
  assert.equal(isBlockedIp('example.com'), false)
})

async function assertBlocked(url) {
  await assert.rejects(assertAllowedHost(url, { allowPrivate: false }), (err) => {
    assert.ok(err instanceof WebsnapError)
    assert.equal(err.code, 'blocked_address')
    assert.equal(err.status, 400)
    return true
  })
}

test('localhost is blocked (resolves to loopback without network)', async () => {
  await assertBlocked('http://localhost/x')
})

test('a public IP literal passes', async () => {
  await assertAllowedHost('http://8.8.8.8/', { allowPrivate: false })
})

test('an IPv6 loopback literal is blocked', async () => {
  await assertBlocked('http://[::1]/')
})

test('an IPv6 private literal is blocked', async () => {
  await assertBlocked('http://[fc00::1]/')
})

test('v4-mapped private IPv6 literals are blocked in every URL form', async () => {
  // Node's URL parser re-serializes dotted v4-mapped forms to hex, so the
  // policy must catch both spellings through assertAllowedHost.
  await assertBlocked('http://[::ffff:127.0.0.1]/')
  await assertBlocked('http://[::ffff:7f00:1]/')
  await assertBlocked('http://[::ffff:a9fe:a9fe]/')
  await assertBlocked('http://[::ffff:10.0.0.1]/')
})

test('own loopback stays blocked even with allowPrivate', async () => {
  for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/x']) {
    await assert.rejects(assertAllowedHost(u, { allowPrivate: true }), (err) => {
      assert.ok(err instanceof WebsnapError)
      assert.equal(err.code, 'blocked_address')
      assert.equal(err.status, 400)
      return true
    })
  }
})

test('allowPrivate lifts private LAN and link-local but not loopback', async () => {
  await assertAllowedHost('http://192.168.1.1/', { allowPrivate: true })
  await assertAllowedHost('http://10.0.0.5/', { allowPrivate: true })
  await assertAllowedHost('http://[fc00::1]/', { allowPrivate: true })
  await assertAllowedHost('http://[fe80::1]/', { allowPrivate: true })
  await assertAllowedHost('http://[fd12::1]/', { allowPrivate: true })
})

test('a hostname that fails DNS passes through to navigation', async () => {
  await assertAllowedHost('http://no-such-host-websnap.invalid/', { allowPrivate: false })
})
