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

test('allowPrivate short-circuits every blocked case', async () => {
  await assertAllowedHost('http://localhost/x', { allowPrivate: true })
  await assertAllowedHost('http://[::1]/', { allowPrivate: true })
  await assertAllowedHost('http://192.168.1.1/', { allowPrivate: true })
})

test('a hostname that fails DNS passes through to navigation', async () => {
  await assertAllowedHost('http://no-such-host-websnap.invalid/', { allowPrivate: false })
})
