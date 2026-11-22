import { WebsnapError } from './errors.js'

export function createQueue({ capacity = 8 } = {}) {
  let pending = 0
  let tail = Promise.resolve()
  return {
    run(job) {
      if (pending >= capacity) {
        return Promise.reject(new WebsnapError('queue_full', 503, { capacity }))
      }
      pending++
      const result = tail.then(() => job())
      // The chain swallows outcomes so one failed job cannot stall the rest.
      tail = result.then(() => {}, () => {})
      return result.finally(() => {
        pending--
      })
    },
    get pending() {
      return pending
    },
  }
}
