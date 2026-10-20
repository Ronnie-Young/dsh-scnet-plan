import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, name } from '../index.js'

/** Build a minimal Cordis-like ctx capturing every registration `apply` makes. */
function fakeCtx({ credentialsStore = {} } = {}) {
  const registrations = { routes: [], tools: [], settingsConfigured: false, effects: 0 }
  const services = {
    credentials: {
      async resolve(ref) {
        return credentialsStore[ref] === undefined ? undefined : { value: credentialsStore[ref], source: 'file' }
      },
      async describe(ref) {
        return { configured: credentialsStore[ref] !== undefined, writable: true, source: 'file' }
      },
      async set(ref, value) {
        credentialsStore[ref] = value
      },
      async unset(ref) {
        delete credentialsStore[ref]
      },
    },
    webServer: {
      register(route) {
        registrations.routes.push(route)
        return () => {
          registrations.routes = registrations.routes.filter((item) => item !== route)
        }
      },
    },
    tools: {
      register(definition) {
        registrations.tools.push(definition)
        return () => {}
      },
    },
    settings: {
      configure() {
        registrations.settingsConfigured = true
        return () => {}
      },
    },
  }
  const ctx = {
    ...services,
    fiber: { state: 2 },
    logger: { warn() {}, info() {}, error() {} },
    get: (serviceName) => services[serviceName],
    effect(fn) {
      registrations.effects += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, callback) {
      if (names.every((serviceName) => services[serviceName] !== undefined)) callback(ctx)
    },
  }
  return { ctx, registrations, credentialsStore, services }
}

/** Drive a registered route with a fake req/res and parse the JSON answer. */
async function callRoute(route, { method = 'GET', url = '/', body } = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    once(event, handler) {
      listeners[event] = handler
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  let status = 0
  let headers = null
  let payload = ''
  const res = {
    writableEnded: false,
    once(event, handler) {
      if (event === 'close') this._onClose = handler
    },
    writeHead(code, head) {
      status = code
      headers = head
    },
    end(text) {
      payload = text
      this.writableEnded = true
    },
  }
  await route.handler(req, res)
  return { status, headers, body: JSON.parse(payload) }
}

/** Answer the SCNet endpoints the plugin reads. */
function stubFetch({ consoleStatus = 200 } = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.includes('/acx/llm/api/package/overview')) {
      return new Response(
        JSON.stringify({
          code: '0',
          data: [
            {
              code: 'TP-Basic-001',
              name: '基础版',
              models: 'DeepSeek-V4.1-Flash',
              request: [{ time: 1, unit: 'month', limit: 60000 }],
            },
          ],
        }),
        { status: 200 },
      )
    }
    if (text.includes('/acx/charge/account/currentuser/tokenplan/list')) {
      if (consoleStatus === 401) return new Response(JSON.stringify({ code: '401', msg: '用户未登录!' }), { status: 200 })
      return new Response(
        JSON.stringify({
          code: '0',
          data: [{ resourceId: 'TP-Basic-001', planCredits: 60000, usedCredits: 15000, percent: 25, maxExpireTime: '2026-11-01 23:59:59' }],
        }),
        { status: 200 },
      )
    }
    if (text.includes('/api/llm/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'DeepSeek-V4.1-Flash' }] }), { status: 200 })
    return new Response('not found', { status: 404 })
  }
  return () => {
    globalThis.fetch = original
  }
}

test('apply registers the snapshot route, the tool and the settings policy', () => {
  const { ctx, registrations } = fakeCtx()
  const config = Config({})
  apply(ctx, config)

  assert.equal(name, 'scnet-plan')
  assert.equal(registrations.routes.length, 2)
  assert.equal(registrations.routes[0].path, '/scnet-plan/snapshot')
  assert.equal(registrations.routes[0].kind, 'exact')
  assert.equal(registrations.routes[1].path, '/scnet-plan/snapshot/login')
  assert.equal(registrations.tools.length, 1)
  assert.equal(registrations.tools[0].name, 'get_scnet_plan')
  assert.equal(registrations.settingsConfigured, true)
})

test('GET returns the console reading when the cookie credential is present', async () => {
  const restore = stubFetch()
  const { ctx, registrations } = fakeCtx({
    credentialsStore: { SCNET_API_KEY: 'sk-tp-test', SCNET_CONSOLE_COOKIE: 'a=b' },
  })
  try {
    apply(ctx, Config({}))
    const answer = await callRoute(registrations.routes[0], { method: 'GET', url: '/scnet-plan/snapshot' })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.snapshot.planName, '基础版')
    assert.equal(answer.body.snapshot.remainingCredits, 45000)
    assert.equal(answer.body.info.consoleCookieConfigured, true)
    // The credential value itself must never be echoed.
    assert.equal(JSON.stringify(answer.body).includes('a=b'), false)
  } finally {
    restore()
  }
})

test('POST stores the pasted console cookie and clears it on an empty value', async () => {
  const restore = stubFetch()
  const { ctx, registrations, credentialsStore } = fakeCtx({ credentialsStore: { SCNET_API_KEY: 'sk-tp-test' } })
  try {
    apply(ctx, Config({}))
    const saved = await callRoute(registrations.routes[0], {
      method: 'POST',
      url: '/scnet-plan/snapshot',
      body: { cookie: 'Cookie: session=abc; uid=42' },
    })
    assert.equal(credentialsStore.SCNET_CONSOLE_COOKIE, 'session=abc; uid=42')
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.snapshot.source, 'console')

    const cleared = await callRoute(registrations.routes[0], {
      method: 'POST',
      url: '/scnet-plan/snapshot',
      body: { cookie: '' },
    })
    assert.equal(credentialsStore.SCNET_CONSOLE_COOKIE, undefined)
    // No cookie left → the public catalog keeps the panel useful.
    assert.equal(cleared.body.ok, true)
    assert.equal(cleared.body.snapshot.needsCookie, true)
  } finally {
    restore()
  }
})

test('GET stays ok=false with a SESSION_REQUIRED error when the stored cookie is stale', async () => {
  const restore = stubFetch({ consoleStatus: 401 })
  const { ctx, registrations } = fakeCtx({
    credentialsStore: { SCNET_API_KEY: 'sk-tp-test', SCNET_CONSOLE_COOKIE: 'stale=1' },
  })
  try {
    apply(ctx, Config({}))
    const answer = await callRoute(registrations.routes[0], { method: 'GET', url: '/scnet-plan/snapshot?refresh=1' })
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.error.code, 'SESSION_REQUIRED')
  } finally {
    restore()
  }
})

test('the tool reports Credits, staleness and the cookie requirement', async () => {
  const restore = stubFetch()
  const { ctx, registrations } = fakeCtx({ credentialsStore: { SCNET_API_KEY: 'sk-tp-test' } })
  try {
    apply(ctx, Config({}))
    const tool = registrations.tools[0]
    const value = await tool.execute({}, { signal: new AbortController().signal })
    assert.equal(value.ok, true)
    assert.equal(value.needsCookie, true)
    assert.equal(value.remainingCredits, null)
    assert.equal(value.catalog[0].name, '基础版')

    const rendered = tool.output.render({}, value)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /Credits: unavailable/)
  } finally {
    restore()
  }
})

test('rejects an invalid credential reference at load time', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, Config({ apiKeyEnv: 'not a ref' })), /not a credential reference/)
})

test('GET /login reports the sign-in state without touching the network', async () => {
  const { ctx, registrations } = fakeCtx({ credentialsStore: { SCNET_API_KEY: 'sk-tp-test' } })
  apply(ctx, Config({}))
  const loginRoute = registrations.routes.find((route) => route.path.endsWith('/login'))
  assert.ok(loginRoute, 'login route registered')
  const answer = await callRoute(loginRoute, { method: 'GET', url: '/scnet-plan/snapshot/login' })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.login.state, 'idle')
  assert.equal(answer.body.info.loginEnabled, true)
})

test('POST /login rejects empty credentials without contacting SCNet', async () => {
  const { ctx, registrations } = fakeCtx({ credentialsStore: { SCNET_API_KEY: 'sk-tp-test' } })
  apply(ctx, Config({}))
  const loginRoute = registrations.routes.find((route) => route.path.endsWith('/login'))
  const answer = await callRoute(loginRoute, {
    method: 'POST',
    url: '/scnet-plan/snapshot/login',
    body: { username: '', password: '' },
  })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.login.state, 'failed')
  assert.match(answer.body.login.message, /手机号和短信验证码/)
})
