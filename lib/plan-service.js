/**
 * Snapshot cache and single-flight fetcher for the SCNet token plan.
 *
 * The Web panel, the composer chip and the model-facing tool all read the same
 * snapshot. A fetch is shared while it is in flight, kept for `ttlMs`, and a
 * failed refresh never throws away the last good snapshot: callers get it back
 * with `stale: true` plus the error, so the UI can show both numbers and a
 * problem badge.
 *
 * @module dsh-scnet-plan/lib/plan-service
 */

/** @typedef {{ code?: string, message: string, hint?: string, status?: number }} PlanFailure */

/**
 * Turn arbitrary throwables into a PlanFailure without leaking stack traces
 * into the Web UI.
 * @param {unknown} error - whatever the fetcher threw.
 * @returns {PlanFailure} a stable shape for the wire.
 */
export function toFailure(error) {
  if (error !== null && typeof error === 'object') {
    const candidate = /** @type {Record<string, unknown>} */ (error);
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : '读取 SCNet 套餐失败';
    /** @type {PlanFailure} */
    const failure = { message };
    if (typeof candidate.code === 'string') failure.code = candidate.code;
    if (typeof candidate.hint === 'string') failure.hint = candidate.hint;
    if (typeof candidate.status === 'number') failure.status = candidate.status;
    return failure;
  }
  return { message: String(error) };
}

/**
 * @typedef {object} PlanSnapshot
 * @property {string} planName - human plan label, e.g. "SCNet Token 套餐".
 * @property {string} status - "active" | "expired" | "exhausted" | "unknown".
 * @property {number | null} totalTokens - granted tokens for the period.
 * @property {number | null} usedTokens - consumed tokens.
 * @property {number | null} remainingTokens - tokens left.
 * @property {string} unit - display unit, normally "tokens".
 * @property {string | null} periodStart - ISO date, when known.
 * @property {string | null} periodEnd - ISO date, when known.
 * @property {string | null} resetAt - ISO date the quota resets.
 * @property {string | null} expiresAt - ISO date the package expires.
 * @property {Array<{ id: string, name?: string }>} models - models covered.
 * @property {string} source - adapter that produced the snapshot.
 * @property {string} fetchedAt - ISO timestamp of the successful read.
 */

/**
 * @typedef {object} PlanService
 * @property {(options?: { force?: boolean, signal?: AbortSignal }) => Promise<{ snapshot: PlanSnapshot | null, failure: PlanFailure | null }>} read
 * @property {() => { lastSuccessAt: number | null, lastAttemptAt: number | null, failures: number }} stats
 */

/**
 * Create the shared plan snapshot service.
 *
 * @param {object} options - service wiring.
 * @param {(signal: AbortSignal) => Promise<PlanSnapshot>} options.fetchPlan - adapter; resolves a normalized snapshot or throws.
 * @param {() => number} options.ttlMs - current cache lifetime in milliseconds (read per call so config edits apply without a restart).
 * @param {() => number} [options.timeoutMs] - hard per-fetch timeout in milliseconds.
 * @returns {PlanService} the service.
 */
export function createPlanService({ fetchPlan, ttlMs, timeoutMs = () => 20_000 }) {
  /** @type {{ snapshot: PlanSnapshot, at: number } | null} */
  let cache = null;
  /** @type {Promise<{ snapshot: PlanSnapshot | null, failure: PlanFailure | null }> | null} */
  let inflight = null;

  /** @type {{ lastSuccessAt: number | null, lastAttemptAt: number | null, failures: number }} */
  const stats = { lastSuccessAt: null, lastAttemptAt: null, failures: 0 };

  /**
   * One fetch attempt with a hard deadline, independent of the caller signal.
   * @param {AbortSignal | undefined} callerSignal - request cancellation.
   * @returns {Promise<PlanSnapshot>} the normalized snapshot.
   */
  async function attempt(callerSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(new Error('读取 SCNet 套餐超时'));
    }, Math.max(1_000, timeoutMs()));
    try {
      return await fetchPlan(controller.signal);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Read the current snapshot, reusing a fresh cache or the in-flight request.
   * @param {{ force?: boolean, signal?: AbortSignal }} [options] - force skips the TTL; signal cancels this caller.
   * @returns {Promise<{ snapshot: PlanSnapshot | null, failure: PlanFailure | null }>} snapshot, failure, or both when stale.
   */
  async function read(options = {}) {
    const now = Date.now();
    const ttl = Math.max(0, ttlMs());
    if (!options.force && cache !== null && now - cache.at < ttl) {
      return { snapshot: cache.snapshot, failure: null };
    }
    if (inflight !== null) return inflight;

    inflight = (async () => {
      stats.lastAttemptAt = Date.now();
      try {
        const snapshot = await attempt(options.signal);
        const stamped = { ...snapshot, fetchedAt: snapshot.fetchedAt || new Date().toISOString() };
        cache = { snapshot: stamped, at: Date.now() };
        stats.lastSuccessAt = Date.now();
        stats.failures = 0;
        return { snapshot: stamped, failure: null };
      } catch (error) {
        stats.failures += 1;
        const failure = toFailure(error);
        return { snapshot: cache?.snapshot ?? null, failure };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    read,
    stats: () => ({ ...stats }),
    /** Drop the cached snapshot so the next read must hit the network. */
    invalidate: () => {
      cache = null;
    },
  };
}
