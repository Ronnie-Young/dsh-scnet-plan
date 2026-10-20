import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlanService, toFailure } from '../lib/plan-service.js'

/** A snapshot fixture with the fields the service only stamps/timestamps. */
const SNAPSHOT = {
  planName: '基础版',
  status: 'active',
  totalCredits: 60000,
  usedCredits: 15000,
  remainingCredits: 45000,
  usedPercent: 25,
  source: 'console',
  needsCookie: false,
}

test('reuses a fresh cache without calling the fetcher again', async () => {
  let calls = 0
  const service = createPlanService({
    ttlMs: () => 60_000,
    fetchPlan: async () => {
      calls += 1
      return { ...SNAPSHOT }
    },
  })

  const first = await service.read()
  const second = await service.read()
  assert.equal(calls, 1)
  assert.equal(first.failure, null)
  assert.equal(second.snapshot.totalCredits, 60000)

  await service.read({ force: true })
  assert.equal(calls, 2)
})

test('shares one in-flight fetch between concurrent readers', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const service = createPlanService({
    ttlMs: () => 60_000,
    fetchPlan: async () => {
      calls += 1
      await gate
      return { ...SNAPSHOT }
    },
  })

  const a = service.read()
  const b = service.read()
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(calls, 1)
  assert.equal(first.snapshot.planName, '基础版')
  assert.equal(second.snapshot.planName, '基础版')
})

test('keeps the last good snapshot and reports the failure when a refresh fails', async () => {
  let mode = 'ok'
  const service = createPlanService({
    ttlMs: () => 0,
    fetchPlan: async () => {
      if (mode === 'fail') throw Object.assign(new Error('登录态失效'), { code: 'SESSION_REQUIRED', hint: '重新登录' })
      return { ...SNAPSHOT }
    },
  })

  await service.read()
  mode = 'fail'
  const stale = await service.read()
  assert.notEqual(stale.failure, null)
  assert.equal(stale.failure.code, 'SESSION_REQUIRED')
  assert.equal(stale.failure.hint, '重新登录')
  assert.equal(stale.snapshot.remainingCredits, 45000)
  assert.equal(service.stats().failures, 1)

  // A later success clears the counter: it tracks consecutive, not lifetime, failures.
  mode = 'ok'
  await service.read()
  assert.equal(service.stats().failures, 0)
})

test('returns a null snapshot when the very first read fails', async () => {
  const service = createPlanService({
    ttlMs: () => 0,
    fetchPlan: async () => {
      throw new Error('boom')
    },
  })
  const result = await service.read()
  assert.equal(result.snapshot, null)
  assert.equal(result.failure.message, 'boom')
})

test('toFailure keeps code/hint/status and never leaks the stack', () => {
  const failure = toFailure(Object.assign(new Error('x'), { code: 'C', hint: 'h', status: 401 }))
  assert.deepEqual(failure, { message: 'x', code: 'C', hint: 'h', status: 401 })
  assert.equal(toFailure('plain').message, 'plain')
})
