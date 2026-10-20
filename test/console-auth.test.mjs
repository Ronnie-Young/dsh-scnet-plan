import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createConsoleAuth,
  encryptPassword,
  mergeCookieJar,
  normalizePhone,
  phoneSignature,
  setCookiesOf,
  isCaptchaChallenge,
} from '../lib/console-auth.js'

test('mergeCookieJar adds, replaces and deletes cookies', () => {
  assert.equal(mergeCookieJar('', ['jsessionid=abc; Path=/; HttpOnly']), 'jsessionid=abc')
  assert.equal(mergeCookieJar('a=1; b=2', ['a=9; Path=/', 'c=3']), 'a=9; b=2; c=3')
  assert.equal(mergeCookieJar('a=1; b=2', ['a=; Max-Age=0']), 'b=2')
})

test('setCookiesOf reads getSetCookie and falls back to a single header', () => {
  const res = new Response('{}', { headers: { 'set-cookie': 'x=1; Path=/' } })
  assert.deepEqual(setCookiesOf(res.headers), ['x=1; Path=/'])
  assert.deepEqual(setCookiesOf({ get: () => 'a=1, b=2' }), ['a=1', 'b=2'])
  assert.deepEqual(setCookiesOf(undefined), [])
})

test('isCaptchaChallenge recognises the console wording', () => {
  assert.equal(isCaptchaChallenge({ msg: '请输入图形验证码' }), true)
  assert.equal(isCaptchaChallenge({ msg: 'captcha is wrong' }), true)
  // A wrong SMS code is not a picture-captcha challenge.
  assert.equal(isCaptchaChallenge({ msg: '验证码错误' }), false)
  assert.equal(isCaptchaChallenge({ msg: 'user not exits or password is not correct' }), false)
})

test('normalizePhone produces the +86 form the login page sends', () => {
  assert.equal(normalizePhone('19924820162'), '+8619924820162')
  assert.equal(normalizePhone('+8619924820162'), '+8619924820162')
  assert.equal(normalizePhone('86 199-2482-0162'), '+8619924820162')
  assert.equal(normalizePhone(''), '')
})

test('phoneSignature is MD5(phone + t + sn + salt)', () => {
  const { captcha, t, sn } = phoneSignature('+8619924820162', 1700000000000, 'abcdefghij')
  assert.equal(t, 1700000000000)
  assert.equal(sn, 'abcdefghij')
  assert.match(captcha, /^[0-9a-f]{32}$/)
  // Same inputs → same digest (deterministic, so the server can verify it).
  assert.equal(phoneSignature('+8619924820162', 1700000000000, 'abcdefghij').captcha, captcha)
})

test('encryptPassword returns base64 RSA ciphertext and rejects over-long input', () => {
  const encrypted = encryptPassword('hunter2')
  assert.match(encrypted, /^[A-Za-z0-9+/]+=*$/)
  assert.equal(encrypted.includes('hunter2'), false)
  assert.notEqual(encryptPassword('hunter2'), encryptPassword('hunter2'))
  assert.throws(() => encryptPassword('x'.repeat(60)), /53/)
})

/** A scripted console: each call pops the next response. */
function fakeConsole(script) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = script.shift()
    if (next === undefined) throw new Error(`unexpected request: ${url}`)
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: next.setCookie === undefined ? {} : { 'set-cookie': next.setCookie },
    })
  }
  return { impl, calls }
}

test('SMS mode: sends a code with the phone signature', async () => {
  const { impl, calls } = fakeConsole([
    { body: { code: '0', data: false } }, // pre-warm session
    { body: { code: '0', msg: 'success' } },
  ])
  const auth = createConsoleAuth({
    consoleBaseUrl: 'https://www.scnet.cn',
    fetchImpl: impl,
    verify: async () => ({ ok: true }),
    onSession: async () => {},
  })
  const result = await auth.sendCode({ phone: '19924820162' })
  assert.equal(result.state, 'code-sent')
  assert.equal(result.resendIn, 60)

  const call = calls.find((item) => item.url.endsWith('/sso/sendRegisterMessageCode.action'))
  assert.ok(call)
  const form = new URLSearchParams(call.init.body)
  assert.equal(form.get('mobilephoneNum'), '+8619924820162')
  assert.match(form.get('captcha'), /^[0-9a-f]{32}$/)
  assert.equal(form.get('sn').length, 10)
  assert.ok(Number(form.get('t')) > 0)
})

test('SMS mode: signs in with phone + code and stores the session', async () => {
  const captured = []
  const { impl, calls } = fakeConsole([
    { body: { code: '0', msg: 'success' }, setCookie: 'jsessionid=sms-1; Path=/; HttpOnly' },
  ])
  const auth = createConsoleAuth({
    consoleBaseUrl: 'https://www.scnet.cn',
    fetchImpl: impl,
    verify: async (cookie) => ({ ok: cookie.includes('jsessionid=sms-1') }),
    onSession: async (cookie) => captured.push(cookie),
  })
  const result = await auth.login({ mode: 'sms', phone: '19924820162', code: '123456' })
  assert.equal(result.state, 'success')
  assert.deepEqual(captured, ['jsessionid=sms-1'])

  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get('mobilephoneNum'), '+8619924820162')
  assert.equal(form.get('messageCode'), '123456')
  assert.equal(form.get('createBy'), 'scnet')
  assert.equal(form.get('siteCode'), 'sacp')
})

test('SMS mode: a wrong code fails with a readable message', async () => {
  const { impl } = fakeConsole([{ body: { code: '1006', msg: '验证码错误' } }])
  const auth = createConsoleAuth({
    consoleBaseUrl: 'https://www.scnet.cn',
    fetchImpl: impl,
    verify: async () => ({ ok: true }),
    onSession: async () => {},
  })
  const result = await auth.login({ mode: 'sms', phone: '19924820162', code: '000000' })
  assert.equal(result.state, 'failed')
  assert.match(result.message, /验证码错误/)
})

test('password mode encrypts the password and sends captcha fields', async () => {
  const captured = []
  const { impl, calls } = fakeConsole([
    { body: { code: '0', data: true } }, // isNeedCpatcha
    { body: { code: '0', data: 'data:image/jpeg;base64,AAAA', captchaKey: 'key-1' } },
    { body: { code: '0', msg: 'success' }, setCookie: 'jsessionid=pwd-1; Path=/' },
  ])
  const auth = createConsoleAuth({
    consoleBaseUrl: 'https://www.scnet.cn',
    fetchImpl: impl,
    verify: async () => ({ ok: true }),
    onSession: async (cookie) => captured.push(cookie),
  })

  const challenge = await auth.login({ mode: 'password', username: 'alice', password: 'secret' })
  assert.equal(challenge.state, 'captcha')
  assert.match(challenge.captchaImage, /^data:image\/jpeg/)

  const result = await auth.login({ mode: 'password', username: 'alice', password: 'secret', captcha: 'e6s2' })
  assert.equal(result.state, 'success')
  assert.deepEqual(captured, ['jsessionid=pwd-1'])

  const loginCall = calls.find((call) => call.url.endsWith('/loginDesktopClient.action'))
  const form = new URLSearchParams(loginCall.init.body)
  assert.equal(form.get('username'), 'alice')
  assert.equal(form.get('password').includes('secret'), false)
  assert.equal(form.get('encrypted'), 'true')
  assert.equal(form.get('captcha'), 'e6s2')
  assert.equal(form.get('captchaKey'), 'key-1')
  assert.equal(form.get('ph'), '1')
})

test('empty credentials fail fast without a request', async () => {
  const { impl, calls } = fakeConsole([])
  const auth = createConsoleAuth({
    consoleBaseUrl: 'https://www.scnet.cn',
    fetchImpl: impl,
    verify: async () => ({ ok: true }),
    onSession: async () => {},
  })
  assert.equal((await auth.login({ mode: 'sms', phone: '', code: '' })).state, 'failed')
  assert.equal((await auth.login({ mode: 'password', username: '  ', password: '' })).state, 'failed')
  assert.equal(calls.length, 0)
})

test('network failures surface as failed, not as thrown errors', async () => {
  const auth = createConsoleAuth({
    consoleBaseUrl: 'https://www.scnet.cn',
    fetchImpl: async () => {
      throw new Error('ECONNRESET')
    },
    verify: async () => ({ ok: true }),
    onSession: async () => {},
  })
  const result = await auth.login({ mode: 'sms', phone: '19924820162', code: '123456' })
  assert.equal(result.state, 'failed')
  assert.match(result.message, /ECONNRESET/)
})
