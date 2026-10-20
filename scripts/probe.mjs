#!/usr/bin/env node
/**
 * SCNet Token Plan probe — zero-dependency Node ESM (>=18).
 *
 * Two modes:
 *   (a) cookie mode  — --cookie / SCNET_CONSOLE_COOKIE. Calls the console session
 *       endpoint that powers 控制台 → 模型服务 → Token Plan and prints exact
 *       Credits figures: {planName,totalCredits,usedCredits,remainingCredits,
 *       percent,startAt,endAt,subscriptions[]}.
 *   (b) key-only mode — no cookie. Fetches the PUBLIC TokenPlan catalog (no auth),
 *       validates the sk-tp key against the gateway, and prints a SESSION_REQUIRED
 *       diagnostic explaining exactly which numbers cannot be read this way.
 *
 * Optional: --probe sends ONE max_tokens:1 completion to classify plan state
 * (active / quota-exhausted / expired / missing) from the official error codes.
 * Off by default; it costs a negligible number of tokens.
 *
 * Read-only. Never prints the API key or the session cookie.
 *
 * Usage:
 *   node scnet-plan/scripts/probe.mjs
 *   node scnet-plan/scripts/probe.mjs --json
 *   node scnet-plan/scripts/probe.mjs --cookie 'a=b; c=d'
 *   SCNET_CONSOLE_COOKIE='a=b; c=d' node scnet-plan/scripts/probe.mjs --json
 *   node scnet-plan/scripts/probe.mjs --cookie-file ~/scnet-cookie.txt
 *   node scnet-plan/scripts/probe.mjs --probe           # + 1-token state probe
 *   node scnet-plan/scripts/probe.mjs --models          # list gateway models
 *   node scnet-plan/scripts/probe.mjs --self-test       # offline mapping check
 *
 * Exit codes: 0 exact plan data | 2 no key | 3 session required (no/failed cookie)
 *             4 key rejected | 5 network/other
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants (all verified 2026-10-20, see docs/scnet-api.md)
// ---------------------------------------------------------------------------

const GATEWAY = 'https://api.scnet.cn/api/llm/v1';
const CONSOLE = 'https://www.scnet.cn/acx';
const CONSOLE_PAGE = 'https://www.scnet.cn/ui/console/index.html#/llm/token-plan';

const EP_MODELS = `${GATEWAY}/models`;
const EP_CHAT = `${GATEWAY}/chat/completions`;
const EP_CATALOG = `${CONSOLE}/llm/api/package/overview?packageType=TokenPlan`;
const EP_PLAN_LIST = `${CONSOLE}/charge/account/currentuser/tokenplan/list`;
const EP_BALANCE = `${CONSOLE}/charge/account/llmapi/balance`;

const DEFAULT_TIMEOUT = 8000;
const PROBE_MODEL = 'DeepSeek-V4.1-Flash';

// The console SPA identifies itself with these; they do NOT replace a session
// cookie (verified: still 401), but they keep requests shaped like the app's.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';
const CONSOLE_REFERER = 'https://www.scnet.cn/ui/console/';
const CONSOLE_VERSION = '2.9.2';

// Field candidates, taken verbatim from the console bundle's tolerant getters
// (docs/scnet-api.md §2 E4). Order matters: first non-empty wins.
const F = {
  name: ['name', 'resourceName', 'packageName'],
  code: ['resourceId', 'code', 'packageCode'],
  total: ['totalAmount', 'All', 'totalCredits', 'monthlyCredits', 'planCredits', 'creditQuota', 'quota', 'limit', 'total'],
  used: ['usedAmount', 'used', 'usedCredits', 'consumeCredits', 'consumedCredits', 'consume', 'usage'],
  remaining: ['remainingCredits', 'remainCredits', 'leftCredits', 'remaining', 'remain'],
  percent: ['percent', 'usagePercent', 'rate'],
  reset: ['resetTime', 'resetAt', 'nextResetTime', 'monthResetTime'],
  start: ['minValidTime', 'startTime', 'validTime'],
  end: ['maxExpireTime', 'expireTime', 'endTime'],
  status: ['status'],
  totalDays: ['totalDays'],
  currentTime: ['currentTime'],
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    json: false,
    verbose: false,
    probe: false,
    models: false,
    selfTest: false,
    noProbe: false,
    timeout: DEFAULT_TIMEOUT,
    cookie: process.env.SCNET_CONSOLE_COOKIE || process.env.SCNET_COOKIE || '',
    cookieFile: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--json': opts.json = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--probe': opts.probe = true; break;
      case '--no-probe': opts.noProbe = true; opts.probe = false; break; // kept for compatibility
      case '--models': opts.models = true; break;
      case '--self-test': opts.selfTest = true; break;
      case '--cookie': opts.cookie = next(); break;
      case '--cookie-file': opts.cookieFile = next(); break;
      case '--timeout': {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout must be a positive number of ms');
        opts.timeout = n;
        break;
      }
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--cookie=')) { opts.cookie = a.slice('--cookie='.length); break; }
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (opts.cookieFile) opts.cookie = fs.readFileSync(expandHome(opts.cookieFile), 'utf8').trim();
  return opts;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const HELP = `SCNet Token Plan probe (read-only)

  --json              print one JSON object, nothing else
  --cookie <str>      console session cookie ("k=v; k2=v2") -> exact Credits
  --cookie-file <p>   read the cookie from a file (raw Cookie header value)
  --probe             send ONE max_tokens:1 chat request to classify plan state
  --models            include the gateway model list in the human report
  --timeout <ms>      per-request timeout (default ${DEFAULT_TIMEOUT})
  --verbose           log every HTTP attempt to stderr
  --self-test         offline: validate the console-response -> normalized mapping
  -h, --help          this text

Cookie can also come from SCNET_CONSOLE_COOKIE (or SCNET_COOKIE).
Key lookup: env SCNET_API_KEY, else refs.SCNET_API_KEY in ~/.dsh/.credentials.yaml.
Neither the key nor the cookie is ever printed.`;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function loadKey() {
  const fromEnv = (process.env.SCNET_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, origin: 'env SCNET_API_KEY' };

  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(process.cwd(), '.dsh', '.credentials.yaml'),
  ];
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Minimal dependency-free YAML scalar lookup for refs.SCNET_API_KEY.
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) {
        inRefs = /^refs\s*:\s*$/.test(line);
        continue;
      }
      if (!inRefs) continue;
      const m = line.match(/^\s+SCNET_API_KEY\s*:\s*(.+?)\s*$/);
      if (m) {
        let v = m[1];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (v) return { key: v, origin: `${file} (refs.SCNET_API_KEY)` };
      }
    }
  }
  return { key: '', origin: '' };
}

/** Never reveal the secret: only the scheme prefix and the length. */
function describeKey(key) {
  const scheme = key.startsWith('sk-tp-') ? 'sk-tp-' : key.startsWith('sk-') ? 'sk-' : '(unexpected prefix) ';
  return `${scheme}**** (${key.length} chars)`;
}

/** Cookie names only, never values. */
function describeCookie(cookie) {
  if (!cookie) return '(none)';
  const names = cookie.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean);
  return `(${names.length} cookie${names.length === 1 ? '' : 's'}: ${names.join(', ')})`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function request(url, { method = 'GET', key = '', cookie = '', timeout = DEFAULT_TIMEOUT, body, console: isConsole = false } = {}) {
  const headers = { Accept: 'application/json, text/plain, */*', 'User-Agent': BROWSER_UA };
  if (isConsole) {
    headers.Referer = CONSOLE_REFERER;
    headers.version = CONSOLE_VERSION;
    headers.Origin = 'https://www.scnet.cn';
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  if (cookie) headers.Cookie = cookie;

  const init = { method, headers, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
    init.body = JSON.stringify(body);
  }

  const started = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON (HTML 404 pages etc.) */
    }
    return { ok: res.ok, status: res.status, json, text, ms: Date.now() - started, url };
  } catch (err) {
    return { ok: false, status: 0, error: err, json: null, text: '', ms: Date.now() - started, url };
  }
}

const isSessionGate = (r) => r.json && String(r.json.code) === '401' && /用户未登录/.test(String(r.json.msg || ''));
const isHtml404 = (r) => r.status === 404 && /<!DOCTYPE html>/i.test(r.text || '');

// ---------------------------------------------------------------------------
// Normalization (mirrors the console bundle's getters)
// ---------------------------------------------------------------------------

function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

/** "2026-11-18 23:59:59" / epoch / ISO -> ISO8601 in +08:00. */
function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const s = String(v);
    const ms = s.length === 13 ? Number(s) : Number(s) * 1000;
    return cnIso(ms);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const withT = s.replace(' ', 'T');
    return `${/:\d{2}:\d{2}$/.test(withT) ? withT : `${withT}:00`}+08:00`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : cnIso(d);
}

function cnIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
}

/** percent accepts 0..1 or 0..100; else derive from used/total. */
function normalizePercent(rawPercent, used, total) {
  const p = toNumber(rawPercent);
  if (p !== null) {
    const scaled = p > 0 && p <= 1 ? p * 100 : p;
    return Math.min(100, Math.max(0, Math.round(scaled)));
  }
  if (used !== null && total !== null && total > 0) {
    return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  }
  return null;
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

function tierLimit(tier) {
  const req = Array.isArray(tier?.request) ? tier.request : null;
  if (req) {
    const monthly = req.find((r) => String(r?.unit || '').toLowerCase() === 'month') || req[0];
    return toNumber(monthly?.limit ?? monthly?.quota ?? monthly?.amount ?? monthly?.value);
  }
  return toNumber(pick(tier, ['planCredits', 'monthlyCredits', 'credits', 'totalCredits']));
}

function splitModels(tier) {
  const fromList = Array.isArray(tier?.modelContent)
    ? tier.modelContent.map((m) => m?.modelName).filter(Boolean)
    : Array.isArray(tier?.model_content)
      ? tier.model_content.map((m) => m?.modelName).filter(Boolean)
      : [];
  if (fromList.length) return fromList;
  return String(tier?.models || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Envelope: {code,msg,data:[...]} ; tolerate {data:{data|records|list}}, {date:[...]}. */
function unwrapRows(json) {
  let node = json;
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    node = node.data ?? node.date ?? node.records ?? node.list ?? node.rows ?? null;
    if (node && !Array.isArray(node) && typeof node === 'object') {
      node = node.data ?? node.records ?? node.list ?? node.rows ?? null;
    }
  }
  return Array.isArray(node) ? node.filter((r) => r && typeof r === 'object') : [];
}

function deriveStatus(row, total, used) {
  const raw = String(pick(row, F.status, '') || '').trim().toLowerCase();
  const totalDays = toNumber(pick(row, F.totalDays));
  const now = toIso(pick(row, F.currentTime));
  const start = toIso(pick(row, F.start));
  const end = toIso(pick(row, F.end));

  if (totalDays !== null && totalDays <= 0) return { status: 'expired', rawStatus: raw || null };
  if (raw === 'disable') {
    // The bundle treats disable + currentTime < maxExpireTime as "not in effect".
    if (start && now && now < start) return { status: 'pending', rawStatus: raw };
    return { status: 'expired', rawStatus: raw };
  }
  if (total !== null && used !== null && used >= total) return { status: 'exhausted', rawStatus: raw || null };
  if (end && now && now > end) return { status: 'expired', rawStatus: raw || null };
  return { status: 'active', rawStatus: raw || null };
}

function normalizeRow(row, catalog) {
  const code = pick(row, F.code, null);
  const name = pick(row, F.name, null);
  const tier =
    (code && catalog.find((t) => String(t.code) === String(code))) ||
    (name && catalog.find((t) => String(t.name) === String(name))) ||
    null;

  let total = toNumber(pick(row, F.total, null));
  if (total === null && tier) total = tierLimit(tier);
  const used = toNumber(pick(row, F.used, null));
  let remaining = toNumber(pick(row, F.remaining, null));
  if (remaining === null && total !== null && used !== null) remaining = Math.max(total - used, 0);
  if (total === null && remaining !== null && used !== null) total = remaining + used;

  const startAt = toIso(pick(row, F.start, null));
  const endAt = toIso(pick(row, F.end, null));
  const resetRaw = toIso(pick(row, F.reset, null));
  const resetAt = resetRaw || (endAt ? cnIso(new Date(endAt).getTime() + 1000) : null);
  const percent = normalizePercent(pick(row, F.percent, null), used, total);
  const { status, rawStatus } = deriveStatus(row, total, used);

  return {
    planName: name || (tier ? tier.name : code) || null,
    resourceId: code || null,
    status,
    totalCredits: round2(total),
    usedCredits: round2(used),
    remainingCredits: round2(remaining),
    percent,
    startAt,
    endAt,
    resetAt,
    models: tier ? splitModels(tier) : [],
    rawStatus,
    raw: row,
  };
}

function sortSubscriptions(list) {
  const rank = (s) => (s.status === 'active' ? 0 : s.status === 'exhausted' ? 1 : s.status === 'pending' ? 2 : 3);
  return [...list].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return String(b.endAt || '').localeCompare(String(a.endAt || ''));
  });
}

function stripRaw(s) {
  const { raw, ...rest } = s;
  return rest;
}

function emptyPlan(source) {
  return {
    planName: null,
    status: 'unknown',
    totalCredits: null,
    usedCredits: null,
    remainingCredits: null,
    percent: null,
    startAt: null,
    endAt: null,
    resetAt: null,
    subscriptions: [],
    models: [],
    source,
    fetchedAt: new Date().toISOString(),
    unit: 'credits',
    confidence: 'none',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (opts.selfTest) {
    // Synthetic console payload (shape inferred from the console bundle,
    // docs/scnet-api.md §2 E4) — proves the mapping without a session.
    const fake = {
      code: '0',
      msg: 'success',
      data: [
        {
          resourceId: 'TP-Basic-001',
          name: '基础版',
          status: 'enable',
          minValidTime: '2026-10-19 00:00:00',
          maxExpireTime: '2026-11-18 23:59:59',
          totalDays: 30,
          currentTime: '2026-10-20 12:50:00',
          planCredits: 60000,
          usedCredits: 1234.5,
          percent: 0.0206,
        },
        {
          resourceId: 'TP-Standard-001',
          packageName: '标准版',
          status: 'disable',
          maxExpireTime: '2026-09-18 23:59:59',
          totalDays: 0,
          totalAmount: 240000,
          usedAmount: 240000,
          remainingCredits: 0,
        },
      ],
    };
    const catalog = [
      {
        code: 'TP-Basic-001',
        name: '基础版',
        request: [{ time: 1, unit: 'month', limit: 60000 }],
        modelContent: [{ modelName: 'DeepSeek-V4.1-Flash' }],
      },
    ];
    const rows = unwrapRows(fake);
    const subscriptions = sortSubscriptions(rows.map((r) => normalizeRow(r, catalog))).map(stripRaw);
    process.stdout.write(
      `${JSON.stringify({ selfTest: 'normalizeRow', envelopeRows: rows.length, subscriptions }, null, 2)}\n`,
    );
    return 0;
  }

  const log = (msg) => {
    if (opts.verbose) process.stderr.write(`[probe] ${msg}\n`);
  };

  const report = {
    ok: false,
    verifiedAt: new Date().toISOString(),
    key: { present: false, valid: null, shape: null },
    cookie: { present: Boolean(opts.cookie) },
    plan: emptyPlan('none'),
    catalog: [],
    gateway: { models: null },
    probe: null,
    diagnostics: [],
    warnings: [],
  };

  // 1) key -------------------------------------------------------------------
  const { key, origin } = loadKey();
  if (!key) {
    report.diagnostics.push({
      level: 'error',
      code: 'NO_KEY',
      message:
        'No API key found. Set SCNET_API_KEY, or add `refs:` -> `SCNET_API_KEY: <sk-tp-...>` in ~/.dsh/.credentials.yaml.',
    });
    return emit(report, opts, 2);
  }
  report.key.present = true;
  report.key.origin = origin;
  report.key.shape = describeKey(key);
  log(`key: ${describeKey(key)} from ${origin}`);
  if (opts.cookie) log(`cookie: ${describeCookie(opts.cookie)}`);

  // 2) public catalog (no auth at all) ---------------------------------------
  const catalogRes = await request(EP_CATALOG, { timeout: opts.timeout, console: true });
  if (catalogRes.ok && Array.isArray(catalogRes.json?.data)) {
    report.catalog = catalogRes.json.data.map((t) => ({
      code: t.code,
      name: t.name,
      monthlyLimit: tierLimit(t),
      unit: Array.isArray(t.request) ? t.request[0]?.unit : null,
      priceLabel: t.priceLabel ?? null,
      regularPrice: t.regularPrice ?? null,
      models: splitModels(t),
    }));
  } else if (isHtml404(catalogRes)) {
    report.warnings.push({
      code: 'CATALOG_404_HTML',
      message: 'Catalog path returned an HTML 404 — the console API prefix may have changed from /acx.',
    });
  } else {
    report.warnings.push({ code: 'CATALOG_FAILED', message: `Public catalog unavailable (HTTP ${catalogRes.status}).` });
  }
  log(`catalog: HTTP ${catalogRes.status}, ${report.catalog.length} tiers`);

  // 3) gateway: is the key accepted ------------------------------------------
  const modelsRes = await request(EP_MODELS, { key, timeout: opts.timeout });
  if (modelsRes.ok && Array.isArray(modelsRes.json?.data)) {
    report.key.valid = true;
    report.gateway.models = modelsRes.json.data.map((m) => m.id);
    log(`models: HTTP 200, ${report.gateway.models.length} models`);
  } else {
    report.key.valid = false;
    const errMsg =
      modelsRes.json?.error?.message || modelsRes.json?.msg || modelsRes.text?.slice(0, 160) || modelsRes.error?.message || '';
    report.diagnostics.push({
      level: 'error',
      code: modelsRes.status === 0 ? 'NETWORK' : `GATEWAY_${modelsRes.status}`,
      message:
        modelsRes.status === 0
          ? `Cannot reach ${EP_MODELS} (${errMsg}). Check network / proxy.`
          : `Gateway rejected the key: HTTP ${modelsRes.status} ${errMsg}`,
      hint:
        modelsRes.status === 400
          ? 'Authorization must be `Bearer <key>`; X-API-Key is not supported.'
          : modelsRes.status === 401
            ? 'The key is invalid or revoked. Verify it in 控制台 → 模型服务 → API Key.'
            : undefined,
    });
    report.plan.status = modelsRes.status === 401 ? 'invalid-key' : 'unknown';
    report.plan.source = 'gateway';
    return emit(report, opts, modelsRes.status === 0 ? 5 : 4);
  }

  // 4a) cookie mode: exact Credits -------------------------------------------
  let exact = false;
  if (opts.cookie) {
    const planRes = await request(EP_PLAN_LIST, { cookie: opts.cookie, timeout: opts.timeout, console: true });
    log(`tokenplan/list: HTTP ${planRes.status}`);
    if (planRes.ok && planRes.json) {
      const rows = unwrapRows(planRes.json);
      if (rows.length) {
        const subscriptions = sortSubscriptions(rows.map((r) => normalizeRow(r, report.catalog)));
        const best = subscriptions[0];
        const stripped = stripRaw(best);
        report.plan = {
          ...emptyPlan('console-cookie'),
          ...stripped,
          subscriptions: subscriptions.map(stripRaw),
          models: best.models.length ? best.models : report.gateway.models || [],
          fetchedAt: new Date().toISOString(),
          confidence:
            best.totalCredits !== null || best.usedCredits !== null || best.remainingCredits !== null
              ? 'exact'
              : 'partial',
        };
        report.ok = true;
        exact = true;
        report.diagnostics.push({
          level: 'info',
          code: 'PLAN_EXACT',
          message: 'Plan numbers come from the console session (source=console-cookie).',
        });
        if (report.plan.totalCredits === null && report.plan.remainingCredits === null) {
          report.warnings.push({
            code: 'FIELD_NAMES_UNEXPECTED',
            message:
              'No known Credits field was present on the row; inspect plan.subscriptions[].raw to pin the real names.',
          });
        }
      } else {
        report.plan = { ...emptyPlan('console-cookie'), status: 'missing', confidence: 'state-only' };
        report.ok = true;
        exact = true;
        report.warnings.push({
          code: 'PLAN_EMPTY',
          message: 'The session works but returned no Token Plan rows — this account has no active subscription.',
        });
      }
    } else if (isSessionGate(planRes) || planRes.status === 401) {
      report.diagnostics.push({
        level: 'warn',
        code: 'COOKIE_EXPIRED',
        message: 'The supplied console cookie was not accepted (401 用户未登录). Re-copy it from the browser.',
        hint: `Open ${CONSOLE_PAGE} → DevTools → Network → any /acx/* request → copy the whole Cookie header.`,
      });
    } else {
      report.warnings.push({ code: 'PLAN_LIST_FAILED', message: `tokenplan/list failed: HTTP ${planRes.status}` });
    }

    // Cash / free-credit balance: separate service, best effort.
    const balRes = await request(EP_BALANCE, {
      method: 'POST',
      cookie: opts.cookie,
      body: {},
      timeout: opts.timeout,
      console: true,
    });
    if (balRes.ok && balRes.json) {
      report.balance = { raw: balRes.json.data ?? balRes.json };
      log('llmapi/balance: OK');
    } else {
      log(`llmapi/balance: HTTP ${balRes.status}`);
    }
  }

  // 4b) optional state probe -------------------------------------------------
  if (!exact && opts.probe) {
    const chatRes = await request(EP_CHAT, {
      method: 'POST',
      key,
      timeout: opts.timeout,
      body: { model: PROBE_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
    });
    const probe = {
      model: PROBE_MODEL,
      status: chatRes.status,
      outcome: 'unknown',
      usage: chatRes.json?.usage ?? null,
      message: chatRes.json?.error?.message ?? chatRes.json?.msg ?? null,
    };
    if (chatRes.ok) probe.outcome = 'quota-available';
    else if (chatRes.status === 429) probe.outcome = 'quota-exhausted';
    else if (chatRes.status === 403 && /expired/i.test(String(probe.message))) probe.outcome = 'plan-expired';
    else if (chatRes.status === 403 && /missing/i.test(String(probe.message))) probe.outcome = 'plan-missing';
    else if (chatRes.status === 403) probe.outcome = 'model-not-in-plan';
    else if (chatRes.status === 401) probe.outcome = 'key-invalid';
    report.probe = probe;
    log(`probe chat: HTTP ${chatRes.status} → ${probe.outcome}`);

    const statusByOutcome = {
      'quota-available': 'active',
      'quota-exhausted': 'exhausted',
      'plan-expired': 'expired',
      'plan-missing': 'missing',
      'key-invalid': 'invalid-key',
    };
    report.plan.status = statusByOutcome[probe.outcome] || report.plan.status;
    if (probe.outcome === 'quota-exhausted') report.plan.remainingCredits = 0;
    report.plan.source = 'catalog+probe';
    report.plan.confidence = 'state-only';
    report.ok = report.plan.status === 'active' || report.plan.status === 'exhausted';
  }

  // 5) what is missing and why ----------------------------------------------
  if (!exact) {
    report.diagnostics.push({
      level: 'info',
      code: 'SESSION_REQUIRED',
      message:
        'SCNet has no API-key-authenticated endpoint for granted/used/remaining Credits. ' +
        'The numbers only exist behind the logged-in console session.',
      evidence: [
        'GET  /acx/charge/account/currentuser/tokenplan/list → 401 用户未登录 (with or without Bearer key, with version/Referer/UA)',
        'POST /acx/charge/account/llmapi/balance              → 401 用户未登录',
        'GET  /acx/llm/v1/models                              → 200 with Bearer (model list only, no quota)',
        'GET  /api/llm/v1/usage | /quota | /me                → 401 用户未登录',
        'No x-ratelimit-* / x-quota-* headers on /models or /chat/completions',
      ],
    });
    report.diagnostics.push({
      level: 'info',
      code: 'MANUAL_STEP',
      message: `For exact Credits: sign in, open ${CONSOLE_PAGE}, copy the Cookie header, rerun with --cookie '<value>' (or SCNET_CONSOLE_COOKIE).`,
    });
    if (report.plan.source === 'none') {
      report.plan.source = report.catalog.length ? 'catalog-only' : 'none';
      report.plan.confidence = report.catalog.length ? 'catalog' : 'none';
    }
    if (!report.plan.models.length && report.catalog.length) report.plan.models = report.catalog[0].models;
  }

  report.verifiedAt = new Date().toISOString();
  report.plan.fetchedAt = report.verifiedAt;
  return emit(report, opts, exact ? 0 : 3);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fmt(n) {
  if (n === null || n === undefined) return 'n/a';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function human(report, opts = {}) {
  const L = [];
  const p = report.plan;
  L.push('SCNet Token Plan probe');
  L.push('='.repeat(66));
  L.push(`key          : ${report.key.present ? report.key.shape : 'MISSING'}`);
  if (report.key.origin) L.push(`key source   : ${report.key.origin}`);
  L.push(`key valid    : ${report.key.valid === null ? 'unknown' : report.key.valid ? 'yes (GET /models → 200)' : 'NO'}`);
  L.push(`cookie       : ${report.cookie.present ? 'supplied' : 'not supplied'}`);
  L.push(`verified at  : ${report.verifiedAt}`);
  L.push(`mode         : ${report.plan.source}`);
  L.push('');
  L.push('PLAN (normalized, unit = Credits)');
  L.push('-'.repeat(66));
  L.push(`planName        : ${p.planName ?? 'n/a'}`);
  L.push(`status          : ${p.status}`);
  L.push(`totalCredits    : ${fmt(p.totalCredits)}`);
  L.push(`usedCredits     : ${fmt(p.usedCredits)}`);
  L.push(`remainingCredits: ${fmt(p.remainingCredits)}`);
  L.push(`percent         : ${p.percent === null ? 'n/a' : `${p.percent}%`}`);
  L.push(`startAt         : ${p.startAt ?? 'n/a'}`);
  L.push(`endAt           : ${p.endAt ?? 'n/a'}`);
  L.push(`resetAt         : ${p.resetAt ?? 'n/a'}`);
  L.push(
    `models          : ${
      p.models.length ? `${p.models.length} (${p.models.slice(0, 4).join(', ')}${p.models.length > 4 ? ', …' : ''})` : 'n/a'
    }`,
  );
  L.push(`confidence      : ${p.confidence}`);
  if (report.balance) L.push(`balance         : ${JSON.stringify(report.balance.raw).slice(0, 160)}`);
  L.push('');
  if (p.subscriptions && p.subscriptions.length > 1) {
    L.push(`SUBSCRIPTIONS (${p.subscriptions.length})`);
    L.push('-'.repeat(66));
    for (const s of p.subscriptions) {
      L.push(
        `  ${String(s.planName ?? '?').padEnd(10)} ${String(s.status).padEnd(9)} ` +
          `${fmt(s.usedCredits).padStart(9)} / ${fmt(s.totalCredits).padStart(9)} credits` +
          `${s.percent === null ? '' : ` (${s.percent}%)`}  ${s.endAt ?? ''}`,
      );
    }
    L.push('');
  }
  if (report.probe) {
    L.push('STATUS PROBE (1-token chat/completions)');
    L.push('-'.repeat(66));
    L.push(`model   : ${report.probe.model}`);
    L.push(`http    : ${report.probe.status}`);
    L.push(`outcome : ${report.probe.outcome}`);
    if (report.probe.message) L.push(`message : ${report.probe.message}`);
    L.push('');
  }
  if (report.catalog.length) {
    L.push('PUBLIC CATALOG (no auth required)');
    L.push('-'.repeat(66));
    for (const t of report.catalog) {
      L.push(
        `  ${String(t.code).padEnd(18)} ${String(t.name).padEnd(6)} ` +
          `${fmt(t.monthlyLimit).padStart(10)} Credits/${t.unit || 'month'}  ${t.models.length} models`,
      );
    }
    L.push('');
  }
  if (opts.models && report.gateway.models && report.gateway.models.length) {
    L.push(`GATEWAY MODELS (${report.gateway.models.length})`);
    L.push('-'.repeat(66));
    L.push(`  ${report.gateway.models.join(', ')}`);
    L.push('');
  }
  if (report.diagnostics.length) {
    L.push('DIAGNOSTICS');
    L.push('-'.repeat(66));
    for (const d of report.diagnostics) {
      L.push(`[${d.level}] ${d.code}: ${d.message}`);
      if (d.hint) L.push(`        hint: ${d.hint}`);
      if (d.evidence) for (const e of d.evidence) L.push(`        - ${e}`);
    }
    L.push('');
  }
  if (report.warnings.length) {
    L.push('WARNINGS');
    L.push('-'.repeat(66));
    for (const w of report.warnings) L.push(`[warn] ${w.code}: ${w.message}`);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

function emit(report, opts, exitCode) {
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(human(report, opts));
  return exitCode;
}

// ---------------------------------------------------------------------------

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`probe failed: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 5;
  });
