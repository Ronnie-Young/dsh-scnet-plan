import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchPlan, describeCredential, resolveCredential, consoleOrigin, PlanSourceError } from '../lib/scnet-api.js'

const CATALOG = {
  code: '0',
  msg: 'success',
  data: [
    {
      code: 'TP-Basic-001',
      name: '基础版',
      description: '入门优选',
      models: 'DeepSeek-V4.1-Flash,Kimi-K3',
      request: [{ time: 1, unit: 'month', limit: 60000 }],
      regularPrice: 50,
      contractPrice: 30,
    },
    {
      code: 'TP-Standard-001',
      name: '标准版',
      description: '日常使用',
      models: 'DeepSeek-V4.1-Flash',
      request: [{ time: 1, unit: 'month', limit: 240000 }],
      regularPrice: 185,
      contractPrice: 130,
    },
  ],
}

const MODELS = { object: 'list', data: [{ id: 'DeepSeek-V4.1-Flash' }, { id: 'Kimi-K3' }] }

const SUBSCRIPTION = {
  code: '0',
  msg: 'success',
  data: [
    {
      resourceId: 'TP-Basic-001',
      resourceAccountId: '2111991206058696705',
      planCredits: 60000,
      usedCredits: 15000,
      percent: 25,
      minValidTime: '2026-10-01 00:00:00',
      maxExpireTime: '2026-11-01 23:59:59',
    },
  ],
}

/** Fake ctx exposing only the credential seam used by scnet-api. */
function fakeCtx(store) {
  return {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async resolve(ref) {
          return store[ref] === undefined ? undefined : { value: store[ref], source: 'file' }
        },
        async describe(ref) {
          return { configured: store[ref] !== undefined, writable: true, source: 'file' }
        },
      }
    },
  }
}

const CONFIG = {
  apiKeyEnv: 'SCNET_API_KEY',
  consoleCookieEnv: 'SCNET_CONSOLE_COOKIE',
  baseUrl: 'https://api.scnet.cn',
  consoleBaseUrl: 'https://www.scnet.cn',
  apiBasePath: '/api/llm/v1',
  includeModels: true,
}

/** Install a fetch stub answering the three endpoints; records request headers. */
function stubFetch({ consoleStatus = 200, consoleHttpStatus = 200, requests = [] } = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers ?? {} })
    const text = String(url)
    if (text.includes('/acx/llm/api/package/overview')) {
      return new Response(JSON.stringify(CATALOG), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (text.includes('/acx/charge/account/currentuser/tokenplan/list')) {
      if (consoleStatus === 401) {
        return new Response(JSON.stringify({ code: '401', msg: '用户未登录!' }), { status: consoleHttpStatus })
      }
      return new Response(JSON.stringify(SUBSCRIPTION), { status: 200 })
    }
    if (text.includes('/api/llm/v1/models')) {
      return new Response(JSON.stringify(MODELS), { status: 200 })
    }
    if (text.includes('/user/users/cluster-user-detail')) {
      return new Response(JSON.stringify({ code: '0', data: { accountId: '2099749961149194241' } }), { status: 200 })
    }
    if (text.includes('/charge/consume-query/resource-usage')) {
      return new Response(
        JSON.stringify({
          code: '0',
          data: [
            { date: '2026-10-19', chargeItem: 'TOKENPLAN', sumUsage: '100.5', inputTokens: 1000, cachedTokens: 2000, outputTokens: 300 },
            { date: '2026-10-20', chargeItem: 'TOKENPLAN', sumUsage: '200', inputTokens: 2000, cachedTokens: 4000, outputTokens: 600 },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response('not found', { status: 404 })
  }
  return () => {
    globalThis.fetch = original
  }
}

test('reads the real subscription with the console cookie and joins the catalog', async () => {
  const requests = []
  const restore = stubFetch({ requests })
  const ctx = fakeCtx({ SCNET_API_KEY: 'sk-tp-test', SCNET_CONSOLE_COOKIE: 'a=b; c=d' })
  try {
    const snapshot = await fetchPlan({ ctx, config: CONFIG, signal: new AbortController().signal })
    assert.equal(snapshot.source, 'console')
    assert.equal(snapshot.needsCookie, false)
    assert.equal(snapshot.planName, '基础版')
    assert.equal(snapshot.totalCredits, 60000)
    assert.equal(snapshot.usedCredits, 15000)
    assert.equal(snapshot.remainingCredits, 45000)
    assert.equal(snapshot.usedPercent, 25)
    assert.equal(snapshot.status, 'active')
    assert.equal(snapshot.models.length, 2)
    assert.equal(snapshot.usage.totals.credits, 300.5)
    assert.equal(snapshot.usage.totals.inputTokens, 3000)
    assert.equal(snapshot.usage.totals.cachedTokens, 6000)
    assert.equal(snapshot.usage.totals.outputTokens, 900)
    assert.equal(snapshot.usage.daily.length, 2)
    assert.equal(snapshot.usage.peak.date, '2026-10-20')
    assert.ok(snapshot.remainingDays > 0)

    const subscriptionRequest = requests.find((r) => r.url.includes('tokenplan/list'))
    assert.equal(subscriptionRequest.headers.Cookie, 'a=b; c=d')
    assert.equal(subscriptionRequest.headers.version, '2.9.2')

    const modelsRequest = requests.find((r) => r.url.includes('/api/llm/v1/models'))
    assert.equal(modelsRequest.headers.Authorization, 'Bearer sk-tp-test')
  } finally {
    restore()
  }
})

test('falls back to the public catalog when no cookie is configured', async () => {
  const restore = stubFetch()
  const ctx = fakeCtx({ SCNET_API_KEY: 'sk-tp-test' })
  try {
    const snapshot = await fetchPlan({ ctx, config: CONFIG, signal: new AbortController().signal })
    assert.equal(snapshot.source, 'catalog')
    assert.equal(snapshot.needsCookie, true)
    assert.equal(snapshot.totalCredits, null)
    assert.equal(snapshot.remainingCredits, null)
    assert.equal(snapshot.catalog.length, 2)
    assert.equal(snapshot.catalog[1].creditsPerMonth, 240000)
  } finally {
    restore()
  }
})

test('maps alternate console field names, nested envelopes and fraction percentages', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.includes('/acx/llm/api/package/overview')) return new Response(JSON.stringify(CATALOG), { status: 200 })
    if (text.includes('/acx/charge/account/currentuser/tokenplan/list')) {
      return new Response(
        JSON.stringify({
          code: '0',
          msg: 'success',
          data: {
            data: [
              {
                resourceId: 'TP-Standard-001',
                totalAmount: 240000,
                usedAmount: 60000,
                percent: 0.25,
                minValidTime: '2026-10-01 00:00:00',
                maxExpireTime: '2099-01-01 00:00:00',
                resetTime: '2026-11-01 00:00:00',
              },
            ],
          },
        }),
        { status: 200 },
      )
    }
    if (text.includes('/api/llm/v1/models')) return new Response(JSON.stringify(MODELS), { status: 200 })
    return new Response('not found', { status: 404 })
  }
  const ctx = fakeCtx({ SCNET_API_KEY: 'sk-tp-test', SCNET_CONSOLE_COOKIE: 'a=b' })
  try {
    const snapshot = await fetchPlan({ ctx, config: CONFIG, signal: new AbortController().signal })
    assert.equal(snapshot.planName, '标准版')
    assert.equal(snapshot.totalCredits, 240000)
    assert.equal(snapshot.usedCredits, 60000)
    assert.equal(snapshot.remainingCredits, 180000)
    assert.equal(snapshot.usedPercent, 25)
    assert.equal(snapshot.resetAt, '2026-11-01 00:00:00')
    assert.equal(snapshot.subscriptions.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('a 401 from the console surfaces SESSION_REQUIRED with a hint', async () => {
  const restore = stubFetch({ consoleStatus: 401 })
  const ctx = fakeCtx({ SCNET_API_KEY: 'sk-tp-test', SCNET_CONSOLE_COOKIE: 'expired=1' })
  try {
    await assert.rejects(
      () => fetchPlan({ ctx, config: CONFIG, signal: new AbortController().signal }),
      (error) => {
        assert.ok(error instanceof PlanSourceError)
        assert.equal(error.code, 'SESSION_REQUIRED')
        assert.match(error.hint, /Cookie/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('an HTTP 401 from the console also surfaces SESSION_REQUIRED', async () => {
  const restore = stubFetch({ consoleStatus: 401, consoleHttpStatus: 401 })
  const ctx = fakeCtx({ SCNET_API_KEY: 'sk-tp-test', SCNET_CONSOLE_COOKIE: 'expired=1' })
  try {
    await assert.rejects(
      () => fetchPlan({ ctx, config: CONFIG, signal: new AbortController().signal }),
      (error) => {
        assert.ok(error instanceof PlanSourceError)
        assert.equal(error.code, 'SESSION_REQUIRED')
        assert.equal(error.status, 401)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('describeCredential reports presence without the value', async () => {
  const ctx = fakeCtx({ SCNET_API_KEY: 'sk-tp-test' })
  assert.deepEqual(await describeCredential(ctx, 'SCNET_API_KEY'), { configured: true, source: 'file' })
  assert.deepEqual(await describeCredential(ctx, 'SCNET_CONSOLE_COOKIE'), { configured: false })
  assert.equal(await resolveCredential(ctx, 'SCNET_API_KEY'), 'sk-tp-test')
})

test('consoleOrigin sends /acx calls to www.scnet.cn even when the gateway base is api.scnet.cn', () => {
  assert.equal(consoleOrigin({ baseUrl: 'https://api.scnet.cn' }), 'https://www.scnet.cn')
  assert.equal(consoleOrigin({ baseUrl: 'https://www.scnet.cn' }), 'https://www.scnet.cn')
  assert.equal(
    consoleOrigin({ baseUrl: 'https://api.scnet.cn', consoleBaseUrl: 'https://scnet.example.com/' }),
    'https://scnet.example.com',
  )
  assert.equal(consoleOrigin({ baseUrl: 'not a url' }), 'https://www.scnet.cn')
})
