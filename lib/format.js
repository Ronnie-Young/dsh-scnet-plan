/**
 * Model-facing schema and text rendering for the SCNet Token Plan tool.
 *
 * The unit is Credits (SCNet's Token Plan is a monthly Credits quota that
 * tokens are converted into), not raw tokens.
 *
 * @module dsh-scnet-plan/lib/format
 */

/** Output schema of `get_scnet_plan`; every field is optional except `ok`. */
export const planToolSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the reading is current (false when the last refresh failed).' },
    planName: { type: 'string', description: 'Plan tier name (基础版/标准版/高级版/旗舰版).' },
    status: { type: 'string', description: 'active | expired | exhausted | unknown.' },
    totalCredits: { type: 'number', description: 'Credits granted for the current period.' },
    usedCredits: { type: 'number', description: 'Credits consumed in the current period.' },
    remainingCredits: { type: 'number', description: 'Credits left in the current period.' },
    usedPercent: { type: 'number', description: 'Consumed share of the grant, 0-100.' },
    remainingDays: { type: 'number', description: 'Days left until the subscription ends.' },
    usage: {
      type: 'object',
      properties: {
        credits: { type: 'number', description: 'Credits consumed across the plan period.' },
        inputTokens: { type: 'number', description: 'Input tokens billed in the period.' },
        cachedTokens: { type: 'number', description: 'Cache-hit input tokens (reported separately by SCNet).' },
        outputTokens: { type: 'number', description: 'Output tokens billed in the period.' },
        dailyAverage: { type: 'number', description: 'Average Credits per elapsed day.' },
        peakCredits: { type: 'number', description: 'Highest Credits spent in a single day.' },
      },
    },
    periodStart: { type: 'string', description: 'ISO timestamp the subscription started.' },
    resetAt: { type: 'string', description: 'ISO timestamp the quota resets / the subscription ends.' },
    expiresAt: { type: 'string', description: 'ISO timestamp the plan expires.' },
    catalog: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          code: { type: 'string' },
          creditsPerMonth: { type: 'number' },
        },
      },
      description: 'Public plan tiers and their monthly Credits.',
    },
    models: { type: 'array', items: { type: 'string' }, description: 'Model ids covered by the plan.' },
    source: { type: 'string', description: 'console | catalog.' },
    fetchedAt: { type: 'string', description: 'ISO timestamp of the successful read.' },
    stale: { type: 'boolean', description: 'True when the numbers are the last successful reading.' },
    needsCookie: { type: 'boolean', description: 'True when the scnet.cn console Cookie is missing, so usage cannot be read.' },
    error: { type: 'string', description: 'Failure message when the last refresh failed.' },
    keyConfigured: { type: 'boolean', description: 'Whether the SCNet credential reference resolved.' },
  },
  required: ['ok'],
}

/** Format a number with separators; `undefined` reads as an em dash. */
function num(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

/** ISO date → YYYY-MM-DD, tolerating full timestamps. */
function day(value) {
  if (typeof value !== 'string' || value.length === 0) return '—'
  return value.slice(0, 10)
}

/**
 * Human-readable, model-visible summary of one plan reading.
 * @param {Record<string, unknown>} value - tool result value.
 * @returns {string} plain text lines with stable labels.
 */
export function formatPlan(value) {
  const lines = []
  const status = typeof value.status === 'string' ? value.status : 'unknown'
  const name = typeof value.planName === 'string' && value.planName.length > 0 ? value.planName : 'SCNet Token Plan'
  lines.push(`Plan: ${name} (${status})`)
  if (Number.isFinite(value.totalCredits) || Number.isFinite(value.usedCredits) || Number.isFinite(value.remainingCredits)) {
    lines.push(`Credits granted: ${num(value.totalCredits)}`)
    lines.push(`Credits used: ${num(value.usedCredits)}${Number.isFinite(value.usedPercent) ? ` (${Number(value.usedPercent).toFixed(1)}%)` : ''}`)
    lines.push(`Credits remaining: ${num(value.remainingCredits)}`)
    if (typeof value.periodStart === 'string' && value.periodStart.length > 0) lines.push(`Period from: ${day(value.periodStart)}`)
    if (typeof value.resetAt === 'string' && value.resetAt.length > 0) lines.push(`Resets / ends: ${day(value.resetAt)}`)
    if (Number.isFinite(value.remainingDays)) lines.push(`Days left: ${Math.round(value.remainingDays)}`)
  } else if (value.needsCookie === true) {
    lines.push('Credits: unavailable — the scnet.cn console Cookie is not configured, and SCNet exposes no public usage API.')
    lines.push('Tell the user to open Settings → SCNet plan and paste the console Cookie to enable balance monitoring.')
  }
  if (value.usage !== null && typeof value.usage === 'object') {
    const usage = value.usage
    lines.push(
      `Period usage: ${num(usage.credits)} Credits · input ${num(usage.inputTokens)} · cached ${num(usage.cachedTokens)} · output ${num(usage.outputTokens)} tokens`,
    )
    if (Number.isFinite(usage.dailyAverage)) lines.push(`Daily average: ${num(usage.dailyAverage)} Credits`)
    if (Number.isFinite(usage.peakCredits)) lines.push(`Peak day: ${num(usage.peakCredits)} Credits`)
  }
  if (Array.isArray(value.catalog) && value.catalog.length > 0) {
    lines.push('Tiers: ' + value.catalog.map((tier) => `${tier.name} (${num(tier.creditsPerMonth)} Credits/month)`).join(', '))
  }
  if (Array.isArray(value.models) && value.models.length > 0) lines.push(`Models: ${value.models.join(', ')}`)
  if (typeof value.source === 'string') lines.push(`Source: ${value.source}${value.stale === true ? ' (stale)' : ''}`)
  if (typeof value.fetchedAt === 'string') lines.push(`Read at: ${value.fetchedAt}`)
  if (typeof value.error === 'string' && value.error.length > 0) lines.push(`Last refresh failed: ${value.error}`)
  if (value.keyConfigured === false) lines.push('Note: SCNET_API_KEY is not configured; store it in the dsh credential store.')
  return lines.join('\n')
}
