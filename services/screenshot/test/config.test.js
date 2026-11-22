import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('refuses to start when WEBSNAP_TOKEN is missing', () => {
  assert.throws(() => loadConfig({}))
})

test('refuses to start when WEBSNAP_TOKEN is whitespace only', () => {
  assert.throws(() => loadConfig({ WEBSNAP_TOKEN: '   ' }))
})

test('defaults port to 8080 and allowPrivateAddresses to false', () => {
  assert.deepEqual(loadConfig({ WEBSNAP_TOKEN: 't' }), {
    port: 8080,
    token: 't',
    allowPrivateAddresses: false,
  })
})

test('PORT overrides the port', () => {
  const cfg = loadConfig({ WEBSNAP_TOKEN: 't', PORT: '9100' })
  assert.equal(cfg.port, 9100)
})

test('ALLOW_PRIVATE_ADDRESSES is true only for the exact string "true"', () => {
  assert.equal(loadConfig({ WEBSNAP_TOKEN: 't', ALLOW_PRIVATE_ADDRESSES: 'true' }).allowPrivateAddresses, true)
  assert.equal(loadConfig({ WEBSNAP_TOKEN: 't', ALLOW_PRIVATE_ADDRESSES: 'TRUE' }).allowPrivateAddresses, false)
  assert.equal(loadConfig({ WEBSNAP_TOKEN: 't', ALLOW_PRIVATE_ADDRESSES: '1' }).allowPrivateAddresses, false)
})

test('token is trimmed', () => {
  assert.equal(loadConfig({ WEBSNAP_TOKEN: ' t ' }).token, 't')
})
