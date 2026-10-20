/**
 * dsh-scnet-plan: 在 DeepSeek Harness 里监控 SCNet（超算互联网）Token Plan。
 *
 * Node half 负责：
 *   - 通过 `ctx.credentials` 解析 SCNET_API_KEY 与控制台 Cookie（两者都不进浏览器）；
 *   - 以 TTL + single-flight 缓存拉取套餐快照（`lib/scnet-api.js` 的数据源适配器）；
 *   - 注册 `GET {routePath}` 供 Web 端面板/徽标轮询，`POST {routePath}` 保存控制台 Cookie；
 *   - 注册 `get_scnet_plan` 工具，让模型能回答"还剩多少额度"；
 *   - 让 Settings 不为本插件自动生成配置表单（页面由 client.js 的 settings.section 提供）。
 *
 * 数据源说明：Token Plan 的余量只有登录控制台才能读到（SCNet 没有公开的用量 API），
 * 所以完整监控需要在设置页保存一次控制台 Cookie；没有 Cookie 时仍会显示公开的套餐目录。
 *
 * @module dsh-scnet-plan
 */
import Schema from '@deepseek-ai/schemastery'
import { createPlanService } from './lib/plan-service.js'
import { consoleOrigin, describeCredential, fetchPlan, resolveCredential, verifyConsoleCookie } from './lib/scnet-api.js'
import { createConsoleAuth } from './lib/console-auth.js'
import { formatPlan, planToolSchema } from './lib/format.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'scnet-plan'

/** 依赖的服务；`webServer`/`tools`/`settings` 都按需注入，缺失时插件照常加载。 */
export const inject = []

/**
 * 插件配置。所有字段都有默认值：装上就能用（与 scnet provider 共用 SCNET_API_KEY）。
 */
export const Config = Schema.object({
  apiKeyEnv: Schema.string()
    .default('SCNET_API_KEY')
    .description('保存 SCNet API Key 的凭据引用名（与 dsh 的 scnet provider 默认一致）。'),
  baseUrl: Schema.string().default('https://api.scnet.cn').description('OpenAI 兼容网关地址（Bearer sk-tp-… 可用）。'),
  consoleBaseUrl: Schema.string()
    .default('https://www.scnet.cn')
    .description('SCNet 控制台地址：套餐目录与订阅额度都在它的 /acx 接口上（留空则从 baseUrl 推导）。'),
  apiBasePath: Schema.string().default('/api/llm/v1').description('OpenAI 兼容网关路径前缀，用于拉取模型列表。'),
  consoleCookieEnv: Schema.string()
    .default('SCNET_CONSOLE_COOKIE')
    .description('保存 scnet.cn 控制台 Cookie 的凭据引用名；有它才能读到真实额度消耗。'),
  refreshIntervalSec: Schema.number().default(300).description('缓存与自动刷新间隔（秒）；0 表示只手动刷新。'),
  requestTimeoutMs: Schema.number().default(15_000).description('单次请求超时（毫秒）。'),
  includeModels: Schema.boolean().default(true).description('快照里附带网关模型列表与公开套餐目录。'),
  warnBelowPercent: Schema.number().default(20).description('剩余额度低于该百分比时，面板与徽标转为警示色。'),
  routePath: Schema.string().default('/scnet-plan/snapshot').description('Web 面板读取快照的 Host 路由。'),
  tool: Schema.boolean().default(true).description('注册 get_scnet_plan 工具。'),
  manageCookie: Schema.boolean().default(true).description('允许设置页通过 POST 路由保存控制台 Cookie。'),
  accountLogin: Schema.boolean().default(true).description('允许在设置页用 SCNet 短信验证码/账号密码登录并保存会话（推荐）。'),
  loginTimeoutSec: Schema.number().default(30).description('单次登录请求的超时秒数。'),
})

/** 校验配置，写错时在加载期报出来，而不是等到第一次刷新。 */
function assertConfig(config) {
  if (!Number.isFinite(config.refreshIntervalSec) || config.refreshIntervalSec < 0) {
    throw new Error('scnet-plan: refreshIntervalSec must be a non-negative number')
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 0) {
    throw new Error('scnet-plan: requestTimeoutMs must be a non-negative number')
  }
  if (!Number.isFinite(config.warnBelowPercent) || config.warnBelowPercent < 0 || config.warnBelowPercent > 100) {
    throw new Error('scnet-plan: warnBelowPercent must be between 0 and 100')
  }
  for (const field of ['apiKeyEnv', 'consoleCookieEnv']) {
    if (config[field] !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config[field])) {
      throw new Error(`scnet-plan: ${field} "${config[field]}" is not a credential reference (POSIX identifier)`)
    }
  }
  if (config.routePath !== '' && !config.routePath.startsWith('/')) {
    throw new Error('scnet-plan: routePath must start with "/"')
  }
}

/** 已用比例（0-100），无法计算时返回 null。 */
function usedPercentOf(snapshot) {
  const total = snapshot?.totalCredits
  const used = snapshot?.usedCredits
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) return null
  return Math.max(0, Math.min(100, (used / total) * 100))
}

/** 一次请求体最多接受的字节数，避免把 Host 内存交给浏览器。 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed object ({} when empty).
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * 注册路由、工具与设置策略。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - 已应用默认值并经 Schema 校验的配置。
 */
export function apply(ctx, config) {
  assertConfig(config)

  const service = createPlanService({
    fetchPlan: (signal) => fetchPlan({ ctx, config, signal }),
    ttlMs: () => Math.max(0, config.refreshIntervalSec) * 1000,
    timeoutMs: () => Math.max(1_000, config.requestTimeoutMs),
  })

  /** 面板/徽标共用的元信息：只说明凭据是否配置，绝不返回密钥或 Cookie。 */
  async function describeInfo() {
    const key = await describeCredential(ctx, config.apiKeyEnv)
    const cookie = await describeCredential(ctx, config.consoleCookieEnv)
    const stats = service.stats()
    return {
      apiKeyRef: config.apiKeyEnv,
      keyConfigured: key.configured,
      consoleCookieRef: config.consoleCookieEnv,
      consoleCookieConfigured: cookie.configured,
      baseUrl: config.baseUrl,
      consoleBaseUrl: consoleOrigin(config),
      refreshIntervalSec: config.refreshIntervalSec,
      warnBelowPercent: config.warnBelowPercent,
      cookieEditable: config.manageCookie,
      loginEnabled: config.accountLogin,
      loginSupported: config.passwordLogin,
      login: auth.status(),
      lastSuccessAt: stats.lastSuccessAt,
      lastAttemptAt: stats.lastAttemptAt,
      failures: stats.failures,
    }
  }

  /**
   * 桌面版登录窗：用户在窗口里正常登录，成功后自动把会话 Cookie 写进凭据库。
   * 非桌面环境（`electron` 不可用）会返回 unsupported，设置页据此隐藏按钮。
   */
  const auth = createConsoleAuth({
    consoleBaseUrl: consoleOrigin(config),
    timeoutMs: Math.max(5, config.loginTimeoutSec) * 1000,
    verify: async (cookie) => {
      const result = await verifyConsoleCookie({
        config,
        cookie,
        signal: AbortSignal.timeout(Math.max(5_000, config.requestTimeoutMs)),
      })
      return { ok: true, detail: `已识别 ${result.count} 个套餐订阅` }
    },
    onSession: async (cookie) => {
      const credentials = ctx.get?.('credentials')
      if (credentials === undefined || typeof credentials.set !== 'function') {
        throw new Error('当前 dsh 构建没有暴露凭据写入接口')
      }
      await credentials.set(config.consoleCookieEnv, cookie)
      service.invalidate()
      await service.read({ force: true })
    },
  })


  /** GET：读快照（force 时绕过 TTL）。 */
  async function handleSnapshotRead(force, signal) {
    const info = await describeInfo()
    const { snapshot, failure } = await service.read({ force, signal })
    return failure === null ? { ok: true, info, snapshot } : { ok: false, info, snapshot, error: failure }
  }

  /** POST：保存或清除控制台 Cookie，然后立刻刷新一次快照。 */
  async function handleCookieWrite(req, signal) {
    if (!config.manageCookie || config.consoleCookieEnv === '') {
      return { ok: false, info: await describeInfo(), error: { code: 'READ_ONLY', message: 'Cookie 管理已在本插件配置中关闭' } }
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return {
        ok: false,
        info: await describeInfo(),
        error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'invalid body' },
      }
    }
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined || typeof credentials.set !== 'function') {
      return {
        ok: false,
        info: await describeInfo(),
        error: { code: 'NO_CREDENTIALS', message: '当前 dsh 构建没有暴露凭据写入接口' },
      }
    }
    const raw = typeof body.cookie === 'string' ? body.cookie.trim() : ''
    try {
      if (raw === '') await credentials.unset(config.consoleCookieEnv)
      else await credentials.set(config.consoleCookieEnv, normalizeCookie(raw))
    } catch (error) {
      return {
        ok: false,
        info: await describeInfo(),
        error: { code: 'WRITE_FAILED', message: error instanceof Error ? error.message : String(error) },
      }
    }
    // 清掉缓存，让这次刷新一定打网络。
    service.invalidate?.()
    const { snapshot, failure } = await service.read({ force: true, signal })
    const info = await describeInfo()
    return failure === null ? { ok: true, info, snapshot } : { ok: false, info, snapshot, error: failure }
  }

  // ---- Web 路由：浏览器只同源读取，密钥/Cookie 不出 Host ----
  if (config.routePath !== '') {
    ctx.inject(['webServer'], (webCtx) => {
      /**
       * Register one JSON endpoint. The response is aborted only when the caller
       * really went away (`res` close before it finished), never merely because
       * the request body was consumed.
       */
      const registerJsonRoute = (path, handle, label) => {
        webCtx.effect(
          () =>
            webCtx.webServer.register({
              kind: 'exact',
              path,
              handler: async (req, res) => {
                const controller = new AbortController()
                res.once('close', () => {
                  if (!res.writableEnded) controller.abort(new Error('client closed'))
                })
                let payload
                try {
                  payload = await handle(req, controller.signal)
                } catch (error) {
                  payload = {
                    ok: false,
                    info: await describeInfo().catch(() => ({})),
                    error: {
                      code: error?.code ?? 'ROUTE_FAILED',
                      message: error instanceof Error ? error.message : String(error),
                    },
                  }
                }
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
                res.end(JSON.stringify(payload))
              },
            }),
          label,
        )
      }

      registerJsonRoute(
        config.routePath,
        async (req, signal) => {
          if (req.method === 'POST') return handleCookieWrite(req, signal)
          if (req.method === 'GET') {
            const force = /(?:\?|&)refresh=1(?:&|$)/.test(req.url ?? '')
            return handleSnapshotRead(force, signal)
          }
          return { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET or POST only' } }
        },
        `webServer.register(${config.routePath})`,
      )

      // 登录窗：GET 读状态，POST 开始/取消（body: {cancel:true}）。
      if (config.accountLogin) {
        registerJsonRoute(
          `${config.routePath}/login`,
          async (req) => {
            if (req.method === 'GET') {
              return { ok: true, info: await describeInfo(), login: auth.status() }
            }
            if (req.method !== 'POST') {
              return { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET or POST only' } }
            }
            let body = {}
            try {
              body = await readJsonBody(req)
            } catch (error) {
              return { ok: false, error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'invalid body' } }
            }
            if (body.cancel === true) {
              auth.reset()
            } else if (body.captchaOnly === true) {
              await auth.captcha()
            } else if (body.action === 'send-code') {
              await auth.sendCode({ phone: typeof body.phone === 'string' ? body.phone : '' })
            } else {
              // Credentials are used for this request only; they are never stored.
              await auth.login({
                mode: body.mode === 'password' ? 'password' : 'sms',
                phone: typeof body.phone === 'string' ? body.phone : '',
                code: typeof body.code === 'string' ? body.code : '',
                username: typeof body.username === 'string' ? body.username : '',
                password: typeof body.password === 'string' ? body.password : '',
                captcha: typeof body.captcha === 'string' ? body.captcha : undefined,
              })
            }
            return { ok: true, info: await describeInfo(), login: auth.status() }
          },
          `webServer.register(${config.routePath}/login)`,
        )
      }
    })
  }

  // ---- 模型工具：让模型自己回答"还剩多少额度" ----
  if (config.tool) {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register({
        name: 'get_scnet_plan',
        description:
          'Read the SCNet (超算互联网) Token Plan of the configured credential: monthly Credits granted/used/remaining, plan tier, validity window, and covered models. Use it when the user asks about remaining credits, quota, 套餐余量, or whether the plan is running out.',
        // 这个工具没有入参，但 parameters 必须是一个完整的 JSON Schema：
        // 写成 `{}` 会缺少 `type`，DeepSeek 等上游会按 `type: null` 拒绝整个请求
        // （Invalid schema for function 'get_scnet_plan'），而不是在调用时才报错。
        parameters: {
          type: 'object',
          properties: {},
        },
        output: {
          schema: planToolSchema,
          render: (_args, value) => [{ type: 'text', text: formatPlan(value) }],
        },
        timeoutMs: Math.max(5_000, config.requestTimeoutMs + 5_000),
        isConcurrencySafe: () => true,
        presentCall: () => ({ card: 'generic', title: 'SCNet Token Plan', kind: 'read' }),
        async execute(_args, exec) {
          const info = await describeInfo()
          const { snapshot, failure } = await service.read({ signal: exec?.signal })
          if (snapshot === null) {
            return {
              ok: false,
              error: failure?.message ?? 'SCNet Token Plan is unavailable',
              code: failure?.code ?? 'UNKNOWN',
              keyConfigured: info.keyConfigured,
              needsCookie: !info.consoleCookieConfigured,
            }
          }
          return {
            ok: failure === null,
            planName: snapshot.planName,
            status: snapshot.status,
            totalCredits: snapshot.totalCredits,
            usedCredits: snapshot.usedCredits,
            remainingCredits: snapshot.remainingCredits,
            usedPercent: usedPercentOf(snapshot),
            remainingDays: snapshot.remainingDays ?? null,
            usage:
              snapshot.usage === null || snapshot.usage === undefined
                ? null
                : {
                    credits: snapshot.usage.totals.credits,
                    inputTokens: snapshot.usage.totals.inputTokens,
                    cachedTokens: snapshot.usage.totals.cachedTokens,
                    outputTokens: snapshot.usage.totals.outputTokens,
                    dailyAverage: snapshot.usage.dailyAverage,
                    peakCredits: snapshot.usage.peak?.credits ?? null,
                  },
            resetAt: snapshot.resetAt ?? null,
            expiresAt: snapshot.expiresAt ?? null,
            periodStart: snapshot.periodStart ?? null,
            catalog: Array.isArray(snapshot.catalog)
              ? snapshot.catalog.map((tier) => ({ name: tier.name, code: tier.code, creditsPerMonth: tier.creditsPerMonth }))
              : [],
            models: config.includeModels ? (snapshot.models ?? []).map((model) => model.id ?? String(model)) : [],
            source: snapshot.source,
            fetchedAt: snapshot.fetchedAt,
            stale: failure !== null,
            needsCookie: snapshot.needsCookie === true,
            error: failure?.message ?? null,
            keyConfigured: info.keyConfigured,
          }
        },
      })
    })
  }

  // ---- settings：自己带页面（settings.section），不让 Settings 再自动生成一张表单 ----
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      if (typeof settingsCtx.settings?.configure === 'function') {
        settingsCtx.effect(
          () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
          'scnet-plan: settings presentation',
        )
      }
      // 部分构建提供 settings.register(ns, schema) 命名空间注册；有就注册空命名空间让插件卡片有归属。
      if (typeof settingsCtx.settings?.register === 'function') {
        settingsCtx.settings.register(
          'scnet-plan',
          Schema.object({}).description('SCNet 套餐监控 — 凭据、Cookie 与刷新间隔在 profile 的 cordis.patch.yml 里配置。'),
        )
      }
    } catch (error) {
      ctx.logger?.warn?.(`scnet-plan: settings registration skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * 把用户从浏览器复制的 Cookie 规整成请求头值：接受整行 `Cookie: a=b; c=d`，
 * 去掉前缀和换行，拒绝明显不是 Cookie 的内容。
 * @param {string} raw - pasted text.
 * @returns {string} header value.
 */
function normalizeCookie(raw) {
  let value = raw.replace(/\r?\n/g, ' ').trim()
  if (/^cookie\s*:/i.test(value)) value = value.replace(/^cookie\s*:/i, '').trim()
  if (value.length > 4096) throw new Error('Cookie 长度超出上限')
  if (!/=/.test(value)) throw new Error('Cookie 里没有 "name=value" 对，请复制浏览器请求头里的完整 Cookie')
  return value
}

/** 供测试与诊断使用：确认某个引用是否已配置。 */
export async function credentialStatus(ctx, ref) {
  const value = await resolveCredential(ctx, ref)
  return { configured: value !== undefined }
}
