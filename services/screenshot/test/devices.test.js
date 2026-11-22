import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebsnapError } from '../src/errors.js'
import { listDevices, resolveDevice } from '../src/devices.js'

test('listDevices returns a nonempty registry with well-formed entries', () => {
  const devices = listDevices()
  assert.ok(devices.length > 0)
  for (const d of devices) {
    assert.equal(typeof d.name, 'string')
    assert.notEqual(d.name, '')
    assert.ok(Number.isInteger(d.viewport.width) && d.viewport.width > 0, `bad width on ${d.name}`)
    assert.ok(Number.isInteger(d.viewport.height) && d.viewport.height > 0, `bad height on ${d.name}`)
    assert.equal(typeof d.device_scale_factor, 'number')
    assert.equal(typeof d.mobile, 'boolean')
    assert.equal(typeof d.touch, 'boolean')
    assert.equal(typeof d.user_agent, 'string')
  }
})

test('the registry contains iPhone 15 and it is a mobile device', () => {
  const names = listDevices().map((d) => d.name)
  assert.ok(names.includes('iPhone 15'), `registry lacks iPhone 15; has ${names.length} entries`)
  const { name, descriptor } = resolveDevice('iPhone 15')
  assert.equal(name, 'iPhone 15')
  assert.equal(descriptor.isMobile, true)
  assert.equal(descriptor.viewport.width > 0, true)
})

test('resolveDevice matches case-insensitively', () => {
  const { name } = resolveDevice('iphone 15')
  assert.equal(name, 'iPhone 15')
})

test('resolveDevice throws a 400 unknown_device for a bogus name', () => {
  assert.throws(() => resolveDevice('Nokia 3310'), (err) => {
    assert.ok(err instanceof WebsnapError)
    assert.equal(err.code, 'unknown_device')
    assert.equal(err.status, 400)
    assert.ok(Array.isArray(err.detail.valid))
    assert.ok(err.detail.valid.length > 0)
    assert.ok(err.detail.valid.length <= 20, 'valid list should be truncated')
    assert.equal(err.detail.valid.includes('Nokia 3310'), false)
    assert.equal(typeof err.detail.total, 'number')
    assert.ok(err.detail.total >= err.detail.valid.length)
    return true
  })
})
