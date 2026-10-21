// dsh-scnet-plan — BROWSER half（浏览器端插件）。
//
// 与 Node half 的分工：所有需要 SCNET_API_KEY / 控制台 Cookie 的请求都由 Host 侧的
// `GET|POST /scnet-plan/snapshot` 完成，密钥与 Cookie 永远不进浏览器；这里只负责渲染与轮询。
//
// 注册的 UI：
//   1. `sidebar.panellist` + `main`（keyed `scnet-plan`）：侧栏图标 + 中央套餐面板；
//   2. `settings.section`：设置 → SCNet 套餐，填写控制台 Cookie、看刷新状态；
//   3. `conversation.composer.dock`：输入框下方的紧凑额度徽标。
//
// 加载机制：package.json 声明 `dsh.client.platform: 'web'` 与 `exports['./client']`；
// 浏览器 loader 按 **npm 包名** 期待注册，所以下面 `id` 必须等于包名。
window.__ModuleLoader__.load({
  id: 'dsh-scnet-plan',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'scnet-plan'
    const ROUTE = '/scnet-plan/snapshot'
    const PANEL_KEY = 'scnet-plan'
    const CONSOLE_URL = 'https://www.scnet.cn/ui/console/#/llm/token-plan'
    const BILL_URL = 'https://www.scnet.cn/ui/console/#/fee/detailed-bill'

    const zh = {
      panelLabel: 'SCNet 套餐',
      title: 'SCNet 套餐',
      subtitle: '超算互联网 Token Plan · 月度 Credits 额度',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '读取套餐信息…',
      unavailable: '暂时读不到套餐信息',
      retry: '重试',
      remaining: '剩余额度',
      used: '已用',
      total: '月度额度',
      planName: '当前套餐',
      resetAt: '重置',
      expiresAt: '到期',
      periodStart: '生效',
      models: '可用模型',
      source: '数据来源',
      updatedAt: '更新于',
      staleWarning: '显示的是上一次成功读取的数据',
      autoRefresh: '自动刷新',
      everySeconds: '每 {n} 秒',
      off: '关闭',
      percentUsed: '已用 {n}%',
      percentLeft: '剩余 {n}%',
      remainingDays: '剩余天数',
      daysUnit: '天',
      usageTitle: '用量消耗',
      inputTokens: '输入 Tokens',
      cachedTokens: '缓存命中 Tokens',
      outputTokens: '输出 Tokens',
      dailyAverage: '日均消耗',
      peakDay: '峰值',
      todayUsage: '今日消耗',
      activeDays: '{n} 天有消耗',
      heatmap: '每日 Credits 消耗',
      viewBill: '查看明细账单 ↗',
      untilToday: '数据截至今日',
      heatmapHint: '仅展示套餐周期内数据',
      less: '少',
      more: '多',
      noUsage: '暂无每日用量数据',
      usageUnavailable: '每日用量暂时读取失败，额度数字不受影响',
      credits: 'Credits',
      catalog: '套餐目录',
      more: '套餐与模型',
      catalogHint: '公开套餐档位（每月 Credits）。购买或续费请前往 SCNet 控制台。',
      current: '当前',
      perMonth: '/月',
      needsCookieTitle: '需要连接 SCNet 控制台才能读取余量',
      needsCookieDesc:
        'SCNet 没有公开的用量 API，额度消耗只存在于登录后的控制台。点下面的按钮在弹出的窗口里登录一次，会话会自动保存，之后就能持续监控。',
      needsCookieSteps:
        '登录窗打开的是 SCNet 官方登录页，支持它提供的所有登录方式（账号密码 / 短信 / 扫码）。登录成功后窗口会自动关闭，不需要开发者工具，也不需要复制 Cookie。',
      openConsole: '打开 SCNet 控制台 ↗',
      loginTitle: '连接 SCNet 控制台',
      loginDesc: '额度只能通过登录态读取。用 SCNet 手机验证码或账号密码登录一次，插件只保存会话 Cookie。',
      modeSms: '短信验证码',
      modePassword: '账号密码',
      loginPhone: '手机号',
      loginPhonePlaceholder: '11 位手机号',
      loginSmsCode: '短信验证码',
      loginSmsCodePlaceholder: '6 位验证码',
      sendCode: '获取验证码',
      resendIn: '{n}s 后重发',
      codeSent: '验证码已发送',
      loginAccount: '账号',
      loginAccountPlaceholder: '手机号 / 用户名',
      loginPassword: '密码',
      loginCaptcha: '图形验证码',
      loginCaptchaPlaceholder: '输入图中验证码',
      loginCaptchaPrompt: '请输入图形验证码后重试',
      loginButton: '登录并保存会话',
      loggingIn: '登录中…',
      refreshCaptcha: '换一张',
      needCaptcha: '需要图形验证码？',
      loginSmsHint: '未注册的手机号验证通过后会按官网规则自动注册。',
      loginPrivacy: '手机号、验证码或密码只用于这一次登录请求，不会写入配置、日志或模型上下文；登录成功后只保存会话 Cookie。',
      loginHint: '登录后若想确认账号状态，可打开 SCNet 控制台。',
      loginSuccess: '登录成功，会话已保存',
      loginFailed: '登录失败',
      statusNeedsCookie: '待连接',
      statusStale: '数据过期',
      statusError: '读取失败',
      statusActive: '有效',
      statusExpired: '已过期',
      statusExhausted: '已用完',
      statusUnknown: '状态未知',
      settingsTitle: 'SCNet 套餐监控',
      settingsDesc:
        '在侧栏「SCNet 套餐」面板与输入框下方徽标显示 Token Plan 的月度 Credits 余量、消耗与重置时间。所有请求都在 Host 侧完成，API Key 与 Cookie 都不会进入浏览器。',
      credential: 'API Key 凭据',
      credentialConfigured: '已配置',
      credentialMissing: '未配置',
      consoleCookie: '控制台 Cookie',
      consoleCookieSet: '已保存',
      consoleCookieUnset: '未保存',
      consoleCookieHint:
        '额度余量只能通过登录态读取。浏览器登录 scnet.cn 后，从开发者工具任意 /acx 请求的请求头里复制完整 Cookie，粘贴到下面保存。Cookie 会写入 dsh 凭据库，不会回显，也不会发给模型。',
      cookiePlaceholder: 'name1=value1; name2=value2 …',
      saveCookie: '保存 Cookie',
      saving: '保存中…',
      clearCookie: '清除 Cookie',
      cookieSaved: 'Cookie 已保存，正在读取套餐…',
      cookieCleared: 'Cookie 已清除',
      refreshInterval: '自动刷新',
      baseUrl: 'API 地址',
      lastSuccess: '上次成功',
      never: '从未',
      failureCount: '连续失败',
      refreshNow: '立即刷新',
      chipTitle: 'SCNet 套餐剩余额度（点击查看详情）',
      chipNoData: 'SCNet 套餐未连接',
      topicUsage: '本话题',
      turnUsage: '本轮',
      creditUnit: 'Cr',
      chipCreditsHint: ' Credits 按 token 用量与 SCNet 模型单价估算',
      hintMissingKey: '没有解析到凭据。请确认 SCNET_API_KEY 已写入 dsh 凭据或启动环境。',
      hintSession: '控制台登录态失效了。重新登录 www.scnet.cn，复制新的 Cookie 保存到「设置 → SCNet 套餐」。',
      hintNetwork: '网络或服务端异常，稍后会自动重试。',
      hintGeneric: '读取失败，可点「刷新」重试。',
    }

    const en = {
      panelLabel: 'SCNet plan',
      title: 'SCNet plan',
      subtitle: 'SCNet Token Plan · monthly Credits quota',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Reading plan…',
      unavailable: 'Plan information is unavailable',
      retry: 'Retry',
      remaining: 'Remaining',
      used: 'Used',
      total: 'Monthly quota',
      planName: 'Plan',
      resetAt: 'Resets',
      expiresAt: 'Expires',
      periodStart: 'From',
      models: 'Models',
      source: 'Source',
      updatedAt: 'Updated',
      staleWarning: 'Showing the last successful reading',
      autoRefresh: 'Auto refresh',
      everySeconds: 'every {n}s',
      off: 'off',
      percentUsed: '{n}% used',
      percentLeft: '{n}% left',
      remainingDays: 'Days left',
      daysUnit: 'd',
      usageTitle: 'Usage',
      inputTokens: 'Input tokens',
      cachedTokens: 'Cached tokens',
      outputTokens: 'Output tokens',
      dailyAverage: 'Daily average',
      peakDay: 'Peak',
      todayUsage: 'Today',
      activeDays: '{n} active days',
      heatmap: 'Daily Credits',
      viewBill: 'View billing details ↗',
      untilToday: 'Through today',
      heatmapHint: 'Plan period only',
      less: 'Less',
      more: 'More',
      noUsage: 'No daily usage yet',
      usageUnavailable: 'Daily usage is unavailable right now; the balance above is still accurate',
      credits: 'Credits',
      catalog: 'Plan catalog',
      catalogHint: 'Public tiers and their monthly Credits. Purchase or renew in the SCNet console.',
      current: 'current',
      perMonth: '/mo',
      needsCookieTitle: 'Connect the SCNet console to read your balance',
      needsCookieDesc:
        'SCNet has no public usage API; credits consumption lives in the signed-in console. Sign in once in the window this button opens and the session is saved automatically.',
      needsCookieSteps:
        'The window shows SCNet’s own login page and supports whatever it offers (password, SMS, QR). It closes itself after a successful sign-in - no DevTools, no copying cookies.',
      openConsole: 'Open SCNet console ↗',
      loginTitle: 'Connect the SCNet console',
      loginDesc: 'The balance is only readable with a signed-in console. Sign in once with an SMS code or your account password; only the session cookie is stored.',
      modeSms: 'SMS code',
      modePassword: 'Password',
      loginPhone: 'Phone number',
      loginPhonePlaceholder: '11-digit mobile number',
      loginSmsCode: 'SMS code',
      loginSmsCodePlaceholder: '6-digit code',
      sendCode: 'Send code',
      resendIn: 'Resend in {n}s',
      codeSent: 'Code sent',
      loginAccount: 'Account',
      loginAccountPlaceholder: 'Phone number / username',
      loginPassword: 'Password',
      loginCaptcha: 'Captcha',
      loginCaptchaPlaceholder: 'Enter the code in the image',
      loginCaptchaPrompt: 'Enter the captcha and try again',
      loginButton: 'Sign in and save session',
      loggingIn: 'Signing in…',
      refreshCaptcha: 'New image',
      needCaptcha: 'Need a captcha?',
      loginSmsHint: 'An unregistered number is registered automatically after verification, exactly like the website.',
      loginPrivacy: 'Phone number, code or password are used for this one request only; they are never written to config, logs, or model context. Only the session cookie is stored.',
      loginHint: 'Open the SCNet console if you want to check the account state yourself.',
      loginSuccess: 'Signed in; session saved',
      loginFailed: 'Sign-in failed',
      statusNeedsCookie: 'not connected',
      statusStale: 'stale',
      statusError: 'failed',
      statusActive: 'active',
      statusExpired: 'expired',
      statusExhausted: 'exhausted',
      statusUnknown: 'unknown',
      settingsTitle: 'SCNet plan monitor',
      settingsDesc:
        'Shows the Token Plan monthly Credits balance, consumption and reset time in the sidebar panel and the composer chip. Every request runs on the host; neither the API key nor the cookie reaches the browser.',
      credential: 'API key credential',
      credentialConfigured: 'configured',
      credentialMissing: 'missing',
      consoleCookie: 'Console cookie',
      consoleCookieSet: 'saved',
      consoleCookieUnset: 'not saved',
      consoleCookieHint:
        'The balance is only readable with a signed-in console. Sign in at scnet.cn, copy the full Cookie header from any /acx request in DevTools, and save it below. It is written to the dsh credential store, never echoed, and never sent to the model.',
      cookiePlaceholder: 'name1=value1; name2=value2 …',
      saveCookie: 'Save cookie',
      saving: 'Saving…',
      clearCookie: 'Clear cookie',
      cookieSaved: 'Cookie saved, reading the plan…',
      cookieCleared: 'Cookie cleared',
      refreshInterval: 'Auto refresh',
      baseUrl: 'API base',
      lastSuccess: 'Last success',
      never: 'never',
      failureCount: 'Consecutive failures',
      refreshNow: 'Refresh now',
      chipTitle: 'SCNet plan balance (click for details)',
      chipNoData: 'SCNet plan not connected',
      topicUsage: 'topic',
      turnUsage: 'turn',
      creditUnit: 'Cr',
      chipCreditsHint: ' Credits estimated from tokens and SCNet model prices',
      hintMissingKey: 'No credential resolved. Make sure SCNET_API_KEY is stored in the dsh credential store.',
      hintSession: 'The console session expired. Sign in at www.scnet.cn again and save a fresh cookie in Settings → SCNet plan.',
      hintNetwork: 'Network or service error; it will retry automatically.',
      hintGeneric: 'Could not read the plan. Press Refresh to retry.',
    }

    // #region 工具
    /** 简单订阅式 store：不引入任何状态库。 */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        get: () => snapshot,
        set(next) {
          if (Object.is(next, snapshot)) return
          snapshot = next
          for (const fn of [...listeners]) fn()
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      }
    }

    const store = createStore({ status: 'idle', snapshot: null, error: null, info: null, at: 0 })

    let localeId = 'zh'
    let boundT = (key) => key
    let openPanel = () => {}

    let pollSeconds = 60
    let inflight = null

    /** 拉取一次快照；force 时让 Host 跳过缓存。 */
    async function refresh(force) {
      if (inflight !== null) return inflight
      if (store.get().snapshot === null) store.set({ ...store.get(), status: 'loading' })
      inflight = (async () => {
        let body = null
        try {
          const res = await fetch(force === true ? `${ROUTE}?refresh=1` : ROUTE, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
          })
          body = await res.json()
        } catch (error) {
          store.set({ ...store.get(), status: 'error', error: { code: 'REQUEST_FAILED', message: describe(error) }, at: Date.now() })
          return
        } finally {
          inflight = null
        }
        const info = body && body.info ? body.info : store.get().info
        if (typeof info?.refreshIntervalSec === 'number' && info.refreshIntervalSec > 0) {
          pollSeconds = Math.max(30, Math.min(3600, info.refreshIntervalSec))
        }
        if (body && body.ok === true) {
          store.set({ status: 'ready', snapshot: body.snapshot ?? null, error: null, info, at: Date.now() })
          return
        }
        store.set({
          status: 'error',
          snapshot: (body && body.snapshot) || store.get().snapshot,
          error: (body && body.error) || { code: 'UNKNOWN', message: 'unknown failure' },
          info,
          at: Date.now(),
        })
      })()
      return inflight
    }

    /** 保存/清除控制台 Cookie（Host 侧写入凭据库）。 */
    async function saveCookie(value) {
      const res = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: value }),
      })
      const body = await res.json()
      const info = body && body.info ? body.info : store.get().info
      store.set({
        status: body && body.ok === true ? 'ready' : 'error',
        snapshot: (body && body.snapshot) || store.get().snapshot,
        error: body && body.ok === true ? null : (body && body.error) || { code: 'UNKNOWN', message: 'unknown failure' },
        info,
        at: Date.now(),
      })
      return body
    }

    function describe(error) {
      if (error && typeof error.message === 'string') return error.message
      return String(error)
    }

    // ---- SCNet 账号登录：密码只用于一次请求，成功时只保存会话 Cookie ----
    const loginStore = createStore({ state: 'idle', message: null, captchaImage: null })

    /** 把 Host 返回的登录状态写进 store；成功后自动刷新一次快照。 */
    function publishLogin(login) {
      const previous = loginStore.get()
      loginStore.set({ state: 'idle', message: null, captchaImage: null, ...(login || {}) })
      if (login && login.state === 'success' && previous.state !== 'success') refresh(true)
    }

    /** 提交一次登录（或只取验证码）；密码不会离开这次请求。 */
    async function postLogin(payload) {
      try {
        const res = await fetch(`${ROUTE}/login`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await res.json()
        if (body && body.info) store.set({ ...store.get(), info: body.info })
        if (body && body.ok === true) {
          publishLogin(body.login)
        } else {
          publishLogin({ state: 'failed', message: (body && body.error && body.error.message) || t('loginFailed') })
        }
        return body
      } catch (error) {
        publishLogin({ state: 'failed', message: describe(error) })
        return null
      }
    }

    function useLogin() {
      const [value, setValue] = useState(loginStore.get())
      useEffect(() => loginStore.subscribe(() => setValue(loginStore.get())), [])
      return value
    }

    /** 登录状态 → 一句人话 + 语气。 */
    function loginMessage(login) {
      if (login.state === 'success') return { text: t('loginSuccess'), tone: 'ok' }
      if (login.state === 'code-sent') return { text: t('codeSent'), tone: 'ok' }
      if (login.state === 'failed') return { text: `${t('loginFailed')}${login.message ? `：${login.message}` : ''}`, tone: 'error' }
      if (login.state === 'captcha') return { text: login.message || t('loginCaptchaPrompt'), tone: 'muted' }
      return null
    }

    function useSnapshot() {
      const [value, setValue] = useState(store.get())
      useEffect(() => store.subscribe(() => setValue(store.get())), [])
      return value
    }

    let pollers = 0
    let timer = null
    function usePolling() {
      useEffect(() => {
        pollers += 1
        if (timer === null) {
          if (store.get().status === 'idle') refresh()
          timer = setInterval(() => refresh(), pollSeconds * 1000)
        }
        return () => {
          pollers -= 1
          if (pollers <= 0 && timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
      }, [])
    }

    function t(key, params) {
      let text = boundT(key)
      if (typeof text !== 'string') text = key
      if (params) {
        for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
      }
      return text
    }

    /** 数字本地化：中文用 万/亿，英文用 K/M。 */
    function fmtNumber(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—'
      const zhLocale = String(localeId).startsWith('zh')
      const n = Math.abs(value)
      const sign = value < 0 ? '-' : ''
      const trim = (x, digits) => x.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
      if (zhLocale) {
        if (n >= 1e8) return `${sign}${trim(n / 1e8, 2)} 亿`
        if (n >= 1e4) return `${sign}${trim(n / 1e4, 2)} 万`
      } else {
        if (n >= 1e9) return `${sign}${trim(n / 1e9, 2)}B`
        if (n >= 1e6) return `${sign}${trim(n / 1e6, 2)}M`
        if (n >= 1e3) return `${sign}${trim(n / 1e3, 2)}K`
      }
      return `${sign}${Math.round(n).toLocaleString(zhLocale ? 'zh-CN' : 'en-US')}`
    }

    function fmtDate(value) {
      if (typeof value !== 'string' || value.length === 0) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleDateString(String(localeId).startsWith('zh') ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
    }

    function fmtTime(value) {
      if (!value) return t('never')
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString(String(localeId).startsWith('zh') ? 'zh-CN' : 'en-US', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    function statusOf(state) {
      if (state.error !== null && state.snapshot !== null) return { key: 'statusStale', tone: 'warn' }
      if (state.error !== null) return { key: 'statusError', tone: 'error' }
      if (state.snapshot?.needsCookie === true) return { key: 'statusNeedsCookie', tone: 'warn' }
      const status = state.snapshot?.status
      if (status === 'active') return { key: 'statusActive', tone: 'ok' }
      if (status === 'expired') return { key: 'statusExpired', tone: 'error' }
      if (status === 'exhausted') return { key: 'statusExhausted', tone: 'error' }
      return { key: 'statusUnknown', tone: 'idle' }
    }

    function hintFor(error) {
      const code = String(error?.code ?? '')
      if (code === 'MISSING_KEY' || code === 'NO_KEY') return t('hintMissingKey')
      if (code === 'SESSION_REQUIRED' || code === 'UNAUTHORIZED' || code === 'AUTH') return t('hintSession')
      if (code === 'NETWORK' || code === 'TIMEOUT' || code === 'REQUEST_FAILED') return t('hintNetwork')
      if (typeof error?.hint === 'string' && error.hint.length > 0) return error.hint
      return t('hintGeneric')
    }

    // #region 样式
    const STYLE_ID = 'dsh-scnet-plan/styles'
    const CSS = `
.scp-page{height:100%;overflow:auto;padding:28px 32px 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);box-sizing:border-box}
.scp-wrap{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
.scp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.scp-title{margin:0;font-size:20px;font-weight:600;line-height:1.3}
.scp-sub{margin:6px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.scp-head-actions{display:flex;align-items:center;gap:10px;flex:none}
.scp-badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.scp-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.scp-badge-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.scp-badge-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.scp-badge-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.scp-badge-idle{color:var(--dsw-alias-state-idle-primary);background:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 12%,transparent)}
.scp-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;text-decoration:none}
.scp-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.scp-btn:disabled{opacity:.55;cursor:default}
.scp-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.scp-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:20px 22px}
.scp-card-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1))}
.scp-hero-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-hero-value{display:flex;align-items:baseline;gap:8px;margin-top:6px}
.scp-hero-value b{font-size:34px;font-weight:650;letter-spacing:-.02em;line-height:1.1}
.scp-hero-value span{font-size:13px;color:var(--dsw-alias-label-secondary)}
.scp-bar{margin-top:16px;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.scp-bar i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.scp-bar-warn i{background:var(--dsw-alias-state-warn-primary)}
.scp-bar-error i{background:var(--dsw-alias-state-error-primary)}
.scp-hero-foot{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:16px}
.scp-stat{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:12px 14px}
.scp-stat span{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.scp-stat b{font-size:15px;font-weight:600;word-break:break-all}
.scp-section-title{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.scp-models{display:flex;flex-wrap:wrap;gap:8px}
.scp-tag{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}
.scp-tag-on{border:0;background:transparent;padding:0;color:var(--dsw-alias-label-secondary);font-size:11px}
.scp-tag-on::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block;margin-right:5px;vertical-align:middle}
.scp-catalog{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-top:1px solid var(--dsw-alias-border-l1);margin-top:6px}
.scp-tier{border:0;border-left:1px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent;padding:14px 16px 0}
.scp-tier:first-child{border-left:0;padding-left:0}
.scp-tier-on{border-color:var(--dsw-alias-border-l1)}
.scp-tier-name{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.scp-tier-credits{margin-top:4px;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.scp-tier-credits small{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:4px}
.scp-tier-desc{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.scp-meta{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.scp-note b{color:var(--dsw-alias-label-primary);font-weight:600}
.scp-error-msg{font-size:13px;font-weight:600;margin:0 0 6px}
.scp-code{font-size:11px;color:var(--dsw-alias-label-secondary)}

/* —— v2: calm single-card panel —— */
.scp-panel{padding:22px 26px;color:var(--dsw-alias-label-primary);
--scp-ok:#12b76a;--scp-warn:#f79009;--scp-danger:#f04438;
--scp-accent:#3b82f6;--scp-violet:#8b5cf6;--scp-teal:#14b8a6}
body[data-ds-dark-theme] .scp-panel{--scp-ok:#3ddc97;--scp-warn:#ffb547;--scp-danger:#ff6b6b;--scp-accent:#7ea6ff;--scp-violet:#b39dff;--scp-teal:#4dd4d4}
.scp-plan-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-plan-line b{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.scp-status-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}
.scp-muted{color:var(--dsw-alias-label-secondary)}
.scp-sep{width:1px;height:10px;background:var(--dsw-alias-border-l2);display:inline-block;margin:0 2px}
.scp-hero{display:flex;align-items:center;justify-content:flex-start;gap:26px;margin-top:18px;flex-wrap:wrap}
.scp-label{font-size:11px;color:var(--dsw-alias-label-secondary);letter-spacing:.01em}
.scp-ring{position:relative;width:104px;height:104px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center}
.scp-ring-svg{position:absolute;inset:0;display:block;width:104px;height:104px;overflow:visible}
.scp-ring-ok{color:var(--scp-ok)}
.scp-ring-warn{color:var(--scp-warn)}
.scp-ring-error{color:var(--scp-danger)}
.scp-ring-inner{position:relative;z-index:1;width:78px;height:78px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}
.scp-ring-inner b{font-size:23px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
.scp-ring-inner span{font-size:10px;color:var(--dsw-alias-label-secondary)}
.scp-hero-value{display:flex;align-items:baseline;gap:6px;margin-top:4px;font-variant-numeric:tabular-nums}
.scp-hero-value b{font-size:24px;font-weight:600;letter-spacing:-.01em}
.scp-hero-number span{font-size:13px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:6px;letter-spacing:0}
.scp-hero-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px;font-variant-numeric:tabular-nums}
.scp-progress{flex:1;min-width:220px;max-width:340px;padding-bottom:4px}
.scp-bar{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.scp-bar i{display:block;height:100%;background:var(--dsw-alias-label-primary);border-radius:99px}
.scp-bar-warn i{background:var(--dsw-alias-state-warn-primary)}
.scp-bar-error i{background:var(--dsw-alias-state-error-primary)}
.scp-progress-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:6px;font-variant-numeric:tabular-nums}
.scp-metrics{display:grid;grid-template-columns:repeat(3,1fr);margin-top:24px;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l1)}
.scp-metric{padding:0 16px;border-left:1px solid var(--dsw-alias-border-l1);min-width:0}
.scp-metric:first-child{padding-left:0;border-left:0}
.scp-metric span{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.scp-metric b{display:block;margin-top:6px;font-size:15px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scp-metric b i{font-style:normal;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400;margin-left:3px}
.scp-heat-section{margin-top:22px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.scp-subhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.scp-heatmap{display:grid;grid-template-columns:repeat(7,14px);gap:3px;justify-content:start;max-width:none}
.scp-heat{width:14px;height:14px;min-height:0;aspect-ratio:auto;border-radius:2px;background:var(--dsw-alias-bg-layer-2)}
.scp-heat-empty{background:transparent}
.scp-h1{background:color-mix(in srgb,var(--scp-accent) 24%,var(--dsw-alias-bg-layer-2))}
.scp-h2{background:color-mix(in srgb,var(--scp-accent) 48%,var(--dsw-alias-bg-layer-2))}
.scp-h3{background:color-mix(in srgb,var(--scp-accent) 74%,var(--dsw-alias-bg-layer-2))}
.scp-h4{background:var(--scp-accent)}
.scp-h5{background:var(--dsw-alias-label-primary)}
.scp-heat-legend{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:10px;flex-wrap:wrap}
.scp-heat-legend i{width:9px;height:9px;border-radius:2px;display:inline-block}
.scp-heat-hint{margin-left:12px}
.scp-heat-caption{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.scp-more{margin-top:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:0 26px;background:transparent}
.scp-more summary{cursor:pointer;padding:15px 0;font-size:12px;color:var(--dsw-alias-label-secondary);list-style:none;outline:none}
.scp-more summary::-webkit-details-marker{display:none}
.scp-more summary::after{content:'+';float:right;font-size:14px;color:var(--dsw-alias-label-secondary)}
.scp-more[open] summary::after{content:'−'}
.scp-more[open] summary{padding-bottom:6px}
.scp-more-body{padding:8px 0 20px;display:flex;flex-direction:column;gap:20px}
.scp-models-block .scp-label{margin-bottom:8px}
.scp-footer{display:flex;flex-wrap:wrap;gap:16px;font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 4px;margin-top:2px}
.scp-warn{color:var(--dsw-alias-state-warn-primary)}
.scp-hero-foot{display:flex;justify-content:space-between;gap:12px;margin-top:12px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;font-variant-numeric:tabular-nums}
.scp-catalog{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1)}
.scp-catalog-row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}
.scp-catalog-name{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary)}
.scp-catalog-current{font-style:normal;font-size:11px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:5px}
.scp-catalog-current::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.scp-catalog-credits{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}
.scp-catalog-credits small{font-size:11px;margin-left:3px}
.scp-model-names{margin:0;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary);word-break:break-word}


.scp-status-text{font-size:12px}
.scp-tone-ok{color:var(--scp-ok)}
.scp-tone-warn{color:var(--scp-warn)}
.scp-tone-error{color:var(--scp-danger)}
.scp-tone-idle{color:var(--dsw-alias-label-secondary)}
.scp-hero-side{margin-left:auto;display:grid;grid-template-columns:repeat(2,minmax(118px,1fr));gap:14px 30px;padding-left:30px;border-left:1px solid var(--dsw-alias-border-l1)}
.scp-side-cell span{display:block;font-size:11px;color:var(--dsw-alias-label-secondary)}
.scp-side-cell b{display:block;margin-top:3px;font-size:15px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.scp-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}
@media (max-width:760px){.scp-hero-side{margin-left:0;padding-left:0;border-left:0;grid-template-columns:repeat(2,minmax(110px,1fr));width:100%;gap:12px 20px}}

@media (max-width:720px){.scp-metrics{grid-template-columns:repeat(2,1fr);row-gap:16px}.scp-metric{border-left:0;padding:0}.scp-hero-number{font-size:32px}}
.scp-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px}
.scp-kv{display:grid;grid-template-columns:150px 1fr;gap:10px 16px;font-size:13px}
.scp-kv div:nth-child(odd){color:var(--dsw-alias-label-secondary)}
.scp-input{width:100%;min-height:30px;box-sizing:border-box;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;resize:vertical}
.scp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.scp-skeleton{height:14px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:scp-pulse 1.4s ease-in-out infinite}
@keyframes scp-pulse{0%,100%{opacity:.6}50%{opacity:1}}
.scp-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;line-height:1}
.scp-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.scp-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.scp-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.scp-dot-error{background:var(--dsw-alias-state-error-primary)}
.scp-dot-idle{background:var(--dsw-alias-state-idle-primary)}
.scp-icon{display:flex;align-items:center;justify-content:center;width:100%;height:100%}
.scp-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px}
.scp-link:hover{text-decoration:underline}
.scp-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center}
.scp-details{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}
.scp-login{display:flex;flex-direction:column;gap:10px}
.scp-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-captcha{display:flex;align-items:center;gap:8px}
.scp-captcha .scp-input{flex:1;width:auto}
.scp-captcha-img{height:34px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:#fff}
.scp-tabs{display:flex;gap:6px;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);width:max-content}


.scp-tab{height:26px;padding:0 12px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.scp-tab-on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.scp-code-row{display:flex;gap:8px}
.scp-code-row .scp-input{flex:1;width:auto}
.scp-summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none}
.scp-summary:hover{color:var(--dsw-alias-label-primary)}
`
    /** 安装样式；返回 disposer，插件卸载/HMR 时把自己的 <style> 摘掉。 */
    function installStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) return () => existing.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    // #region 组件
    /** 侧栏面板图标（sidebar.panellist 只给 {size, active}，点击由侧栏负责）。 */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      const state = useSnapshot()
      const tone = statusOf(state).tone
      const color =
        tone === 'warn'
          ? 'var(--dsw-alias-state-warn-primary)'
          : tone === 'error'
            ? 'var(--dsw-alias-state-error-primary)'
            : 'currentColor'
      return h(
        'span',
        { className: 'scp-icon', title: t('panelLabel') },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M4 15.5 8.2 9.8l3.4 3.1L20 5',
            stroke: color,
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('path', { d: 'M4 19.5h16', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', opacity: 0.55 }),
        ),
      )
    }

    /** 登录状态的提示颜色。 */
    function toneColor(tone) {
      if (tone === 'ok') return 'var(--dsw-alias-state-success-primary)'
      if (tone === 'error') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-state-idle-primary)'
    }

    /** 登录表单：短信验证码 / 账号密码（面板引导卡与设置页共用）。 */
    function LoginForm() {
      const login = useLogin()
      const [mode, setMode] = useState('sms')
      const [phone, setPhone] = useState('')
      const [code, setCode] = useState('')
      const [username, setUsername] = useState('')
      const [password, setPassword] = useState('')
      const [captcha, setCaptcha] = useState('')
      const [busy, setBusy] = useState(false)
      const [cooldown, setCooldown] = useState(0)
      const message = loginMessage(login)
      const captchaImage = login.captchaImage

      useEffect(() => {
        if (login.state === 'code-sent') setCooldown(login.resendIn || 60)
      }, [login.state, login.at])

      useEffect(() => {
        if (cooldown <= 0) return undefined
        const timer = setTimeout(() => setCooldown(cooldown - 1), 1000)
        return () => clearTimeout(timer)
      }, [cooldown])

      async function sendCode(event) {
        if (event) event.preventDefault()
        if (busy || cooldown > 0) return
        setBusy(true)
        try {
          const body = await postLogin({ action: 'send-code', phone })
          if (body && body.login && body.login.state === 'code-sent') setCooldown(body.login.resendIn || 60)
        } finally {
          setBusy(false)
        }
      }

      async function submit(event) {
        if (event) event.preventDefault()
        if (busy) return
        setBusy(true)
        try {
          const body =
            mode === 'sms'
              ? await postLogin({ mode: 'sms', phone, code })
              : await postLogin({
                  mode: 'password',
                  username,
                  password,
                  ...(captcha.trim() === '' ? {} : { captcha: captcha.trim() }),
                })
          if (body && body.login && body.login.state === 'success') {
            setPhone('')
            setCode('')
            setUsername('')
            setPassword('')
            setCaptcha('')
          }
        } finally {
          setBusy(false)
        }
      }

      const tabs = h(
        'div',
        { className: 'scp-tabs' },
        h(
          'button',
          { type: 'button', className: `scp-tab${mode === 'sms' ? ' scp-tab-on' : ''}`, onClick: () => setMode('sms') },
          t('modeSms'),
        ),
        h(
          'button',
          { type: 'button', className: `scp-tab${mode === 'password' ? ' scp-tab-on' : ''}`, onClick: () => setMode('password') },
          t('modePassword'),
        ),
      )

      const smsFields = [
        h(
          'label',
          { className: 'scp-field', key: 'phone' },
          h('span', null, t('loginPhone')),
          h('input', {
            className: 'scp-input',
            value: phone,
            inputMode: 'tel',
            autoComplete: 'tel',
            placeholder: t('loginPhonePlaceholder'),
            onChange: (event) => setPhone(event.target.value),
          }),
        ),
        h(
          'label',
          { className: 'scp-field', key: 'code' },
          h('span', null, t('loginSmsCode')),
          h(
            'div',
            { className: 'scp-code-row' },
            h('input', {
              className: 'scp-input',
              value: code,
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              placeholder: t('loginSmsCodePlaceholder'),
              onChange: (event) => setCode(event.target.value),
            }),
            h(
              'button',
              { type: 'button', className: 'scp-btn', disabled: busy || cooldown > 0 || phone.trim() === '', onClick: sendCode },
              cooldown > 0 ? t('resendIn', { n: cooldown }) : t('sendCode'),
            ),
          ),
        ),
        h('p', { className: 'scp-note', key: 'hint', style: { margin: 0 } }, t('loginSmsHint')),
      ]

      const passwordFields = [
        h(
          'label',
          { className: 'scp-field', key: 'account' },
          h('span', null, t('loginAccount')),
          h('input', {
            className: 'scp-input',
            value: username,
            autoComplete: 'username',
            placeholder: t('loginAccountPlaceholder'),
            onChange: (event) => setUsername(event.target.value),
          }),
        ),
        h(
          'label',
          { className: 'scp-field', key: 'password' },
          h('span', null, t('loginPassword')),
          h('input', {
            className: 'scp-input',
            type: 'password',
            value: password,
            autoComplete: 'current-password',
            onChange: (event) => setPassword(event.target.value),
          }),
        ),
        captchaImage
          ? h(
              'div',
              { className: 'scp-field', key: 'captcha' },
              h('span', null, t('loginCaptcha')),
              h(
                'div',
                { className: 'scp-captcha' },
                h('img', { src: captchaImage, alt: t('loginCaptcha'), className: 'scp-captcha-img' }),
                h('input', {
                  className: 'scp-input',
                  value: captcha,
                  placeholder: t('loginCaptchaPlaceholder'),
                  onChange: (event) => setCaptcha(event.target.value),
                }),
                h('button', { type: 'button', className: 'scp-btn', disabled: busy, onClick: () => postLogin({ captchaOnly: true }) }, t('refreshCaptcha')),
              ),
            )
          : null,
      ]

      return h(
        'form',
        { className: 'scp-login', onSubmit: submit },
        tabs,
        ...(mode === 'sms' ? smsFields : passwordFields),
        h(
          'div',
          { className: 'scp-actions' },
          h(
            'button',
            {
              type: 'submit',
              className: 'scp-btn scp-btn-primary',
              disabled:
                busy ||
                (mode === 'sms' ? phone.trim() === '' || code.trim() === '' : username.trim() === '' || password === ''),
            },
            busy ? t('loggingIn') : t('loginButton'),
          ),
          h('a', { className: 'scp-link', href: CONSOLE_URL, target: '_blank', rel: 'noreferrer' }, t('openConsole')),
        ),
        message !== null
          ? h('p', { className: 'scp-note', style: { marginTop: 10, color: toneColor(message.tone) } }, message.text)
          : null,
        h('p', { className: 'scp-note', style: { marginTop: 8 } }, t('loginPrivacy')),
      )
    }

    /** 未连接控制台时的引导卡片。 */
    function CookieCallout() {
      return h(
        'article',
        { className: 'scp-card' },
        h('h2', { className: 'scp-section-title' }, t('loginTitle')),
        h('p', { className: 'scp-note', style: { margin: '0 0 12px' } }, t('loginDesc')),
        h(LoginForm, null),
        h('p', { className: 'scp-note', style: { marginTop: 10 } }, t('loginHint')),
      )
    }

    /** 套餐目录（公开数据，纯内容，行式列表）。 */
    function Catalog(props) {
      const catalog = props?.catalog
      const currentCode = props?.currentCode
      if (!Array.isArray(catalog) || catalog.length === 0) return null
      return h(
        'div',
        { className: 'scp-catalog-block' },
        h('div', { className: 'scp-label' }, t('catalog')),
        h(
          'div',
          { className: 'scp-catalog' },
          catalog.map((tier) => {
            const current = currentCode && String(tier.code) === String(currentCode)
            return h(
              'div',
              { className: 'scp-catalog-row', key: String(tier.code ?? tier.name) },
              h(
                'span',
                { className: 'scp-catalog-name' },
                tier.name || tier.code || '—',
                current ? h('i', { className: 'scp-catalog-current' }, t('current')) : null,
              ),
              h(
                'span',
                { className: 'scp-catalog-credits' },
                fmtNumber(tier.creditsPerMonth),
                h('small', null, `${t('credits')}${t('perMonth')}`),
              ),
            )
          }),
        ),
        h('p', { className: 'scp-note', style: { margin: '12px 0 0' } }, t('catalogHint')),
      )
    }

    /** YYYY-MM-DD from a local Date. */
    function dayKey(date) {
      const y = date.getFullYear()
      const m = String(date.getMonth() + 1).padStart(2, '0')
      const d = String(date.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }

    /** Parse "YYYY-MM-DD[ HH:mm:ss]" into a local Date. */
    function parseDay(value) {
      if (typeof value !== 'string' || value === '') return null
      const date = new Date(value.replace(' ', 'T'))
      return Number.isNaN(date.getTime()) ? null : date
    }

    /** Calendar cells for the plan period, 4 levels like the official heatmap. */
    function heatmapDays(snapshot) {
      const usage = snapshot?.usage
      if (!usage || !Array.isArray(usage.daily) || usage.daily.length === 0) return []
      const byDate = new Map(usage.daily.map((row) => [row.date, row]))
      const start = parseDay(snapshot.periodStart)
      const end = parseDay(snapshot.periodEnd || snapshot.expiresAt)
      if (start === null || end === null || end < start) return []
      const max = usage.maxDayCredits || Math.max(...usage.daily.map((row) => row.credits || 0))
      const cells = []
      const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
      const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
      while (cursor <= last && cells.length < 400) {
        const key = dayKey(cursor)
        const row = byDate.get(key)
        const credits = row?.credits ?? 0
        const level = row && credits > 0 && max > 0 ? Math.min(4, Math.max(1, Math.ceil((credits / max) * 4))) : 0
        cells.push({
          key,
          credits,
          inputTokens: row?.inputTokens ?? 0,
          cachedTokens: row?.cachedTokens ?? 0,
          outputTokens: row?.outputTokens ?? 0,
          level,
          weekday: (cursor.getDay() + 6) % 7,
        })
        cursor.setDate(cursor.getDate() + 1)
      }
      return cells
    }

    /** 额度 + 用量：单卡片、细分割线、无嵌套色块。 */
    function UsageDetails(props) {
      const snapshot = props?.snapshot
      const state = props?.state
      if (!snapshot) return null
      const usedPercent = Number.isFinite(snapshot.usedPercent)
        ? Math.max(0, Math.min(100, snapshot.usedPercent))
        : Number.isFinite(snapshot.totalCredits) && snapshot.totalCredits > 0 && Number.isFinite(snapshot.usedCredits)
          ? Math.max(0, Math.min(100, (snapshot.usedCredits / snapshot.totalCredits) * 100))
          : null
      const leftPercent = usedPercent === null ? null : 100 - usedPercent
      const usage = snapshot.usage
      const totals = usage?.totals
      const todayRow = usage?.daily?.find((row) => row.date === dayKey(new Date())) || null
      const cells = heatmapDays(snapshot)
      const leading = cells.length > 0 ? cells[0].weekday : 0
      const status = statusOf(state || { snapshot, error: null })
      const warnAt = Number.isFinite(state?.info?.warnBelowPercent) ? state.info.warnBelowPercent : 20
      const barTone = leftPercent === null ? 'ok' : leftPercent <= warnAt / 3 ? 'error' : leftPercent <= warnAt ? 'warn' : 'ok'
      const percentText = leftPercent === null ? '—' : `${leftPercent >= 10 ? Math.round(leftPercent) : leftPercent.toFixed(1)}%`
      const toneColor =
        status.tone === 'ok'
          ? 'var(--dsw-alias-state-success-primary)'
          : status.tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : status.tone === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-state-idle-primary)'
      const metric = (label, value, unit, dot) =>
        h(
          'div',
          { className: 'scp-metric' },
          h('span', null, dot ? h('i', { className: 'scp-dot', style: { background: `var(--${dot})` } }) : null, label),
          h('b', null, value, unit ? h('i', null, unit) : null),
        )
      const sideCell = (label, value) => h('div', { className: 'scp-side-cell' }, h('span', null, label), h('b', null, value))

      return h(
        'article',
        { className: 'scp-card scp-panel' },
        h(
          'div',
          { className: 'scp-plan-line' },
          h('span', { className: 'scp-status-dot', style: { background: toneColor } }),
          h('b', null, snapshot.planName || '—'),
          h('span', { className: `scp-status-text scp-tone-${status.tone}` }, t(status.key)),
          snapshot.planCode ? h('span', { className: 'scp-sep' }) : null,
          snapshot.planCode ? h('span', { className: 'scp-muted' }, snapshot.planCode) : null,
        ),
        h(
          'div',
          { className: 'scp-hero' },
          h(
            'div',
            {
              className: `scp-ring scp-ring-${barTone}`,
              role: 'img',
              'aria-label': leftPercent === null ? '' : `${t('remaining')} ${percentText}`,
            },
            (() => {
              const radius = 46
              const circumference = 2 * Math.PI * radius
              const filled = circumference * ((leftPercent === null ? 0 : leftPercent) / 100)
              return h(
                'svg',
                { className: 'scp-ring-svg', viewBox: '0 0 104 104', width: 104, height: 104, 'aria-hidden': 'true' },
                h('circle', { cx: 52, cy: 52, r: radius, fill: 'none', stroke: 'var(--dsw-alias-bg-layer-2)', strokeWidth: 12 }),
                h('circle', {
                  cx: 52,
                  cy: 52,
                  r: radius,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 12,
                  strokeLinecap: 'round',
                  strokeDasharray: `${filled} ${circumference}`,
                  transform: 'rotate(-90 52 52)',
                }),
              )
            })(),
            h(
              'div',
              { className: 'scp-ring-inner' },
              h('b', null, percentText),
              h('span', null, t('remaining')),
            ),
          ),
          h(
            'div',
            { className: 'scp-hero-main' },
            h('div', { className: 'scp-label' }, t('remaining')),
            h('div', { className: 'scp-hero-value' }, fmtNumber(snapshot.remainingCredits), h('span', null, t('credits'))),
            h(
              'div',
              { className: 'scp-hero-sub' },
              `${t('used')} ${fmtNumber(snapshot.usedCredits)} / ${fmtNumber(snapshot.totalCredits)} · ${t('used')} ${usedPercent === null ? '—' : `${usedPercent.toFixed(1)}%`}`,
            ),
          ),
          h(
            'div',
            { className: 'scp-hero-side' },
            sideCell(
              t('remainingDays'),
              snapshot.remainingDays === null || snapshot.remainingDays === undefined ? '—' : `${snapshot.remainingDays} ${t('daysUnit')}`,
            ),
            sideCell(t('todayUsage'), todayRow ? `${fmtNumber(todayRow.credits)} ${t('credits')}` : '—'),
            sideCell(t('dailyAverage'), `${fmtNumber(usage?.dailyAverage)} ${t('credits')}`),
            sideCell(t('models'), Array.isArray(snapshot.models) ? String(snapshot.models.length) : '—'),
          ),
        ),
        h(
          'div',
          { className: 'scp-hero-foot' },
          h(
            'span',
            null,
            `${fmtDate(snapshot.periodStart)} – ${fmtDate(snapshot.periodEnd)}`,
          ),
          h('a', { className: 'scp-link', href: BILL_URL, target: '_blank', rel: 'noreferrer' }, t('viewBill')),
        ),
        h(
          'div',
          { className: 'scp-metrics' },
          metric(t('inputTokens'), totals ? fmtNumber(totals.inputTokens) : '—', '', 'scp-accent'),
          metric(t('cachedTokens'), totals ? fmtNumber(totals.cachedTokens) : '—', '', 'scp-violet'),
          metric(t('outputTokens'), totals ? fmtNumber(totals.outputTokens) : '—', '', 'scp-teal'),
        ),
        h(
          'div',
          { className: 'scp-heat-section' },
          h(
            'div',
            { className: 'scp-subhead' },
            h('span', { className: 'scp-label' }, t('heatmap')),
            usage ? h('span', { className: 'scp-heat-caption' }, t('activeDays', { n: usage.days })) : null,
          ),
          cells.length > 0
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'scp-heatmap' },
                  Array.from({ length: leading }, (_, index) =>
                    h('span', { className: 'scp-heat scp-heat-empty', key: `pad-${index}` }),
                  ),
                  cells.map((cell) =>
                    h('span', {
                      key: cell.key,
                      className: `scp-heat scp-h${cell.level}`,
                      title: `${cell.key} · ${fmtNumber(cell.credits)} ${t('credits')} · ${t('inputTokens')} ${fmtNumber(cell.inputTokens)} · ${t('cachedTokens')} ${fmtNumber(cell.cachedTokens)} · ${t('outputTokens')} ${fmtNumber(cell.outputTokens)}`,
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'scp-heat-legend' },
                  h('span', null, t('less')),
                  [0, 1, 2, 3, 4].map((level) => h('i', { key: level, className: `scp-h${level}` })),
                  h('span', null, t('more')),
                ),
              )
            : h('p', { className: 'scp-note' }, snapshot.usageError ? t('usageUnavailable') : t('noUsage')),
        ),
      )
    }

    /** 中央面板。 */
    function PlanPanel() {
      const state = useSnapshot()
      usePolling()
      const started = useRef(false)
      useEffect(() => {
        if (started.current) return
        started.current = true
        refresh()
      }, [])
      const snapshot = state.snapshot
      const info = state.info
      const busy = state.status === 'loading' || state.status === 'refreshing'
      const status = statusOf(state)
      const usedPercent = Number.isFinite(snapshot?.usedPercent)
        ? Math.max(0, Math.min(100, snapshot.usedPercent))
        : Number.isFinite(snapshot?.totalCredits) && snapshot.totalCredits > 0 && Number.isFinite(snapshot?.usedCredits)
          ? Math.max(0, Math.min(100, (snapshot.usedCredits / snapshot.totalCredits) * 100))
          : null
      const leftPercent = usedPercent === null ? null : 100 - usedPercent
      const warnAt = Number.isFinite(info?.warnBelowPercent) ? info.warnBelowPercent : 20
      const tone = leftPercent === null ? 'ok' : leftPercent <= warnAt / 3 ? 'error' : leftPercent <= warnAt ? 'warn' : 'ok'

      const header = h(
        'header',
        { className: 'scp-head' },
        h('div', null, h('h1', { className: 'scp-title' }, t('title')), h('p', { className: 'scp-sub' }, t('subtitle'))),
        h(
          'div',
          { className: 'scp-head-actions' },
          h('button', { type: 'button', className: 'scp-btn', disabled: busy, onClick: () => refresh(true) }, busy ? t('refreshing') : t('refresh')),
        ),
      )

      if (snapshot === null && (state.status === 'loading' || state.status === 'idle')) {
        return h(
          'section',
          { className: 'scp-page' },
          h(
            'div',
            { className: 'scp-wrap' },
            header,
            h(
              'article',
              { className: 'scp-card' },
              h('div', { className: 'scp-skeleton', style: { width: '38%' } }),
              h('div', { className: 'scp-skeleton', style: { width: '62%', height: 28, marginTop: 14 } }),
              h('div', { className: 'scp-skeleton', style: { marginTop: 18 } }),
            ),
          ),
        )
      }

      if (snapshot === null) {
        const error = state.error || { code: 'UNKNOWN', message: t('unavailable') }
        return h(
          'section',
          { className: 'scp-page' },
          h(
            'div',
            { className: 'scp-wrap' },
            header,
            h(
              'article',
              { className: 'scp-card scp-card-error' },
              h('p', { className: 'scp-error-msg' }, error.message || t('unavailable')),
              h('p', { className: 'scp-note' }, hintFor(error)),
              h(
                'div',
                { className: 'scp-row' },
                h('button', { type: 'button', className: 'scp-btn', disabled: busy, onClick: () => refresh(true) }, t('retry')),
                h('span', { className: 'scp-code' }, String(error.code ?? '')),
              ),
            ),
          ),
        )
      }

      const hero = h(UsageDetails, { snapshot })

      const models =
        Array.isArray(snapshot.models) && snapshot.models.length > 0
          ? h(
              'div',
              { className: 'scp-models-block' },
              h('div', { className: 'scp-label' }, `${t('models')} · ${snapshot.models.length}`),
              h(
                'p',
                { className: 'scp-model-names' },
                snapshot.models
                  .slice(0, 60)
                  .map((model) => model?.name || model?.id || String(model))
                  .join(' · '),
              ),
            )
          : null

      const footer = h(
        'div',
        { className: 'scp-footer' },
        h('span', null, `${t('source')} · ${snapshot.source || '—'}`),
        h('span', null, `${t('updatedAt')} · ${fmtTime(snapshot.fetchedAt || state.at)}`),
        h('span', null, `${t('autoRefresh')} · ${info?.refreshIntervalSec > 0 ? t('everySeconds', { n: info.refreshIntervalSec }) : t('off')}`),
        state.error !== null ? h('span', { className: 'scp-warn' }, t('staleWarning')) : null,
      )

      if (snapshot.needsCookie === true) {
        return h(
          'section',
          { className: 'scp-page' },
          h(
            'div',
            { className: 'scp-wrap' },
            header,
            h(CookieCallout),
            h('article', { className: 'scp-card' }, h(Catalog, { catalog: snapshot.catalog, currentCode: snapshot.planCode })),
            footer,
            state.error !== null ? h('p', { className: 'scp-note' }, hintFor(state.error)) : null,
          ),
        )
      }

      return h(
        'section',
        { className: 'scp-page' },
        h(
          'div',
          { className: 'scp-wrap' },
          header,
          h(UsageDetails, { snapshot, state }),
          h(
            'details',
            { className: 'scp-more' },
            h('summary', null, t('more')),
            h('div', { className: 'scp-more-body' }, h(Catalog, { catalog: snapshot.catalog, currentCode: snapshot.planCode }), models),
          ),
          footer,
          state.error !== null ? h('p', { className: 'scp-note' }, hintFor(state.error)) : null,
        ),
      )
    }

    /** 设置页：Cookie 编辑 + 状态。 */
    function SettingsSection() {
      const state = useSnapshot()
      usePolling()
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const info = state.info || {}

      async function submit(value) {
        setBusy(true)
        setNotice(null)
        try {
          const body = await saveCookie(value)
          if (body && body.ok === true) {
            setDraft('')
            setNotice({ kind: 'ok', text: value === '' ? t('cookieCleared') : t('cookieSaved') })
          } else {
            setNotice({ kind: 'error', text: (body && body.error && body.error.message) || t('hintGeneric') })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: describe(error) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'section',
        { className: 'scp-page' },
        h(
          'div',
          { className: 'scp-wrap' },
          h(
            'header',
            { className: 'scp-head' },
            h('div', null, h('h1', { className: 'scp-title' }, t('settingsTitle')), h('p', { className: 'scp-sub' }, t('settingsDesc'))),
            h(
              'div',
              { className: 'scp-head-actions' },
              h('button', { type: 'button', className: 'scp-btn', disabled: busy || state.status === 'loading', onClick: () => refresh(true) }, t('refreshNow')),
            ),
          ),
          h(
            'article',
            { className: 'scp-card' },
            h(
              'div',
              { className: 'scp-kv' },
              h('div', null, t('consoleCookie')),
              h('div', null, `${info.consoleCookieConfigured ? t('consoleCookieSet') : t('consoleCookieUnset')} · ${info.consoleCookieRef || 'SCNET_CONSOLE_COOKIE'}`),
              h('div', null, t('credential')),
              h('div', null, `${info.keyConfigured ? t('credentialConfigured') : t('credentialMissing')} · ${info.apiKeyRef || 'SCNET_API_KEY'}`),
              h('div', null, t('refreshInterval')),
              h('div', null, info.refreshIntervalSec > 0 ? t('everySeconds', { n: info.refreshIntervalSec }) : t('off')),
              h('div', null, t('baseUrl')),
              h('div', null, info.baseUrl || 'https://api.scnet.cn'),
              h('div', null, t('lastSuccess')),
              h('div', null, fmtTime(info.lastSuccessAt ? new Date(info.lastSuccessAt).toISOString() : null)),
              h('div', null, t('failureCount')),
              h('div', null, String(info.failures ?? 0)),
            ),
            h(
              'details',
              { className: 'scp-details' },
              h('summary', { className: 'scp-summary' }, t('advancedManual')),
                h('p', { className: 'scp-note', style: { margin: '14px 0 6px' } }, t('consoleCookieHint')),
                h('textarea', {
                  className: 'scp-input',
                  rows: 3,
                  spellCheck: false,
                  placeholder: t('cookiePlaceholder'),
                  value: draft,
                  onChange: (event) => setDraft(event.target.value),
                }),
                h(
                  'div',
                  { className: 'scp-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'scp-btn scp-btn-primary',
                      disabled: busy || info.cookieEditable === false || draft.trim() === '',
                      onClick: () => submit(draft.trim()),
                    },
                    busy ? t('saving') : t('saveCookie'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'scp-btn',
                      disabled: busy || info.cookieEditable === false || !info.consoleCookieConfigured,
                      onClick: () => submit(''),
                    },
                    t('clearCookie'),
                  ),
                  h('a', { className: 'scp-link', href: CONSOLE_URL, target: '_blank', rel: 'noreferrer' }, t('openConsole')),
                ),
            ),
            notice !== null
              ? h(
                  'p',
                  {
                    className: 'scp-note',
                    style: {
                      marginTop: 10,
                      color: notice.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
                    },
                  },
                  notice.text,
                )
              : null,
          ),
          info.loginEnabled !== false
            ? h(
                'article',
                { className: 'scp-card' },
                h('h2', { className: 'scp-section-title' }, t('loginTitle')),
                h('p', { className: 'scp-note', style: { margin: '0 0 12px' } }, t('loginDesc')),
                h(LoginForm, null),
              )
            : null,
          h('article', { className: 'scp-card scp-note' }, h('div', null, t('needsCookieSteps'))),
        ),
      )
    }

    /** 输入框下方的紧凑徽标：剩余百分比 + 本话题/本轮 Credits 估算。 */
    function UsageChip(props) {
      const state = useSnapshot()
      usePolling()
      const snapshot = state.snapshot
      const used = snapshot && Number.isFinite(snapshot.usedPercent) ? snapshot.usedPercent : null
      const left = used === null ? null : Math.max(0, 100 - used)
      const warnAt = Number.isFinite(state.info?.warnBelowPercent) ? state.info.warnBelowPercent : 20
      const tone =
        snapshot?.needsCookie === true
          ? 'warn'
          : state.error !== null && snapshot === null
            ? 'error'
            : left !== null && left <= warnAt / 3
              ? 'error'
              : left !== null && left <= warnAt
                ? 'warn'
                : 'ok'

      // Topic usage comes from the session projection DSH already shows as tokens.
      const readProjection = typeof props?.useProjection === 'function' ? props.useProjection : () => undefined
      const readSession = typeof props?.useSession === 'function' ? props.useSession : () => undefined
      const usage = readProjection('tokenUsage')
      const running = Boolean(readSession((value) => value?.running))
      const selection = readSession((value) => value?.modelSelection?.next ?? value?.modelSelection?.lastUsed ?? null)
      const provider = selection?.provider ?? null
      const modelId = selection?.model ?? null
      const scnetModels = Array.isArray(snapshot?.models) ? snapshot.models : []
      // Credits only apply to requests billed by the SCNet Token Plan.
      const isScnetModel =
        provider !== null && String(provider).toLowerCase().includes('scnet')
          ? true
          : modelId !== null && scnetModels.some((entry) => (entry?.id ?? entry?.name) === modelId)
      const fallbackRates = state.info?.creditRates ?? { input: 2, cached: 0.2, output: 8 }
      const rate = (isScnetModel && modelId !== null && snapshot?.modelRates?.[modelId]) || fallbackRates
      const creditsOf = (value, prices) => {
        if (!value || !prices) return null
        const input = ((value.uncachedInputTokens ?? 0) + (value.cacheWriteTokens ?? 0)) / 1000
        const cached = (value.cacheReadTokens ?? 0) / 1000
        const output = (value.outputTokens ?? 0) / 1000
        return input * prices.input + cached * prices.cached + output * prices.output
      }
      const topicCredits = creditsOf(usage, rate)
      const turnRef = useRef({ running: false, base: null, last: null })
      const turn = turnRef.current
      if (running && !turn.running) {
        turn.running = true
        turn.base = topicCredits
      } else if (!running && turn.running) {
        turn.running = false
        turn.last = topicCredits !== null && turn.base !== null ? Math.max(0, topicCredits - turn.base) : null
      }
      const turnCredits = running
        ? topicCredits !== null && turn.base !== null
          ? Math.max(0, topicCredits - turn.base)
          : null
        : turn.last
      const creditsText = (value) => {
        if (value === null || !Number.isFinite(value)) return null
        if (value < 1000) return String(Math.round(value))
        if (value < 10000) return `${(value / 1000).toFixed(1)}k`
        return `${(value / 10000).toFixed(2)}万`
      }
      const creditsVisible = snapshot !== null && snapshot.needsCookie !== true && isScnetModel
      const topicText = creditsVisible ? creditsText(topicCredits) : null
      const turnText = creditsVisible ? creditsText(turnCredits) : null

      const parts = [`SCNet · ${snapshot === null || snapshot.needsCookie === true ? t('chipNoData') : left === null ? fmtNumber(snapshot.remainingCredits) : `${left >= 10 ? Math.round(left) : left.toFixed(1)}%`}`]
      if (topicText !== null) parts.push(`${t('topicUsage')} ≈${topicText} ${t('creditUnit')}`)
      if (running && turnText !== null) parts.push(`${t('turnUsage')} ≈${turnText} ${t('creditUnit')}`)

      return h(
        'button',
        { type: 'button', className: 'scp-chip', title: `${t('chipTitle')}${topicText !== null ? t('chipCreditsHint') : ''}`, onClick: () => openPanel() },
        h('span', { className: `scp-dot scp-dot-${tone}` }),
        h('span', null, parts.join(' · ')),
      )
    }

    /** 插件导出：浏览器 Loader 读取 apply/inject（inject 是**客户端服务**名，不是包名）。 */
    const inject = ['slots', 'locale', 'layout']

    function apply(ctx) {
      try {
        ctx.effect(() => installStyles(), 'scnet-plan: styles')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'scnet-plan: dictionaries')
        boundT = ctx.locale.bind(NS)
        const syncLocale = () => {
          const current = ctx.locale.getLocale()
          const id = current?.id || current?.locale || 'zh'
          if (typeof id === 'string') localeId = id
        }
        syncLocale()
        ctx.effect(() => ctx.locale.subscribe(syncLocale), 'scnet-plan: locale subscription')
        ctx.effect(
          () => () => {
            if (timer !== null) {
              clearInterval(timer)
              timer = null
            }
          },
          'scnet-plan: stop polling',
        )

        // 侧栏图标 + 中央面板：list id 与 keyed main key 同名，侧栏点图标即切到该面板。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 20, label: () => t('panelLabel'), locale: NS }, PanelIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY, locale: NS }, PlanPanel))
        // 设置 → SCNet 套餐
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: PANEL_KEY, order: 75, label: () => t('settingsTitle'), locale: NS }, SettingsSection),
        )
        // 输入框下方徽标
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: `${PANEL_KEY}-chip`, order: 5, locale: NS }, UsageChip),
        )

        const layout = ctx.get('layout')
        if (layout && typeof layout.selectPanel === 'function') openPanel = () => layout.selectPanel(PANEL_KEY)
      } catch (error) {
        console.error('[dsh-scnet-plan] client apply failed:', error)
      }
    }

    return { inject, apply }
  },
})
