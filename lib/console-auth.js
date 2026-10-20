/**
 * SCNet console sign-in from the host, without copying cookies.
 *
 * Two modes, both using the endpoints SCNet's own desktop login page uses:
 *
 *   SMS (手机验证码)
 *     POST {console}/sso/sendRegisterMessageCode.action   form: mobilephoneNum, captcha, t, sn
 *       - `captcha` is NOT a picture: it is MD5(phone + timestamp + random + "20250207")
 *       - `random` is 10 chars of [0-9a-zA-Z]
 *     POST {console}/ac/api/auth/loginMobileByPhone.action form:
 *          mobilephoneNum, messageCode, createBy=scnet, siteCode=sacp,
 *          invitationCode=, fullName=, institution=
 *
 *   Password (账号密码)
 *     GET  {console}/ac/api/auth/isNeedCpatcha.action
 *     GET  {console}/ac/api/auth/getClientCaptcha.action  → { data: dataURL, captchaKey }
 *     POST {console}/ac/api/auth/loginDesktopClient.action form:
 *          username, password=RSA(password), encrypted=true,
 *          captcha, captchaKey, ph=1
 *
 * The RSA public key is the one bundled with the login page; JSEncrypt's
 * `encryptLong` produces base64 of one PKCS#1 v1.5 block for passwords up to
 * 53 bytes (512-bit key), which is exactly `publicEncrypt` + base64 here.
 *
 * In both modes the successful response binds the session to `jsessionid`
 * (HttpOnly). We prove the jar can read the subscription list before storing
 * it; the password / SMS code are never persisted.
 *
 * @module dsh-scnet-plan/lib/console-auth
 */
import { createHash, publicEncrypt, constants as cryptoConstants } from 'node:crypto'

/** Public key embedded in the ACM login bundle (rsa-encry chunk). */
const RSA_PUBLIC_KEY_B64 =
  'MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALaXEnbjI6fjy+t9W9AiO/KS0q+b/OZFS+7ykinLbiriUx9P8BcuuHnVbXNiZp5jW70eVGBtX4DhGUPzJa1YT/8CAwEAAQ=='

/** RSA key size of that public key minus PKCS#1 padding: 64 - 11 = 53 bytes. */
const RSA_MAX_PASSWORD_BYTES = 53

/** Salt appended to the SMS send-code signature (verbatim from the bundle). */
const SMS_SIGN_SALT = '20250207'

/** Error with a stable code for the settings UI. */
export class ConsoleAuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ConsoleAuthError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * Normalize a phone number to the form the login page sends: `+86…` for a
 * mainland number, or an already-prefixed `+…` number.
 * @param {string} input - user input, digits or `+…`.
 * @returns {string} canonical phone string.
 */
export function normalizePhone(input) {
  const raw = String(input ?? '').replace(/[\s-]/g, '')
  if (raw.startsWith('+')) return raw
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11) return `+86${digits}`
  if (digits.startsWith('86') && digits.length === 13) return `+${digits}`
  return digits === '' ? '' : `+${digits}`
}

/**
 * Random 10-char token used by the send-code signature.
 * @returns {string} alphanumeric token.
 */
function randomToken() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (let index = 0; index < 10; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

/**
 * Build the anti-abuse signature the send-code endpoint expects.
 * @param {string} phone - canonical phone (with `+86`).
 * @param {number} [timestamp] - override for tests.
 * @param {string} [random] - override for tests.
 * @returns {{ captcha: string, t: number, sn: string }} form fields.
 */
export function phoneSignature(phone, timestamp = Date.now(), random = randomToken()) {
  const captcha = createHash('md5').update(`${phone}${timestamp}${random}${SMS_SIGN_SALT}`).digest('hex')
  return { captcha, t: timestamp, sn: random }
}

/**
 * Encrypt a password the way the login page does (PKCS#1 v1.5, base64).
 * @param {string} password - plain password.
 * @returns {string} base64 ciphertext.
 */
export function encryptPassword(password) {
  const body = RSA_PUBLIC_KEY_B64.match(/.{1,64}/g).join('\n')
  const pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`
  const bytes = Buffer.from(password, 'utf8')
  if (bytes.length > RSA_MAX_PASSWORD_BYTES) {
    throw new ConsoleAuthError('PASSWORD_TOO_LONG', 'SCNet 的登录加密单块最多 53 字节，密码过长；请改用短信验证码登录。')
  }
  return publicEncrypt({ key: pem, padding: cryptoConstants.RSA_PKCS1_PADDING }, bytes).toString('base64')
}

/**
 * Pull `Set-Cookie` values from a fetch Response.
 * @param {Headers} headers - response headers.
 * @returns {string[]} raw cookie strings.
 */
export function setCookiesOf(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie()
  const single = headers?.get?.('set-cookie')
  return typeof single === 'string' && single !== ''
    ? single.split(/,(?=[^;,]+=)/).map((part) => part.trim()).filter(Boolean)
    : []
}

/**
 * Merge raw `Set-Cookie` strings into a `Cookie` header value.
 * @param {string} jar - current header value, possibly empty.
 * @param {string[]} rawSetCookies - values from Set-Cookie.
 * @returns {string} the new header value.
 */
export function mergeCookieJar(jar, rawSetCookies) {
  const map = new Map()
  for (const pair of String(jar ?? '').split(';')) {
    const trimmed = pair.trim()
    const eq = trimmed.indexOf('=')
    if (eq > 0) map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim())
  }
  for (const raw of rawSetCookies ?? []) {
    const [pair] = String(raw).split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (value === '' || /max-age\s*=\s*0\b/i.test(raw)) map.delete(name)
    else map.set(name, value)
  }
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Whether a failed login is asking for a picture captcha.
 * @param {Record<string, unknown>} body - console response.
 * @returns {boolean} true when the code/message mentions a captcha.
 */
export function isCaptchaChallenge(body) {
  const text = `${String(body?.msg ?? '')} ${String(body?.message ?? '')}`
  // "验证码错误" is a wrong SMS code; only a *picture* captcha challenge counts.
  return /图形验证码|captcha/i.test(text)
}

/** Map SCNet login error codes to a readable message. */
function loginErrorMessage(body, fallback) {
  const code = String(body?.code ?? '')
  const message = typeof body?.msg === 'string' && body.msg !== '' ? body.msg : fallback
  if (code === '1006') return '短信验证码错误'
  if (code === '1009') return '短信验证码已失效，请重新获取'
  if (code === '1014') return '账号或密码错误'
  if (code === '1022') return '该手机号尚未注册 SCNet，请先在官网注册后再试'
  if (code === '1005') return '发送太频繁，请稍后再试'
  if (code === '1013') return '平台不支持虚拟号码，请更换手机号'
  return message
}

/**
 * Create one sign-in coordinator (runs entirely on the host).
 *
 * @param {object} options - wiring.
 * @param {string} options.consoleBaseUrl - console origin.
 * @param {(cookie: string) => Promise<{ ok: boolean, detail?: string }>} options.verify - proves the jar can read the plan.
 * @param {(cookie: string) => Promise<void> | void} options.onSession - persists the verified cookie.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch (tests).
 * @returns {object} the coordinator.
 */
export function createConsoleAuth({ consoleBaseUrl, verify, onSession, timeoutMs = 20_000, fetchImpl = fetch }) {
  const base = consoleBaseUrl.replace(/\/+$/, '')
  /** @type {{ state: string, message?: string, captchaImage?: string, resendIn?: number, at?: number }} */
  let state = { state: 'idle' }
  /** @type {string} */
  let jar = ''
  /** @type {string} */
  let captchaKey = ''

  /** One console request that keeps the cookie jar up to date. */
  async function consoleFetch(path, init = {}) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Origin: base,
      Referer: `${base}/ui/acm/index.html`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      ...(jar === '' ? {} : { Cookie: jar }),
      ...(init.headers ?? {}),
    }
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new ConsoleAuthError(
        'NETWORK',
        `无法连接 SCNet 登录服务：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    jar = mergeCookieJar(jar, setCookiesOf(response.headers))
    const text = await response.text()
    let body = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      throw new ConsoleAuthError('BAD_RESPONSE', `登录服务返回了非 JSON 响应（HTTP ${response.status}）`)
    }
    return { status: response.status, body }
  }

  /** Whether the server currently wants a picture captcha. Never fatal. */
  async function needsCaptcha() {
    try {
      const { body } = await consoleFetch('/ac/api/auth/isNeedCpatcha.action')
      return body?.data === true
    } catch {
      return false
    }
  }

  /** Fetch a fresh captcha image + key. */
  async function fetchCaptcha() {
    const { body } = await consoleFetch('/ac/api/auth/getClientCaptcha.action')
    const image = typeof body?.data === 'string' && body.data.startsWith('data:image/') ? body.data : null
    if (image === null) throw new ConsoleAuthError('CAPTCHA_UNAVAILABLE', 'SCNet 没有返回验证码图片')
    captchaKey = typeof body?.captchaKey === 'string' ? body.captchaKey : ''
    return image
  }

  /** Record a successful sign-in only after the jar proves it can read the plan. */
  async function finish() {
    let proof
    try {
      proof = await verify(jar)
    } catch (error) {
      return {
        state: 'failed',
        message: `登录成功，但读取套餐失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (proof?.ok !== true) {
      return { state: 'failed', message: `登录成功，但会话不可用：${proof?.detail ?? '未知原因'}` }
    }
    try {
      await onSession(jar)
    } catch (error) {
      return { state: 'failed', message: `会话保存失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { state: 'success' }
  }

  /** Shared form POST helper for the two login endpoints. */
  async function postForm(path, fields) {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(fields)) form.set(key, String(value ?? ''))
    return consoleFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: form.toString(),
    })
  }

  /** Interpret a login response: success, captcha challenge, or failure. */
  async function settleLogin(body, status, { allowCaptcha = false } = {}) {
    const code = String(body?.code ?? '')
    const ok = code === '0' || code === '200' || status === 302 || status === 303
    if (!ok) {
      if (allowCaptcha && (isCaptchaChallenge(body) || (await needsCaptcha()))) {
        try {
          state = {
            state: 'captcha',
            message: loginErrorMessage(body, '需要图形验证码'),
            captchaImage: await fetchCaptcha(),
            at: Date.now(),
          }
        } catch (error) {
          state = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
        }
        return { ...state }
      }
      state = { state: 'failed', message: loginErrorMessage(body, `登录失败（${code || status}）`) }
      return { ...state }
    }
    state = await finish()
    state.at = Date.now()
    return { ...state }
  }

  return {
    status: () => ({ ...state }),

    /** Clear the remembered state and cookie jar. */
    reset() {
      state = { state: 'idle' }
      jar = ''
      captchaKey = ''
    },

    /** Request a captcha image on demand ("换一张"). */
    async captcha() {
      try {
        state = { state: 'captcha', captchaImage: await fetchCaptcha(), at: Date.now() }
      } catch (error) {
        state = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
      return { ...state }
    },

    /**
     * Send an SMS code to a phone number.
     * @param {{ phone: string }} input - phone in any common format.
     * @returns {Promise<object>} `{ state: 'code-sent' | 'failed', message?, resendIn? }`.
     */
    async sendCode({ phone } = {}) {
      const normalized = normalizePhone(phone)
      if (normalized === '' || normalized.length < 6) {
        state = { state: 'failed', message: '请输入正确的手机号' }
        return { ...state }
      }
      const signature = phoneSignature(normalized)
      try {
        // A fresh session cookie is sometimes required before the first POST;
        // the console's own page has one from loading the login screen.
        if (jar === '') await consoleFetch('/ac/api/auth/isNeedCpatcha.action').catch(() => {})
        const { body, status } = await postForm('/sso/sendRegisterMessageCode.action', {
          mobilephoneNum: normalized,
          captcha: signature.captcha,
          t: signature.t,
          sn: signature.sn,
        })
        const code = String(body?.code ?? '')
        if (code !== '0' && code !== '1004') {
          state = { state: 'failed', message: loginErrorMessage(body, `发送失败（HTTP ${status}）`) }
          return { ...state }
        }
        state = { state: 'code-sent', message: '验证码已发送', resendIn: 60, at: Date.now() }
      } catch (error) {
        state = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
      return { ...state }
    },

    /**
     * Sign in. `mode: 'sms'` uses `phone` + `code`; `mode: 'password'` uses
     * `username` + `password` (+ `captcha` when the server asks).
     * @param {object} input - credentials for the chosen mode.
     * @returns {Promise<object>} state object; never throws for credential failures.
     */
    async login({ mode = 'sms', phone, code, username, password, captcha } = {}) {
      if (mode === 'sms') {
        const normalized = normalizePhone(phone)
        const smsCode = typeof code === 'string' ? code.trim() : ''
        if (normalized === '' || smsCode === '') {
          state = { state: 'failed', message: '请输入手机号和短信验证码' }
          return { ...state }
        }
        try {
          const { body, status } = await postForm('/ac/api/auth/loginMobileByPhone.action', {
            mobilephoneNum: normalized,
            messageCode: smsCode,
            createBy: 'scnet',
            siteCode: 'sacp',
            invitationCode: '',
            fullName: '',
            institution: '',
          })
          return await settleLogin(body, status)
        } catch (error) {
          state = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
          return { ...state }
        }
      }

      const account = typeof username === 'string' ? username.trim() : ''
      if (account === '' || typeof password !== 'string' || password === '') {
        state = { state: 'failed', message: '请输入 SCNet 账号和密码' }
        return { ...state }
      }
      if (captcha === undefined && (await needsCaptcha())) {
        try {
          state = { state: 'captcha', captchaImage: await fetchCaptcha(), at: Date.now() }
        } catch (error) {
          state = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
        }
        return { ...state }
      }

      let encrypted
      try {
        encrypted = encryptPassword(password)
      } catch (error) {
        state = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
        return { ...state }
      }
      try {
        const { body, status } = await postForm('/ac/api/auth/loginDesktopClient.action', {
          username: account,
          password: encrypted,
          encrypted: 'true',
          captcha: typeof captcha === 'string' ? captcha.trim() : '',
          captchaKey,
          ph: '1',
        })
        return await settleLogin(body, status, { allowCaptcha: true })
      } catch (error) {
        state = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
        return { ...state }
      }
    },
  }
}
