// 渲染冒烟：用最小 React 壳执行浏览器端组件，捕获“删了函数但仍在调用”这类白屏。
// 这不是视觉测试，而是保证每个组件至少能完整跑一遍渲染路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/** A snapshot shaped like the host's rich response (no secrets). */
const SNAPSHOT = {
  planName: '基础版',
  planCode: 'TP-Basic-001',
  status: 'active',
  totalCredits: 60000,
  usedCredits: 46186.96,
  remainingCredits: 13556.87,
  usedPercent: 77,
  remainingDays: 31,
  scopeDays: 31,
  periodStart: '2026-10-19 09:21:29',
  periodEnd: '2026-11-19 23:59:59',
  resetAt: '2026-11-19 23:59:59',
  expiresAt: '2026-11-19 23:59:59',
  usage: {
    totals: { credits: 46186.96, inputTokens: 8754998, cachedTokens: 205231328, outputTokens: 844137 },
    daily: [
      { date: '2026-10-19', credits: 15839.33, inputTokens: 3047974, cachedTokens: 30931040, outputTokens: 192620 },
      { date: '2026-10-20', credits: 30347.62, inputTokens: 5227825, cachedTokens: 169027712, outputTokens: 643944 },
    ],
    days: 2,
    peak: { date: '2026-10-20', credits: 30347.62 },
    dailyAverage: 23093.48,
    maxDayCredits: 30347.62,
  },
  models: [
    { id: 'a', name: 'Kimi-K3' },
    { id: 'b', name: 'GLM-5.3' },
  ],
  catalog: [
    { code: 'TP-Basic-001', name: '基础版', creditsPerMonth: 60000 },
    { code: 'TP-Standard-001', name: '标准版', creditsPerMonth: 240000 },
  ],
  source: 'console',
  fetchedAt: '2026-10-20T05:42:00.000Z',
  needsCookie: false,
}

/** Real React API surface used by the plugin, with inert hooks. */
function createReact() {
  const state = []
  const refs = []
  let cursor = 0
  return {
    reset() {
      cursor = 0
    },
    api: {
      createElement(type, props, ...children) {
        return { type, props: props || {}, children: children.flat(Infinity) }
      },
      Fragment: 'fragment',
      useState(init) {
        const index = cursor++
        if (!(index in state)) state[index] = typeof init === 'function' ? init() : init
        return [state[index], () => {}]
      },
      useEffect() {
        cursor++
      },
      useRef(init) {
        const index = cursor++
        if (!(index in refs)) refs[index] = { current: init }
        return refs[index]
      },
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    },
  }
}

/** Load the client bundle with debug exports and a stub Cordis context. */
function loadClient() {
  const errors = []
  const react = createReact()
  const registered = []
  const sandbox = {
    console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, snapshot: SNAPSHOT }) }),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ style: { remove() {} }, setAttribute: () => {}, appendChild: () => {}, remove: () => {}, textContent: '', id: '' }),
      getElementById: () => null,
    },
    AbortController,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  let loaded = null
  sandbox.__ModuleLoader__ = { load: (value) => { loaded = value } }
  vm.createContext(sandbox)
  const instrumented = source.replace(
    'return { inject, apply }',
    'return { inject, apply, __debug: { UsageDetails, PlanPanel, SettingsSection, Catalog, CookieCallout, LoginForm, UsageChip, TurnCredits, PanelIcon, annulusPath, circlePath, isScnetSelection, isAuthError, store } }',
  )
  vm.runInContext(instrumented, sandbox, { filename: 'client.js' })
  const exports = loaded.factory((name) => (name === 'react' ? react.api : {}))
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanup()
    },
    locale: {
      register() {},
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
      getLocale: () => ({ id: 'zh' }),
      subscribe: () => () => {},
    },
    slots: {
      inject(name, fn) {
        fn()
      },
      register(definition, component) {
        registered.push({ definition, component })
        return () => {}
      },
    },
    get: () => undefined,
  }
  exports.apply(ctx)
  return { debug: exports.__debug, registered, errors, state: exports.__debug.store }
}

/** Render a component once and flatten its host tree. */
/** Collect component names from a rendered element tree (children are not executed). */
function componentNames(node, acc = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) componentNames(item, acc)
    return acc
  }
  if (node === null || typeof node !== 'object') return acc
  if (typeof node.type === 'function' && node.type.name) acc.add(node.type.name)
  if (Array.isArray(node.children)) componentNames(node.children, acc)
  return acc
}

function render(component, props) {
  const tree = component(props)
  const nodes = []
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object') return
    nodes.push(node)
    if (node.children) walk(node.children)
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(tree)
  return { nodes, texts }
}

const load = loadClient()

test('client bundle registers all four slots and applies cleanly', () => {
  const names = load.registered.map((item) => item.definition.name)
  assert.deepEqual(names, ['sidebar.panellist', 'main', 'settings.section', 'conversation.chat.turnTail', 'conversation.composer.dock'])
  assert.deepEqual(load.errors, [])
})

test('rich plan panel and usage card render without a missing helper', () => {
  load.state.set({ status: 'ready', snapshot: SNAPSHOT, error: null, info: { warnBelowPercent: 20, refreshIntervalSec: 300 }, at: Date.now() })
  const usage = render(load.debug.UsageDetails, { snapshot: SNAPSHOT, state: { info: { warnBelowPercent: 20 } } })
  assert.ok(usage.nodes.length > 40)
  // 13,556.87 credits are shown in the Chinese compact form "1.36 万".
  assert.ok(usage.texts.some((text) => text.includes('万')), 'expected a formatted credit number')
  assert.ok(usage.texts.includes('remaining'), 'expected the remaining label')

  // The whole panel must render too: this is what used to throw and blank the page.
  const panel = render(load.registered.find((item) => item.definition.name === 'main').component, undefined)
  assert.ok(panel.nodes.length > 10)
})

test('panel renders the no-usage, guest and error branches', () => {
  const panel = load.registered.find((item) => item.definition.name === 'main').component
  const noUsage = { ...SNAPSHOT, usage: null, usageError: 'daily usage unavailable' }
  render(load.debug.UsageDetails, { snapshot: noUsage, state: { info: {} } })

  const guest = { ...SNAPSHOT, needsCookie: true, planName: null, totalCredits: null, usedCredits: null, remainingCredits: null, usage: null }
  load.state.set({ status: 'ready', snapshot: guest, error: null, info: { loginEnabled: true, warnBelowPercent: 20 }, at: Date.now() })
  assert.ok(render(panel).nodes.length > 5)

  load.state.set({ status: 'error', snapshot: null, error: { code: 'SESSION_REQUIRED', message: '登录态失效' }, info: {}, at: Date.now() })
  assert.ok(render(panel).nodes.length > 5)
})

test('login form and the remaining components render', () => {
  const login = render(load.debug.LoginForm)
  assert.ok(login.nodes.length > 5)
  assert.ok(render(load.debug.CookieCallout).nodes.length > 0)
  assert.ok(render(load.debug.SettingsSection).nodes.length > 5)
  assert.ok(render(load.debug.Catalog, { catalog: SNAPSHOT.catalog, currentCode: SNAPSHOT.planCode }).nodes.length > 3)
  assert.ok(render(load.debug.UsageChip).nodes.length > 0)
  assert.ok(render(load.debug.PanelIcon).nodes.length > 0)
  assert.deepEqual(load.errors, [])
})

test('annulus geometry keeps both ring edges on true circles', () => {
  const { annulusPath, circlePath } = load.debug
  const full = annulusPath(52, 52, 52, 40, 0, 360)
  assert.ok(full.includes(circlePath(52, 52, 52)), 'outer edge is a full circle')
  assert.ok(full.includes(circlePath(52, 52, 40)), 'inner edge is a full circle')

  const quarter = annulusPath(52, 52, 52, 40, 0, 90)
  assert.ok(quarter.startsWith('M 52 0'), 'sector starts at the top of the outer circle')
  const [, x, y] = quarter.match(/A 52 52 0 0 1 ([\d.]+) ([\d.]+)/) ?? []
  assert.ok(Math.abs(Number(x) - 104) < 0.01 && Math.abs(Number(y) - 52) < 0.01, '90° lands on the outer circle')

  assert.equal(annulusPath(52, 52, 52, 40, 0, 0), '')
  const nearly = annulusPath(52, 52, 52, 40, 0, 270)
  assert.ok(nearly.includes('A 52 52 0 1 1'), 'large sweep uses the long arc flag')
  assert.ok(nearly.includes('A 40 40 0 1 0'), 'inner edge is drawn back along the inner circle')
})


test('UsageDetails renders the ring socket with the new geometry', () => {
  const nodes = render(load.debug.UsageDetails, {
    snapshot: { ...SNAPSHOT, usedPercent: 4.49 },
    state: { snapshot: { ...SNAPSHOT, usedPercent: 4.49 }, info: { warnBelowPercent: 20 }, error: null },
    t: (key) => key,
  })
  const html = JSON.stringify(nodes)
  assert.ok(html.includes('scp-ring'), 'renders the ring container')
  assert.ok(html.includes('scp-ring-svg'), 'renders the SVG ring')
  assert.ok(html.includes('A 52 52'), 'outer edge is a circle arc')
  assert.deepEqual(load.errors, [])
})

test('isScnetSelection only accepts SCNet providers or catalog models', () => {
  const { isScnetSelection } = load.debug
  assert.equal(isScnetSelection({ provider: 'scnet', model: 'whatever' }, []), true)
  assert.equal(isScnetSelection({ provider: 'deepseek-account', model: 'deepseek-flash' }, [{ id: 'DeepSeek-V4.1-Flash-1017' }]), false)
  assert.equal(isScnetSelection({ provider: 'other', model: 'DeepSeek-V4.1-Flash-1017' }, [{ id: 'DeepSeek-V4.1-Flash-1017' }]), true)
  assert.equal(isScnetSelection(null, [{ id: 'x' }]), false)
  assert.equal(isScnetSelection({ provider: null, model: 'Scnet-Model' }, ['Scnet-Model']), true)
})

test('auth errors are recognised so the panel can offer a login form', () => {
  const { isAuthError } = load.debug
  assert.equal(isAuthError({ code: 'SESSION_REQUIRED' }), true)
  assert.equal(isAuthError({ code: 'UNAUTHORIZED' }), true)
  assert.equal(isAuthError({ code: 'AUTH' }), true)
  assert.equal(isAuthError({ code: 'NETWORK' }), false)
  assert.equal(isAuthError(null), false)
})

test('panel offers an inline login form when the console session expired', () => {
  const { store, PlanPanel } = load.debug
  const before = store.get()
  try {
    store.set({
      status: 'error',
      snapshot: null,
      error: { code: 'SESSION_REQUIRED', message: 'SCNet 控制台登录态已失效（HTTP 401）' },
      info: { loginEnabled: true, warnBelowPercent: 20 },
      at: Date.now(),
    })
    const out = render(PlanPanel, {})
    const html = JSON.stringify(out)
    const hasLoginForm = out.nodes.some((node) => typeof node.type === 'function' && node.type.name === 'LoginForm')
    assert.ok(html.includes('scp-card-error'), 'shows the failure reason')
    assert.ok(hasLoginForm, 'renders the login form inline')
    assert.ok(html.includes('SESSION_REQUIRED'), 'keeps the diagnostic code')

    store.set({
      status: 'ok',
      snapshot: { needsCookie: true, catalog: [], planCode: null, models: [] },
      error: null,
      info: { loginEnabled: true, warnBelowPercent: 20 },
      at: Date.now(),
    })
    const needsCookieOut = render(PlanPanel, {})
    const needsCookieLogin = needsCookieOut.nodes.some((node) => typeof node.type === 'function' && node.type.name === 'LoginForm')
    assert.ok(needsCookieLogin, 'login is offered when no console session exists either')
  } finally {
    store.set(before)
  }
})
