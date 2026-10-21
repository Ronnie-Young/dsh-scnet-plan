/**
 * SCNet Token Plan data sources.
 *
 * What can and cannot be read with the API key alone (verified against the
 * live service in Oct 2026):
 *
 *   - `GET {base}/api/llm/v1/models` (Bearer sk-…)      → public model list.
 *   - `GET {base}/acx/llm/api/package/overview`         → public plan catalog
 *     (`?packageType=TokenPlan`): 4 tiers, monthly Credits and covered models.
 *   - `GET {base}/acx/charge/account/currentuser/tokenplan/list`
 *                                                       → the signed-in user's
 *     subscriptions (granted/used Credits, validity window). Session-cookie
 *     gated: an API key cannot read it, and SCNet documents no public usage API.
 *
 * So a full balance needs the scnet.cn console cookie. Without it the snapshot
 * still carries the public catalog and `needsCookie: true`, which the UI turns
 * into an actionable hint instead of an empty error.
 *
 * @module dsh-scnet-plan/lib/scnet-api
 */

/** Error with a stable code and an actionable hint for the Web UI. */
export class PlanSourceError extends Error {
  /**
   * @param {string} code - MISSING_KEY | SESSION_REQUIRED | NETWORK | BAD_RESPONSE | HTTP_ERROR | UNKNOWN.
   * @param {string} message - human text.
   * @param {{ hint?: string, status?: number }} [extra] - optional detail.
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'PlanSourceError'
    this.code = code
    if (extra.hint !== undefined) this.hint = extra.hint
    if (extra.status !== undefined) this.status = extra.status
  }
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** Console SPA sends this header on every /acx request. */
const CONSOLE_VERSION = '2.9.2'

/** Catalog is a public, slow-changing document; keep it for an hour. */
const CATALOG_TTL_MS = 60 * 60 * 1000
/** @type {{ at: number, items: object[] } | null} */
let catalogCache = null

/**
 * Read one secret through the dsh credential seam, falling back to the
 * launching environment. The value never leaves the Host.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} ref - credential reference (POSIX identifier).
 * @returns {Promise<string | undefined>} the secret, when configured.
 */
export async function resolveCredential(ctx, ref) {
  if (ref === '') return undefined
  try {
    const credentials = ctx.get?.('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(ref)
      const value = hit?.value
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    // Fall through to the ambient environment; a missing seam is not fatal.
  }
  const ambient = process.env[ref]
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
}

/**
 * Whether one reference is configured, without reading its value.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} ref - credential reference.
 * @returns {Promise<{ configured: boolean, source?: string }>} presence only.
 */
export async function describeCredential(ctx, ref) {
  if (ref === '') return { configured: false }
  try {
    const credentials = ctx.get?.('credentials')
    if (credentials !== undefined && typeof credentials.describe === 'function') {
      const info = await credentials.describe(ref)
      if (info !== undefined && info !== null) {
        const configured = info.configured === true
        return { configured, ...(configured && typeof info.source === 'string' ? { source: info.source } : {}) }
      }
    }
  } catch {
    // Fall through to the environment check.
  }
  return { configured: typeof process.env[ref] === 'string' && process.env[ref].length > 0 }
}

/**
 * `fetch` with a JSON contract, normalizing HTTP failures into PlanSourceError.
 * @param {string} url - absolute URL.
 * @param {RequestInit & { timeoutLabel?: string }} init - fetch options.
 * @returns {Promise<unknown>} parsed JSON body.
 */
async function getJson(url, init) {
  let response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new PlanSourceError('NETWORK', `无法连接 SCNet：${error instanceof Error ? error.message : String(error)}`, {
      hint: '检查网络后点击刷新重试。',
    })
  }
  const text = await response.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    throw new PlanSourceError('BAD_RESPONSE', `SCNet 返回了非 JSON 响应（HTTP ${response.status}）`, {
      status: response.status,
    })
  }
  if (!response.ok) {
    // The console gateway uses HTTP 401 for an expired session (and also returns
    // 200 + {code:"401"} sometimes); both must read as "re-login", not as a
    // generic transport failure.
    if (response.status === 401) {
      throw new PlanSourceError('SESSION_REQUIRED', 'SCNet 控制台登录态已失效（HTTP 401）', {
        status: 401,
        hint: '在浏览器登录 www.scnet.cn 后重新复制控制台 Cookie，保存到「设置 → SCNet 套餐」。',
      })
    }
    if (response.status === 403) {
      throw new PlanSourceError('AUTH', 'SCNet 拒绝了这次请求（HTTP 403）', {
        status: 403,
        hint: '确认该账号已订阅 Token Plan；套餐到期后 API Key 会失效。',
      })
    }
    throw new PlanSourceError('HTTP_ERROR', `SCNet 返回 HTTP ${response.status}`, { status: response.status })
  }
  return body
}

/**
 * Unwrap the console envelope `{ code, msg, data }`; `401` becomes a session error.
 * @param {unknown} body - parsed console response.
 * @param {string} what - operation label for diagnostics.
 * @returns {unknown} the `data` payload.
 */
function unwrapConsole(body, what) {
  if (body === null || typeof body !== 'object') {
    throw new PlanSourceError('BAD_RESPONSE', `SCNet ${what}返回为空`)
  }
  const envelope = /** @type {Record<string, unknown>} */ (body)
  const code = envelope.code === undefined ? '0' : String(envelope.code)
  if (code === '401') {
    throw new PlanSourceError('SESSION_REQUIRED', 'SCNet 控制台登录态已失效（用户未登录）', {
      hint: '在浏览器登录 www.scnet.cn 后重新复制控制台 Cookie，保存到「设置 → SCNet 套餐」。',
    })
  }
  if (code !== '0' && code !== '200') {
    throw new PlanSourceError('BAD_RESPONSE', `SCNet ${what}失败：${String(envelope.msg ?? code)}`)
  }
  return envelope.data
}

/** Coerce one value into a finite number or null. */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Coerce one value into a non-empty trimmed string or null. */
function toText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * The console (`/acx`) origin. SCNet splits its surfaces: the OpenAI-compatible
 * gateway answers on `api.scnet.cn`, while the console pages and their `/acx`
 * APIs answer on `www.scnet.cn` (the API host returns a JSON 404 for /acx).
 * `consoleBaseUrl` config wins; otherwise a gateway host is rewritten to
 * `www.scnet.cn` so the default config works out of the box.
 * @param {object} config - resolved plugin config.
 * @returns {string} origin without a trailing slash.
 */
export function consoleOrigin(config) {
  const explicit = typeof config.consoleBaseUrl === 'string' ? config.consoleBaseUrl.trim() : ''
  if (explicit !== '') return explicit.replace(/\/+$/, '')
  try {
    const url = new URL(config.baseUrl)
    if (url.hostname.startsWith('api.')) return `https://www.${url.hostname.slice(4)}`
    return url.origin
  } catch {
    return 'https://www.scnet.cn'
  }
}

/**
 * Read the public TokenPlan catalog (cached for an hour).
 * @param {object} options - fetch wiring.
 * @param {string} options.baseUrl - site origin, e.g. https://api.scnet.cn.
 * @param {AbortSignal} options.signal - cancellation.
 * @returns {Promise<object[]>} normalized catalog tiers.
 */
async function fetchCatalog({ baseUrl, signal }) {
  if (catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.items
  const url = `${baseUrl.replace(/\/+$/, '')}/acx/llm/api/package/overview?packageType=TokenPlan`
  const body = await getJson(url, { signal })
  const data = unwrapConsole(body, '套餐目录')
  const list = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : []
  const items = list.map((item) => {
    const credits = toNumber(item?.request?.[0]?.limit)
    const models = toText(item?.models)
    return {
      code: toText(item?.code),
      name: toText(item?.name) ?? toText(item?.code) ?? 'TokenPlan',
      description: toText(item?.description) ?? null,
      creditsPerMonth: credits,
      period: toText(item?.request?.[0]?.unit) ?? 'month',
      models: models === null ? [] : models.split(',').map((name) => name.trim()).filter(Boolean),
      regularPrice: toNumber(item?.regularPrice),
      salePrice: toNumber(item?.contractPrice),
      saleStatus: item?.saleStatus === true,
    }
  })
  catalogCache = { at: Date.now(), items }
  return items
}

/**
 * Read the signed-in user's TokenPlan subscriptions with the console cookie.
 * The response shape is undocumentend and has changed across console releases,
 * so this maps a superset of field names.
 * @param {object} options - fetch wiring.
 * @param {string} options.baseUrl - site origin.
 * @param {string} options.cookie - raw Cookie header value.
 * @param {AbortSignal} options.signal - cancellation.
 * @returns {Promise<object[]>} normalized subscriptions.
 */
async function fetchSubscriptions({ baseUrl, cookie, signal }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/acx/charge/account/currentuser/tokenplan/list`
  const body = await getJson(url, {
    signal,
    headers: {
      Cookie: cookie,
      Referer: `${baseUrl.replace(/\/+$/, '')}/ui/console/`,
      version: CONSOLE_VERSION,
    },
  })
  const data = unwrapConsole(body, '套餐订阅')
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.records)
        ? data.records
        : Array.isArray(data?.list)
          ? data.list
          : Array.isArray(data?.rows)
            ? data.rows
            : Array.isArray(data?.date)
              ? data.date
              : data === null || typeof data !== 'object'
                ? []
                : [data]
  return rows.map((row) => {
    const percentRaw =
      toNumber(row?.percent) ?? toNumber(row?.usagePercent) ?? toNumber(row?.usedPercent) ?? toNumber(row?.rate) ?? null
    // The console itself treats 0 < p ≤ 1 as a fraction (source: normalizePercent).
    const percent = percentRaw !== null && percentRaw > 0 && percentRaw <= 1 ? percentRaw * 100 : percentRaw
    return {
      resourceId: toText(row?.resourceId) ?? toText(row?.code) ?? toText(row?.packageCode) ?? null,
      resourceAccountId: toText(row?.resourceAccountId) ?? null,
      planName: toText(row?.name) ?? toText(row?.resourceName) ?? toText(row?.packageName) ?? toText(row?.planName) ?? null,
      planCredits:
        toNumber(row?.totalAmount) ??
        toNumber(row?.All) ??
        toNumber(row?.totalCredits) ??
        toNumber(row?.monthlyCredits) ??
        toNumber(row?.planCredits) ??
        toNumber(row?.creditQuota) ??
        toNumber(row?.quota) ??
        toNumber(row?.limit) ??
        toNumber(row?.total) ??
        null,
      usedCredits:
        toNumber(row?.usedAmount) ??
        toNumber(row?.used) ??
        toNumber(row?.usedCredits) ??
        toNumber(row?.consumeCredits) ??
        toNumber(row?.consumedCredits) ??
        toNumber(row?.consume) ??
        toNumber(row?.usage) ??
        null,
      remainingCredits:
        toNumber(row?.remainingCredits) ??
        toNumber(row?.remainCredits) ??
        toNumber(row?.leftCredits) ??
        toNumber(row?.remaining) ??
        toNumber(row?.remain) ??
        null,
      percent,
      startAt: toText(row?.minValidTime) ?? toText(row?.startTime) ?? toText(row?.validTime) ?? null,
      endAt: toText(row?.maxExpireTime) ?? toText(row?.expireTime) ?? toText(row?.endTime) ?? null,
      resetAt:
        toText(row?.resetTime) ?? toText(row?.resetAt) ?? toText(row?.nextResetTime) ?? toText(row?.monthResetTime) ?? null,
      statusText: toText(row?.status) ?? toText(row?.statusText) ?? null,
      totalDays: toNumber(row?.totalDays),
      raw: row,
    }
  })
}

/** Headers the console SPA sends on /acx requests. */
function consoleHeaders(cookie, extra = {}) {
  return {
    Cookie: cookie,
    Referer: 'https://www.scnet.cn/ui/console/',
    version: CONSOLE_VERSION,
    ...extra,
  }
}

/**
 * The billing/team account id used by the usage endpoint. It is not the user
 * id: the console keeps it on `cluster-user-detail`, and the Token Plan page
 * passes it as `accountId` when querying daily usage.
 * @type {{ at: number, accountId: string } | null}
 */
let accountCache = null

/**
 * Resolve the team account id, cached for 30 minutes.
 * @param {object} options - fetch wiring.
 * @param {string} options.baseUrl - console origin.
 * @param {string} options.cookie - console session.
 * @param {AbortSignal} options.signal - cancellation.
 * @returns {Promise<string>} account id.
 */
async function fetchAccountId({ baseUrl, cookie, signal }) {
  if (accountCache !== null && Date.now() - accountCache.at < 30 * 60 * 1000) return accountCache.accountId
  const body = await getJson(`${baseUrl}/acx/user/users/cluster-user-detail`, { signal, headers: consoleHeaders(cookie) })
  let data
  try {
    data = unwrapConsole(body, '账户信息')
  } catch (error) {
    if (error?.code === 'SESSION_REQUIRED') accountCache = null
    throw error
  }
  const record = Array.isArray(data) ? data[0] : data
  const accountId = toText(record?.accountId) ?? toText(record?.teamAccountId) ?? ''
  if (accountId === '') throw new PlanSourceError('BAD_RESPONSE', 'SCNet 没有返回团队账户 ID，无法查询每日用量')
  accountCache = { at: Date.now(), accountId }
  return accountId
}

/**
 * Daily Credits + token breakdown for the subscription window.
 * @param {object} options - fetch wiring.
 * @param {string} options.baseUrl - console origin.
 * @param {string} options.cookie - console session.
 * @param {string} options.accountId - team account id.
 * @param {string} options.resourceAccountId - subscription resource account.
 * @param {string} options.startTime - YYYY-MM-DD HH:mm:ss.
 * @param {string} options.endTime - YYYY-MM-DD HH:mm:ss.
 * @param {AbortSignal} options.signal - cancellation.
 * @returns {Promise<object[]>} rows `{ date, credits, inputTokens, cachedTokens, outputTokens }`.
 */
async function fetchUsage({ baseUrl, cookie, accountId, resourceAccountId, startTime, endTime, signal }) {
  const body = await getJson(`${baseUrl}/acx/charge/consume-query/resource-usage`, {
    method: 'POST',
    signal,
    headers: consoleHeaders(cookie, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ accountId, resourceAccountId, startTime, endTime }),
  })
  const data = unwrapConsole(body, '每日用量')
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.records)
      ? data.records
      : Array.isArray(data?.list)
        ? data.list
        : []
  return rows
    .map((row) => ({
      date: toText(row?.date) ?? '',
      credits: toNumber(row?.sumUsage) ?? 0,
      inputTokens: toNumber(row?.inputTokens) ?? 0,
      cachedTokens: toNumber(row?.cachedTokens) ?? 0,
      outputTokens: toNumber(row?.outputTokens) ?? 0,
      chargeItem: toText(row?.chargeItem) ?? '',
    }))
    .filter((row) => row.date !== '')
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Per-model Credits prices from the console (Credits per 1K tokens).
 * Requires the console session. Failure is non-fatal: the client falls back
 * to its configured default rates.
 * @param {object} options - fetch wiring.
 * @param {string} options.baseUrl - console origin.
 * @param {string} options.cookie - console session.
 * @param {AbortSignal} options.signal - cancellation.
 * @returns {Promise<Record<string, { input: number, cached: number, output: number }>>} rate map.
 */
async function fetchModelRates({ baseUrl, cookie, signal }) {
  const body = await getJson(`${baseUrl}/acx/llm/api/console/model`, { signal, headers: consoleHeaders(cookie) })
  const data = unwrapConsole(body, '模型单价')
  const rows = Array.isArray(data) ? data : []
  const rates = {}
  for (const row of rows) {
    const name = toText(row?.modelName) ?? toText(row?.displayName)
    if (name === null) continue
    const input = toNumber(row?.inputPrice)
    const output = toNumber(row?.outputPrice)
    const cached = toNumber(row?.cachedPrice)
    if (input === null && output === null) continue
    rates[name] = {
      input: input ?? 0,
      output: output ?? 0,
      cached: cached ?? input ?? 0,
    }
  }
  return rates
}

/**
 * Pick the subscription the page shows: living first, else the latest one.
 * @param {object[]} subscriptions - normalized rows.
 * @returns {object | null} the current subscription.
 */
function selectCurrent(subscriptions) {
  const timestamp = (value) => {
    if (typeof value !== 'string') return 0
    const parsed = Date.parse(value.replace(' ', 'T'))
    return Number.isFinite(parsed) ? parsed : 0
  }
  const now = Date.now()
  const ordered = [...subscriptions].sort((a, b) => timestamp(b.endAt) - timestamp(a.endAt))
  const living = (item) => {
    const status = String(item.statusText ?? '').toLowerCase()
    if (status === 'disable' || status === 'disabled' || status === 'expired') return false
    if (item.totalDays !== null && item.totalDays !== undefined && item.totalDays <= 0) return false
    return timestamp(item.endAt) === 0 || timestamp(item.endAt) > now
  }
  return { current: ordered.find(living) ?? ordered[0] ?? null, ordered, timestamp }
}

/**
 * Build the normalized snapshot shown by the panel, chip and tool.
 * @param {object} options - parts.
 * @param {object[]} options.subscriptions - normalized subscriptions.
 * @param {object[]} options.catalog - normalized catalog.
 * @param {Array<{ id: string }>} options.models - gateway model list.
 * @param {string} options.source - adapter that answered.
 * @param {boolean} options.needsCookie - whether a cookie would unlock usage.
 * @returns {object} the snapshot.
 */
function buildSnapshot({ subscriptions, catalog, models, source, needsCookie, usage = null }) {
  const now = Date.now()
  const { current, ordered, timestamp } = selectCurrent(subscriptions)

  const catalogMatch =
    current === null
      ? null
      : catalog.find((tier) => tier.code !== null && String(tier.code) === String(current.resourceId)) ?? null

  const totalCredits = current?.planCredits ?? catalogMatch?.creditsPerMonth ?? null
  let usedCredits = current?.usedCredits ?? null
  let remainingCredits = current?.remainingCredits ?? null
  if (usedCredits === null && remainingCredits !== null && totalCredits !== null) usedCredits = totalCredits - remainingCredits
  if (remainingCredits === null && usedCredits !== null && totalCredits !== null) remainingCredits = totalCredits - usedCredits
  if (usedCredits === null && current?.percent !== null && current?.percent !== undefined && totalCredits !== null) {
    usedCredits = (current.percent / 100) * totalCredits
  }
  let usedPercent = current?.percent ?? null
  if (usedPercent === null && totalCredits !== null && totalCredits > 0 && usedCredits !== null) usedPercent = (usedCredits / totalCredits) * 100
  if (usedPercent !== null) usedPercent = Math.max(0, Math.min(100, usedPercent))

  const expired = current !== null && timestamp(current.endAt) > 0 && timestamp(current.endAt) <= now
  const exhausted = totalCredits !== null && usedCredits !== null && usedCredits >= totalCredits
  const status = current === null ? 'unknown' : expired ? 'expired' : exhausted ? 'exhausted' : 'active'

  const planName =
    current?.planName ??
    catalogMatch?.name ??
    (needsCookie ? 'Token Plan（未连接控制台）' : 'Token Plan')

  const coveredModels =
    catalogMatch !== null && catalogMatch.models.length > 0
      ? catalogMatch.models.map((id) => ({ id }))
      : (models ?? []).map((model) => ({ id: model.id ?? String(model) }))

  const endMs = timestamp(current?.endAt)
  const remainingDays = endMs > 0 ? Math.max(0, Math.ceil((endMs - now) / 86_400_000)) : null
  const scopeDays = current?.totalDays ?? (current?.startAt && current?.endAt ? Math.max(1, Math.round((endMs - timestamp(current.startAt)) / 86_400_000)) : null)

  let usageSummary = null
  if (Array.isArray(usage) && usage.length > 0) {
    const totals = usage.reduce(
      (acc, row) => ({
        credits: acc.credits + (row.credits || 0),
        inputTokens: acc.inputTokens + (row.inputTokens || 0),
        cachedTokens: acc.cachedTokens + (row.cachedTokens || 0),
        outputTokens: acc.outputTokens + (row.outputTokens || 0),
      }),
      { credits: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
    )
    const peakRow = usage.reduce((best, row) => (row.credits > (best?.credits ?? 0) ? row : best), null)
    const firstDay = Date.parse(`${usage[0].date}T00:00:00`)
    const elapsedDays = Number.isFinite(firstDay)
      ? Math.max(1, Math.ceil((Math.min(now, endMs || now) - firstDay) / 86_400_000))
      : usage.length
    usageSummary = {
      totals,
      daily: usage,
      days: usage.length,
      peak: peakRow === null ? null : { date: peakRow.date, credits: peakRow.credits },
      dailyAverage: totals.credits / Math.max(1, elapsedDays),
      maxDayCredits: peakRow?.credits ?? 0,
    }
  }

  return {
    planName,
    planCode: current?.resourceId ?? catalogMatch?.code ?? null,
    status,
    unit: 'credits',
    totalCredits,
    usedCredits,
    remainingCredits,
    usedPercent,
    remainingDays,
    scopeDays,
    periodStart: current?.startAt ?? null,
    periodEnd: current?.endAt ?? null,
    resetAt: current?.resetAt ?? current?.endAt ?? null,
    expiresAt: current?.endAt ?? null,
    usage: usageSummary,
    models: coveredModels,
    catalog,
    subscriptions: ordered.map((item) => ({
      planName: item.planName,
      planCode: item.resourceId,
      statusText: item.statusText,
      totalCredits: item.planCredits,
      usedCredits: item.usedCredits,
      remainingCredits: item.remainingCredits,
      percent: item.percent,
      startAt: item.startAt,
      endAt: item.endAt,
      resetAt: item.resetAt,
    })),
    source,
    needsCookie,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Fetch one plan snapshot.
 *
 * Order: console cookie (real usage) → public catalog only (usage locked).
 * A missing API key is only fatal when the catalog itself cannot be read.
 *
 * @param {object} options - wiring.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context.
 * @param {object} options.config - resolved plugin config.
 * @param {AbortSignal} options.signal - cancellation.
 * @returns {Promise<object>} normalized snapshot; throws PlanSourceError when nothing readable.
 */
export async function fetchPlan({ ctx, config, signal }) {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const consoleBase = consoleOrigin(config)
  const cookie = await resolveCredential(ctx, config.consoleCookieEnv)
  const apiKey = await resolveCredential(ctx, config.apiKeyEnv)

  /** Public model list; optional decoration, never fatal. */
  let models = []
  if (config.includeModels && apiKey !== undefined) {
    const candidates = [`${baseUrl}${config.apiBasePath}/models`, `${consoleBase}/acx/llm/v1/models`]
    for (const candidate of candidates) {
      try {
        const body = await getJson(candidate, { signal, headers: { Authorization: `Bearer ${apiKey}` } })
        if (Array.isArray(body?.data)) {
          models = body.data
          break
        }
      } catch {
        // Try the next origin: the gateway and the console host are not interchangeable.
      }
    }
  }

  let catalog = []
  if (config.includeModels || cookie === undefined) {
    catalog = await fetchCatalog({ baseUrl: consoleBase, signal })
  }

  if (cookie !== undefined) {
    const subscriptions = await fetchSubscriptions({ baseUrl: consoleBase, cookie, signal })
    if (subscriptions.length === 0) {
      // Signed in but nothing purchased (or the list shape changed): still
      // return the catalog so the panel can show what is on offer.
      return buildSnapshot({ subscriptions: [], catalog, models, source: 'console', needsCookie: false })
    }

    // Daily usage needs the team account id and the subscription's resource
    // account. It is decoration: a failure must not hide the balance.
    const { current } = selectCurrent(subscriptions)
    let usage = null
    let usageError = null
    if (current !== null && current.resourceAccountId !== null && current.startAt !== null && current.endAt !== null) {
      try {
        const accountId = await fetchAccountId({ baseUrl: consoleBase, cookie, signal })
        usage = await fetchUsage({
          baseUrl: consoleBase,
          cookie,
          accountId,
          resourceAccountId: current.resourceAccountId,
          startTime: current.startAt,
          endTime: current.endAt,
          signal,
        })
      } catch (error) {
        if (error?.code === 'SESSION_REQUIRED') throw error
        usageError = error instanceof Error ? error.message : String(error)
      }
    }
    const snapshot = buildSnapshot({ subscriptions, catalog, models, source: 'console', needsCookie: false, usage })
    if (usageError !== null) snapshot.usageError = usageError

    // Model prices back the client-side Credits estimate for a topic/turn.
    try {
      snapshot.modelRates = await fetchModelRates({ baseUrl: consoleBase, cookie, signal })
    } catch (error) {
      if (error?.code === 'SESSION_REQUIRED') throw error
      snapshot.modelRates = null
    }
    return snapshot
  }

  if (catalog.length === 0 && models.length === 0) {
    throw new PlanSourceError(
      'MISSING_KEY',
      apiKey === undefined ? '未配置 SCNET_API_KEY，且无法读取 SCNet 套餐目录' : 'SCNet 套餐接口没有返回数据',
      { hint: '在 dsh 凭据库保存 SCNET_API_KEY，或在「设置 → SCNet 套餐」里填入控制台 Cookie。' },
    )
  }

  return buildSnapshot({ subscriptions: [], catalog, models, source: 'catalog', needsCookie: true })
}

/**
 * Verify a captured console session before it is stored: the subscription list
 * only answers for a signed-in user, so a successful read is proof the cookies
 * are live. A 401 surfaces as SESSION_REQUIRED from `fetchSubscriptions`.
 *
 * @param {object} options - verification wiring.
 * @param {object} options.config - resolved plugin config.
 * @param {string} options.cookie - Cookie header captured from the login window.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{ ok: true, count: number }>} proof of a live session.
 */
export async function verifyConsoleCookie({ config, cookie, signal }) {
  const subscriptions = await fetchSubscriptions({ baseUrl: consoleOrigin(config), cookie, signal })
  return { ok: true, count: subscriptions.length }
}

