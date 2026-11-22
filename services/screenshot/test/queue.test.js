import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebsnapError } from '../src/errors.js'
import { createQueue } from '../src/queue.js'

const wait = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))

test('jobs run strictly serially in FIFO order', async () => {
  const q = createQueue({ capacity: 8 })
  const events = []
  const a = q.run(async () => {
    events.push('a-start')
    await wait(30)
    events.push('a-end')
    return 'a'
  })
  const b = q.run(async () => {
    events.push('b-start')
    await wait(5)
    events.push('b-end')
    return 'b'
  })
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b'])
  // b must not start until a has finished: the queue is serial, not racing.
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('at most one job is ever in flight', async () => {
  const q = createQueue({ capacity: 8 })
  let active = 0
  let maxActive = 0
  const jobs = Array.from({ length: 8 }, (_, i) =>
    q.run(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await wait(10)
      active--
      return i
    })
  )
  const results = await Promise.all(jobs)
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(maxActive, 1)
})

test('the 9th run while 8 are pending rejects immediately with 503 queue_full', async () => {
  const q = createQueue({ capacity: 8 })
  const running = Array.from({ length: 8 }, (_, i) => q.run(() => wait(50, i)))
  assert.equal(q.pending, 8)
  await assert.rejects(q.run(() => wait(50, 'x')), (err) => {
    assert.ok(err instanceof WebsnapError)
    assert.equal(err.code, 'queue_full')
    assert.equal(err.status, 503)
    assert.deepEqual(err.detail, { capacity: 8 })
    return true
  })
  assert.deepEqual(await Promise.all(running), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('after draining, capacity is free again', async () => {
  const q = createQueue({ capacity: 8 })
  const first = Array.from({ length: 8 }, (_, i) => q.run(() => wait(5, i)))
  await Promise.all(first)
  assert.equal(q.pending, 0)
  assert.equal(await q.run(() => wait(5, 'after')), 'after')
})

test('a failing job frees its queue slot and does not break the chain', async () => {
  const q = createQueue({ capacity: 1 })
  const boom = q.run(async () => {
    throw new Error('boom')
  })
  await assert.rejects(boom)
  assert.equal(await q.run(() => wait(5, 'next')), 'next')
})
