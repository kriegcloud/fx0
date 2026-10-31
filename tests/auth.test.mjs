import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { sealData, unsealData } from 'iron-session'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { NextRequest } from 'next/server.js'

// Route handlers use the application's alias; source tests do not run Next's
// bundler. This only resolves paths, not replacement implementations.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/turn-credential' && context.parentURL?.endsWith('/api/auth/signout/route.ts')) return { url: 'data:text/javascript,export async function revokeLoginCredentials() {}', shortCircuit: true }
  // Session readers check sign-out revocation in the credential store's Redis;
  // these tests hold it in memory (globalThis.__revokedLogins).
  if (specifier === './turn-credential.ts' && /\/lib\/(auth|request-session)\.ts$/.test(context.parentURL ?? '')) {
    return { url: `data:text/javascript,${encodeURIComponent('export async function loginRevoked(id) { const r = globalThis.__revokedLogins; r.checks.push(id); if (r.fail) throw new Error("synthetic revocation read failure"); return r.ids.has(id) }')}`, shortCircuit: true }
  }
  // Pages read cookies from next/headers; a test hands them a request's jar.
  if (specifier === 'next/headers.js' && context.parentURL?.endsWith('/lib/secure-session.ts')) {
    return { url: `data:text/javascript,${encodeURIComponent('export async function cookies() { return globalThis.__pageCookies ?? new Map() }')}`, shortCircuit: true }
  }
  if (specifier === '@/lib/agent') return { url: 'data:text/javascript,export async function cancelUserRuntime(id) { globalThis.__signedOutUser = id }', shortCircuit: true }
  if (specifier.startsWith('@/lib/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context)
  // after() needs a Next request scope; the sign-out's follow-up runs at once and tests await it.
  if (specifier === 'next/server' && context.parentURL?.endsWith('/api/auth/signout/route.ts')) {
    return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve('next/server.js'))}; export function after(work) { globalThis.__signoutAfter = Promise.resolve().then(work) }`)}`, shortCircuit: true }
  }
  if (specifier === 'next/server') return next('next/server.js', context)
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../', import.meta.url).href) &&
      !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier, context.parentURL)
    if (!/\.[cm]?[jt]sx?$/.test(target.pathname)) return next(target.href + '.ts', context)
  }
  return next(specifier, context)
} })

process.env.SESSION_SECRET = 'deterministic-auth-test-secret-at-least-32-characters'
process.env.VERCEL_OAUTH_CLIENT_ID = 'auth-test-client'
process.env.VERCEL_OAUTH_CLIENT_SECRET = 'auth-test-client-secret'
process.env.APP_URL = 'https://fx0.example'
process.env.KV_REST_API_URL = 'https://auth-redis.example'
process.env.KV_REST_API_TOKEN = 'test-only-redis-token'

const protocol = await import('../lib/auth-protocol.ts')
const secure = await import('../lib/secure-session.ts')
const auth = await import('../lib/auth.ts')
const { withRequestSession } = await import('../lib/request-session.ts')
const { withChatRoute, withUserRoute } = await import('../lib/route-auth.ts')

test('production workstation POST accepts only its configured loopback origin', async (t) => {
  const previous = { ...process.env }
  t.after(() => { process.env = previous })
  Object.assign(process.env, { NODE_ENV: 'production', FX0_LOCAL: '1', APP_URL: 'http://127.0.0.1:3000' })
  delete process.env.VERCEL
  const request = origin => new Request('http://127.0.0.1:3000/api/model', {
    method: 'POST', headers: { host: '127.0.0.1:3000', ...(origin ? { origin } : {}) },
  })
  assert.doesNotThrow(() => protocol.assertSameOrigin(request(process.env.APP_URL)))
  const route = withUserRoute(async () => Response.json({ ok: true }))
  assert.equal((await route(request(process.env.APP_URL))).status, 200)
  for (const origin of [undefined, 'https://evil.example', 'http://127.0.0.1:3001']) {
    assert.throws(() => protocol.assertSameOrigin(request(origin)))
    assert.equal((await route(request(origin))).status, 403)
  }
  for (const override of ['http://evil.example', 'http://127.0.0.1:3001']) {
    assert.throws(() => protocol.assertSameOrigin(request(override), override))
  }
  process.env.FX0_LOCAL = '0'
  assert.throws(() => protocol.assertSameOrigin(request(process.env.APP_URL)), /trusted HTTP/)
  process.env.FX0_LOCAL = '1'
  process.env.VERCEL = '1'
  assert.throws(() => protocol.assertSameOrigin(request(process.env.APP_URL)), /loopback HTTP APP_URL outside Vercel/)
})
const noRevocations = () => ({ ids: new Set(), checks: [], fail: false })
globalThis.__revokedLogins = noRevocations()
// Logins sign-out has revoked, for one test.
function revocations(t) {
  const revoked = noRevocations()
  globalThis.__revokedLogins = revoked
  t.after(() => { globalThis.__revokedLogins = noRevocations() })
  return revoked
}
const handledRequests = new WeakMap()
async function requestSession(request) {
  let handled
  const response = await withRequestSession((forwarded, session) => {
    handled = { request: forwarded, session }
    return new Response(null)
  })(request)
  if (handled) handledRequests.set(response, handled)
  return response
}
const { GET: signin } = await import('../app/api/auth/signin/route.ts')
const { POST: signout } = await import('../app/api/auth/signout/route.ts')
const { GET: me } = await import('../app/api/auth/me/route.ts')
const { AuthError } = await import('../lib/accounts.ts')

const session = (extra = {}) => ({
  loginId: '11111111111111111111111111111111', loginAt: 1_750_000_000_000,
  userId: 'verified-sub', email: 'user@example.com', name: 'Test User', picture: 'https://example.com/avatar.png',
  accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 60_000,
  teamId: 'team_granted', teamSlug: 'granted', isLoggedIn: true, ...extra,
})
const tokenResponse = (extra = {}) => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, ...extra })

function refreshCache() {
  const values = new Map()
  const locks = new Map()
  const operations = []
  let reportContention
  const contended = new Promise((resolve) => { reportContention = resolve })
  const cache = {
    async get(key) {
      const entry = values.get(key)
      return entry && entry.until > Date.now() ? entry.value : null
    },
    async acquire(key, owner, ttl) {
      operations.push(['acquire', key, owner, ttl])
      if (locks.get(key)?.until > Date.now()) { reportContention(); return false }
      locks.set(key, { owner, until: Date.now() + ttl * 1000 })
      return true
    },
    async publish(key, owner, value, ttl) {
      operations.push(['publish', key, value, ttl])
      const lock = locks.get(key)
      if (lock?.owner !== owner || lock.until <= Date.now()) return false
      values.set(key, { value, until: Date.now() + ttl * 1000 })
      locks.delete(key)
      return true
    },
    async release(key, owner) {
      operations.push(['release', key, owner])
      if (locks.get(key)?.owner === owner) locks.delete(key)
    },
  }
  return { cache, values, locks, operations, contended }
}

async function requestWithSession(path, data, extraHeaders = {}) {
  const sealed = await secure.sealSessionCookie(data)
  return new NextRequest(`https://fx0.example${path}`, { headers: {
    cookie: `theme=dark; ${protocol.SESSION_COOKIE_NAME}=${data.loginId}; ${sealed.cookieName}=${sealed.value}`,
    ...extraHeaders,
  } })
}

function forwardedRequest(response, path = '/api/prompt') {
  return new NextRequest(`https://fx0.example${path}`, { headers: {
    cookie: handledRequests.get(response).request.headers.get('cookie') ?? '',
  } })
}

test('singleflight plus cross-instance lease performs one exchange and encrypts the 120s result', async () => {
  const store = refreshCache()
  let calls = 0
  let release
  let started
  const gate = new Promise((resolve) => { release = resolve })
  const fetching = new Promise((resolve) => { started = resolve })
  const fetcher = async (_url, options) => {
    calls++
    assert.equal(options.body.get('refresh_token'), 'old-refresh')
    assert.equal(options.body.get('grant_type'), 'refresh_token')
    assert.ok(options.signal instanceof AbortSignal)
    started()
    await gate
    return Response.json(tokenResponse())
  }
  const firstInstance = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  const secondInstance = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  const first = firstInstance('old-refresh')
  const sameInstance = firstInstance('old-refresh')
  assert.equal(first, sameInstance)
  await fetching
  const otherInstance = secondInstance('old-refresh')
  await store.contended
  release()
  const results = await Promise.all([first, sameInstance, otherInstance])
  assert.equal(calls, 1)
  assert.deepEqual(results[0], results[2])
  assert.equal(results[0].status, 'ok')
  assert.deepEqual(await secondInstance('old-refresh'), results[0])
  assert.equal(calls, 1)
  const [key, entry] = [...store.values][0]
  assert.ok(key.endsWith(createHash('sha256').update('old-refresh').digest('hex')))
  assert.ok(!key.includes('old-refresh'))
  assert.ok(!entry.value.includes('rotated-access') && !entry.value.includes('rotated-refresh'))
  assert.equal(store.operations[0][3], 30)
  assert.equal(store.operations.find((op) => op[0] === 'publish')[3], 120)
  const decoded = await unsealData(entry.value, { password: process.env.SESSION_SECRET, ttl: 120 })
  assert.equal(decoded.key, key)
  assert.deepEqual(decoded.result, results[0])
})

test('refresh preserves identity/team/payload and the old refresh token when no rotation is supplied', async () => {
  const refresh = auth.createRefreshCoordinator({ fetch: async () => Response.json(tokenResponse({ refresh_token: undefined })), cache: refreshCache().cache })
  const before = session({ customFutureField: 'keep-me' })
  const result = await refresh(before.refreshToken)
  assert.equal(result.status, 'ok')
  const after = auth.sessionWithRefresh(before, result)
  assert.deepEqual(after, { ...before, accessToken: 'rotated-access', expiresAt: result.expiresAt })
  assert.equal(after.teamId, 'team_granted')
  const cookie = await secure.sealSessionCookie(after)
  const decoded = await secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: {
    cookie: `${secure.SESSION_COOKIE_NAME}=${after.loginId}; ${cookie.cookieName}=${cookie.value}`,
  } }))
  assert.deepEqual(decoded, after)
})

test('an in-app team choice overrides the grant team only for the login that made it', async () => {
  const data = session()
  const grant = await secure.sealSessionCookie(data)
  const read = (choice) => secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: {
    cookie: `${secure.SESSION_COOKIE_NAME}=${data.loginId}; ${grant.cookieName}=${grant.value}` +
      (choice ? `; ${secure.TEAM_COOKIE_NAME}=${choice}` : ''),
  } }))
  const chosen = await secure.teamCookie(data.loginId, { teamId: 'team_chosen', teamSlug: 'chosen' })
  const decoded = await read(chosen.value)
  assert.equal(decoded.teamId, 'team_chosen')
  assert.equal(decoded.teamSlug, 'chosen')
  assert.equal(decoded.accessToken, data.accessToken)
  const otherLogin = await secure.teamCookie('f'.repeat(32), { teamId: 'team_chosen', teamSlug: 'chosen' })
  assert.equal((await read(otherLogin.value)).teamId, data.teamId)
  assert.equal((await read('forged')).teamId, data.teamId)
  assert.equal((await read()).teamId, data.teamId)
})

test('only exact OAuth invalid_grant is terminal; transient/malformed/config failures preserve grant', async () => {
  for (const [fetcher, status] of [
    [async () => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'terminal'],
    [async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }), 'transient'],
    [async () => Response.json({ error: 'invalid_grant' }, { status: 503 }), 'transient'],
    [async () => new Response('invalid_grant is mentioned here', { status: 400 }), 'transient'],
    [async () => Response.json({ access_token: '', expires_in: 3600 }), 'transient'],
    [async () => Response.json(tokenResponse({ expires_in: -1 })), 'transient'],
    [async () => { throw new Error('network failed') }, 'transient'],
  ]) {
    const refresh = auth.createRefreshCoordinator({ fetch: fetcher, cache: refreshCache().cache })
    assert.equal((await refresh('old-refresh')).status, status)
  }
  const prior = process.env.VERCEL_OAUTH_CLIENT_SECRET
  delete process.env.VERCEL_OAUTH_CLIENT_SECRET
  try {
    const refresh = auth.createRefreshCoordinator({ fetch: async () => assert.fail('must not exchange without client secret'), cache: refreshCache().cache })
    assert.equal((await refresh('old-refresh')).status, 'transient')
  } finally { process.env.VERCEL_OAUTH_CLIENT_SECRET = prior }
})

test('a transient exchange is never replayed: the lease is released and the next request on any instance retries', async () => {
  const store = refreshCache()
  const outcomes = [Response.json({ error: 'temporarily_unavailable' }, { status: 503 }), Response.json(tokenResponse())]
  let exchanges = 0
  const fetcher = async () => { exchanges++; return outcomes.shift() }
  const first = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  const second = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  assert.deepEqual(await first('blip-refresh'), { status: 'transient' })
  assert.equal(store.values.size, 0, 'a transient failure is not published')
  assert.equal(store.locks.size, 0, 'the lease is released at once, not at its TTL')
  const recovered = await second('blip-refresh')
  assert.equal(recovered.status, 'ok')
  assert.equal(exchanges, 2)
  assert.deepEqual(store.operations.map(([name]) => name), ['acquire', 'release', 'acquire', 'publish'])
})

test('a transient result cached by an older build is ignored rather than replayed', async () => {
  const store = refreshCache()
  const key = `fx0:v1:auth:refresh:${createHash('sha256').update('legacy-refresh').digest('hex')}`
  const sealed = await sealData({ key, result: { status: 'transient' }, expiresAt: Date.now() + 120_000 },
    { password: process.env.SESSION_SECRET, ttl: 120 })
  store.values.set(key, { value: sealed, until: Date.now() + 120_000 })
  let exchanges = 0
  const refresh = auth.createRefreshCoordinator({ fetch: async () => { exchanges++; return Response.json(tokenResponse()) }, cache: store.cache })
  assert.equal((await refresh('legacy-refresh')).status, 'ok')
  assert.equal(exchanges, 1)
})

test('Redis failure never falls back to an uncoordinated provider exchange', async () => {
  const store = refreshCache()
  store.cache.get = async () => { throw new Error('Redis unavailable') }
  const refresh = auth.createRefreshCoordinator({ fetch: async () => assert.fail('no exchange without lease'), cache: store.cache })
  assert.deepEqual(await refresh('old-refresh'), { status: 'transient' })
})

test('a held lease waits only for a bounded result and never exchanges the stale token', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  let reads = 0
  const refresh = auth.createRefreshCoordinator({
    fetch: async () => assert.fail('lease is owned by another instance'),
    cache: {
      get: async () => { if (++reads > 1) t.mock.timers.setTime(Date.now() + 12_000); return null },
      acquire: async () => false,
      publish: async () => assert.fail('no result to publish'),
    },
  })
  assert.deepEqual(await refresh('locked-refresh'), { status: 'transient' })
  assert.equal(reads, 2)
})

test('a cache publication outage does not discard the newly rotated token', async () => {
  const store = refreshCache()
  store.cache.publish = async () => { throw new Error('Redis publication failed') }
  const refresh = auth.createRefreshCoordinator({ fetch: async () => Response.json(tokenResponse()), cache: store.cache })
  const result = await refresh('old-refresh')
  assert.equal(result.status, 'ok')
  assert.equal(result.tokens.refresh_token, 'rotated-refresh')
  assert.equal(store.locks.size, 1) // Leave the protective lease until its TTL.
})

test('sealed result cannot be replayed under another refresh-token hash', async () => {
  const store = refreshCache()
  const good = auth.createRefreshCoordinator({ fetch: async () => Response.json(tokenResponse()), cache: store.cache })
  await good('old-refresh')
  const value = [...store.values.values()][0].value
  store.cache.get = async () => value
  const other = auth.createRefreshCoordinator({ fetch: async () => assert.fail('tampered result must fail closed'), cache: store.cache })
  assert.deepEqual(await other('different-refresh'), { status: 'transient' })
})

test('90-day cookie and seal TTL match; production flags, encrypted payload, clear, and tamper rejection', async () => {
  const before = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const options = secure.getSessionOptions()
    assert.equal(options.ttl, 90 * 24 * 60 * 60)
    assert.equal(options.ttl, options.cookieOptions.maxAge)
    const data = session()
    const cookie = await secure.sealSessionCookie(data)
    assert.match(cookie.setCookie, /HttpOnly/i)
    assert.match(cookie.setCookie, /Secure/i)
    assert.match(cookie.setCookie, /SameSite=Lax/i)
    assert.match(cookie.setCookie, /Max-Age=7776000/i)
    assert.ok(!cookie.value.includes(data.accessToken))
    // Iron's encrypted seal carries its expiration as its sixth component.
    const sealExpiration = Number(cookie.value.split('*')[5])
    assert.ok(Math.abs(sealExpiration - (Date.now() + options.ttl * 1000)) < 2000)
    const cleared = await secure.sealSessionCookie(null, data.loginId)
    assert.equal(cleared.cookieName, secure.grantCookieName(data.loginId))
    const selector = secure.selectorCookie(data.loginId)
    assert.equal(selector.cookieName, secure.SESSION_COOKIE_NAME)
    assert.equal(selector.value, data.loginId)
    for (const flag of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Max-Age=7776000/i]) assert.match(selector.setCookie, flag)
    assert.equal(cleared.value, '')
    assert.match(cleared.setCookie, /Max-Age=0/i)
    const tampered = `${cookie.value.slice(0, -6)}broken`
    const decoded = await secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: {
      cookie: `${secure.SESSION_COOKIE_NAME}=${data.loginId}; ${cookie.cookieName}=${tampered}`,
    } }))
    assert.deepEqual(decoded, {})
  } finally {
    if (before === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = before
  }
})

test('readers require a valid selector, matching encrypted loginId and valid issuance fields', async () => {
  const data = session()
  const grant = await secure.sealSessionCookie(data)
  const read = (cookie) => secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: { cookie } }))
  assert.deepEqual(await read(`${grant.cookieName}=${grant.value}`), {})
  assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=${grant.value}`), {}, 'legacy fixed credential cookies are not selectors')
  assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=bad-id; ${grant.cookieName}=${grant.value}`), {})
  const otherId = '22222222222222222222222222222222'
  assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=${otherId}; ${secure.grantCookieName(otherId)}=${grant.value}`), {})
  for (const extra of [
    { loginId: undefined }, { loginAt: undefined }, { loginAt: null }, { loginAt: 0 }, { loginAt: 'yesterday' },
    { loginAt: 1.5 }, { refreshToken: 123 }, { picture: {} }, { expiresAt: 0 },
  ]) {
    const bad = await sealData({ ...data, ...extra }, { password: process.env.SESSION_SECRET, ttl: secure.SESSION_TTL_SECONDS })
    assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=${data.loginId}; ${grant.cookieName}=${bad}`), {})
  }
  assert.equal(secure.isAuthenticatedSession({ ...data, loginAt: NaN }), false)
  await assert.rejects(secure.sealSessionCookie(data, otherId), /Invalid session payload/)
  await assert.rejects(secure.sealSessionCookie(null), /Invalid login ID/)
  assert.throws(() => secure.selectorCookie('bad-id'), /Invalid login ID/)
  assert.throws(() => protocol.forwardSessionCookie(new Headers(), secure.SESSION_COOKIE_NAME, null), /Only grant cookies/)
})

test('request cleanup bounds obsolete grant deletions and never touches selector or selected credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('cookie cleanup must be local'))
  const request = await requestWithSession('/api/prompt', session({ expiresAt: Date.now() + 3600_000 }))
  const oldNames = Array.from({ length: 12 }, (_, i) => secure.grantCookieName((i + 1).toString(16).padStart(32, '0')))
  for (const name of oldNames) request.cookies.set(name, 'obsolete-seal-not-decrypted')
  request.cookies.set('vercel_auth_grant_not-a-login-id', 'unrelated')
  const response = await requestSession(request)
  const deletes = response.headers.getSetCookie()
  assert.equal(deletes.length, 8)
  assert.ok(deletes.every((value, i) => value.startsWith(`${oldNames[i]}=`) && value.includes('Max-Age=0')))
  const forwarded = forwardedRequest(response)
  assert.equal(forwarded.cookies.get(secure.SESSION_COOKIE_NAME).value, session().loginId)
  assert.equal((await secure.getSessionFromRequest(forwarded)).userId, 'verified-sub')
  assert.equal(forwarded.cookies.get('vercel_auth_grant_not-a-login-id').value, 'unrelated')
  for (const name of oldNames.slice(0, 8)) assert.equal(forwarded.cookies.has(name), false)
  for (const name of oldNames.slice(8)) assert.equal(forwarded.cookies.has(name), true)
  const loggedOut = new NextRequest('https://fx0.example/api/prompt', { headers: { cookie: `${oldNames[0]}=revived-by-late-refresh` } })
  const cleanup = await requestSession(loggedOut)
  assert.equal(cleanup.headers.getSetCookie().length, 1)
  assert.ok(!cleanup.headers.getSetCookie()[0].startsWith(`${secure.SESSION_COOKIE_NAME}=`))
  assert.deepEqual(await secure.getSessionFromRequest(forwardedRequest(cleanup)), {})
})

test('refresh floor covers 800s routes; ordinary requests refresh nothing and write no cookies', async (t) => {
  assert.equal(protocol.MIN_GATEWAY_VALIDITY_MS, 15 * 60_000)
  assert.ok(protocol.MIN_GATEWAY_VALIDITY_MS > 800 * 1000)
  const now = Date.now()
  assert.equal(auth.needsTokenRefresh(session({ expiresAt: now + protocol.MIN_GATEWAY_VALIDITY_MS + 1 }), now), false)
  assert.equal(auth.needsTokenRefresh(session({ expiresAt: now + protocol.MIN_GATEWAY_VALIDITY_MS }), now), true)
  const revoked = revocations(t)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('ordinary auth makes no refresh request'))
  const request = await requestWithSession('/api/prompt', session({ expiresAt: now + 3600_000 }))
  const response = await requestSession(request)
  assert.ok(handledRequests.has(response))
  assert.equal(response.headers.get('set-cookie'), null)
  assert.deepEqual(revoked.checks, [session().loginId], 'its one store read is the sign-out check')
  assert.deepEqual(await auth.resolveGrantedTeam(session()), { teamId: 'team_granted', teamSlug: 'granted' })
  assert.deepEqual((await (await me(request)).json()).user, auth.publicUser(session()))
  assert.deepEqual(Object.keys(auth.publicUser(session())), ['id', 'name', 'email', 'picture'])
  await assert.rejects(auth.resolveGrantedTeam(session({ teamId: undefined })), (error) => error instanceof AuthError && error.status === 403)
})

test('a signed-out login\'s grant replayed from a copy is no session for API routes: no refresh, and its cookie is cleared', async (t) => {
  const revoked = revocations(t)
  // Within the refresh floor: a live grant would refresh here.
  const grant = session({ expiresAt: Date.now() + 60_000 })
  revoked.ids.add(grant.loginId)
  // Refresh contains its own errors, so count requests rather than fail in one.
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }))
  const response = await requestSession(await requestWithSession('/api/prompt', grant))
  assert.equal(network.mock.callCount(), 0, 'a revoked grant never refreshes')
  assert.equal(response.status, 200)
  assert.deepEqual(handledRequests.get(response).session, {})
  const grantCookie = secure.grantCookieName(grant.loginId)
  assert.ok(response.headers.getSetCookie().some((value) => value.startsWith(`${grantCookie}=`) && value.includes('Max-Age=0')))
  assert.equal(forwardedRequest(response).cookies.has(grantCookie), false)
  assert.equal((await (await me(await requestWithSession('/api/auth/me', grant))).json()).user, null)
})

test('API routes fail closed when the sign-out check is unavailable', async (t) => {
  const revoked = revocations(t)
  revoked.fail = true
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }))
  const response = await requestSession(await requestWithSession('/api/prompt', session()))
  assert.equal(response.status, 503)
  assert.equal(handledRequests.has(response), false)
  assert.equal(network.mock.callCount(), 0, 'no refresh without the sign-out check')
})

test('pages read no session from a signed-out login\'s grant', async (t) => {
  const revoked = revocations(t)
  const grant = session({ expiresAt: Date.now() + 3600_000 })
  globalThis.__pageCookies = (await requestWithSession('/', grant)).cookies
  t.after(() => { delete globalThis.__pageCookies })
  assert.equal((await auth.requireUserSession()).loginId, grant.loginId)
  revoked.ids.add(grant.loginId)
  await assert.rejects(auth.requireUserSession(), (error) => error instanceof AuthError && error.status === 401)
  revoked.fail = true
  await assert.rejects(auth.requireUserSession(), /synthetic revocation read failure/, 'an unavailable check is no session either')
})

// In-memory REST endpoint exercises the REAL installed Redis adapter and request wrapper,
// not a replacement request wrapper. The separate coordinator tests inject only its cache
// and fetch boundary. No service credentials or remote requests are used.
const redisValues = new Map()
function redisRest(options) {
  const execute = (args) => {
    const [command, ...rest] = args
    const op = command.toUpperCase()
    if (op === 'GET') return redisValues.get(rest[0]) ?? null
    if (op === 'SET') {
      if (rest.some((arg) => String(arg).toUpperCase() === 'NX') && redisValues.has(rest[0])) return null
      redisValues.set(rest[0], rest[1])
      return 'OK'
    }
    if (op === 'EVAL') {
      const [, numKeys, ...items] = rest
      const keys = items.slice(0, Number(numKeys))
      const argv = items.slice(Number(numKeys))
      if (keys.length === 1) { // Lease release: compare-and-delete.
        if (redisValues.get(keys[0]) !== argv[0]) return 0
        redisValues.delete(keys[0])
        return 1
      }
      const [lockKey, resultKey] = keys
      const [owner, value] = argv
      if (redisValues.get(lockKey) !== owner) return 0
      redisValues.set(resultKey, value)
      redisValues.delete(lockKey)
      return 1
    }
    assert.fail(`unexpected Redis operation: ${op}`)
  }
  const body = JSON.parse(options.body)
  return Response.json(Array.isArray(body[0])
    ? body.map((args) => ({ result: execute(args) }))
    : { result: execute(body) })
}

function mockRefreshNetwork(t, response) {
  let exchanges = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://auth-redis.example')) return redisRest(options)
    assert.equal(String(url), protocol.TOKEN_ENDPOINT)
    exchanges++
    return response()
  })
  return () => exchanges
}

test('profile endpoint renews its credential in the handler without middleware', async (t) => {
  const exchanges = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const response = await me(await requestWithSession('/api/auth/me', session({ refreshToken: 'handler-profile-refresh' })))
  assert.equal(response.status, 200)
  assert.equal(exchanges(), 1)
  assert.equal((await response.json()).user.id, 'verified-sub')
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(secure.grantCookieName(session().loginId) + '='))
  assert.ok(cookie, 'renewal must reach the browser on the profile response')
  const updated = await secure.getSessionFromRequest(new NextRequest('https://fx0.example/api/auth/me', {
    headers: { cookie: `${secure.SESSION_COOKIE_NAME}=${session().loginId}; ${cookie.split(';')[0]}` },
  }))
  assert.equal(updated.accessToken, 'rotated-access')
  assert.equal(updated.refreshToken, 'rotated-refresh')
})

test('profile endpoint refuses expired credentials when renewal is unavailable without middleware', async (t) => {
  t.mock.method(console, 'error', () => {})
  mockRefreshNetwork(t, () => Response.json({ error: 'invalid_client' }, { status: 401 }))
  const response = await me(await requestWithSession('/api/auth/me', session({
    refreshToken: 'handler-profile-unavailable', expiresAt: Date.now() - 1000,
  })))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '5')
  assert.ok(!('user' in await response.json()))
})

test('protected handler receives renewed credentials and its body while the event stream remains open', { timeout: 3000 }, async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const source = await requestWithSession('/api/prompt', session({ refreshToken: 'handler-stream-refresh' }), { origin: process.env.APP_URL })
  const abort = new AbortController()
  let forwardedSignal
  let stream
  t.after(() => { try { stream?.close() } catch {} })
  const handle = withUserRoute(async (request, { session: current }) => {
    assert.equal(current.accessToken, 'rotated-access')
    assert.equal(current.teamId, 'team_granted')
    assert.equal(request.method, 'POST')
    assert.equal(request.url, source.url)
    assert.equal(request.headers.get('origin'), process.env.APP_URL)
    forwardedSignal = request.signal
    assert.deepEqual(await request.json(), { text: 'keep the request body' })
    assert.match(request.headers.get('cookie'), /theme=dark/)
    return new Response(new ReadableStream({ start(controller) {
      stream = controller
      controller.enqueue(new TextEncoder().encode('data: first event\n\n'))
    } }), { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'handler-cookie=kept; Path=/' } })
  })
  const response = await handle(new Request(source.url, { method: 'POST', headers: source.headers, body: JSON.stringify({ text: 'keep the request body' }), signal: abort.signal }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith('handler-cookie=kept;')))
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(secure.grantCookieName(session().loginId) + '=')))
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first event\n\n')
  await reader.cancel()
  abort.abort()
  assert.equal(forwardedSignal.aborted, true, 'forwarding must preserve request cancellation')
})

test('chat routes renew an expiring grant and return the rotated cookie', async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const request = await requestWithSession('/api/warm?session=chat-1', session({ refreshToken: 'chat-route-refresh' }), { origin: process.env.APP_URL })
  // The guest-claim step reads next/headers cookies(), which has no request scope here,
  // so the handler fails; renewal still runs first and its cookie survives the failure.
  const response = await withChatRoute(async () => new Response(null, { status: 204 }))(
    new Request(request.url, { method: 'POST', headers: request.headers }))
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(secure.grantCookieName(session().loginId) + '=')))
})

test('renewed browser cookies survive protected-handler errors without exposing the error or credentials', async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  for (const [failure, status] of [[new AuthError(409, 'Chat is busy'), 409], [new Error('private failure detail'), 503]]) {
    const request = await requestWithSession('/api/events', session({ refreshToken: 'handler-error-refresh-' + status }))
    const response = await withUserRoute(async () => { throw failure })(request)
    assert.equal(response.status, status)
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(secure.grantCookieName(session().loginId) + '='))
    assert.ok(cookie, 'the browser must retain the rotated refresh token even when the handler fails')
    const current = await secure.getSessionFromRequest(new NextRequest(request.url, {
      headers: { cookie: `${secure.SESSION_COOKIE_NAME}=${session().loginId}; ${cookie.split(';')[0]}` },
    }))
    assert.equal(current.refreshToken, 'rotated-refresh')
    assert.doesNotMatch(await response.text(), /private failure detail|rotated-access|rotated-refresh/)
  }
})

test('request renewal updates browser and handler cookies in the same API request, preserving the granted team', async (t) => {
  const calls = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const response = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-success-refresh' })))
  assert.equal(calls(), 1)
  assert.match(response.headers.get('set-cookie'), /Max-Age=7776000/i)
  assert.match(forwardedRequest(response).headers.get('cookie'), /theme=dark/)
  const incoming = await secure.getSessionFromRequest(forwardedRequest(response))
  assert.equal(incoming.accessToken, 'rotated-access')
  assert.equal(incoming.refreshToken, 'rotated-refresh')
  assert.equal(incoming.teamId, 'team_granted')
  assert.equal(incoming.userId, 'verified-sub')
  assert.equal(response.headers.get('cookie'), null) // Not a browser-visible request header.
})

test('terminal invalid_grant clears current request and browser, without dropping unrelated cookies', async (t) => {
  mockRefreshNetwork(t, () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
  const response = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-terminal-refresh' })))
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/i)
  assert.equal(forwardedRequest(response).headers.get('cookie'), `theme=dark; ${secure.SESSION_COOKIE_NAME}=${session().loginId}`)
  assert.ok(response.headers.getSetCookie().every((cookie) => !cookie.startsWith(`${secure.SESSION_COOKIE_NAME}=`)))
  assert.deepEqual(await secure.getSessionFromRequest(forwardedRequest(response)), {})
  assert.ok(handledRequests.has(response))
})

test('renewal logs link a rejected refresh token to the exchange that rotated it, without credentials', async (t) => {
  const tag = (value) => createHash('sha256').update(value).digest('hex').slice(0, 10)
  const logged = []
  for (const level of ['info', 'error']) t.mock.method(console, level, (line) => logged.push(JSON.parse(line)))
  const results = [() => Response.json(tokenResponse()), () => Response.json({ error: 'invalid_grant' }, { status: 400 })]
  mockRefreshNetwork(t, () => results.shift()())
  await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'trail-refresh' })))
  await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'rotated-refresh' })))
  const trail = logged.filter(({ event }) => event.startsWith('auth:')).map(({ at, sessionAgeS, accessExpiresInS, ...rest }) => rest)
  const ids = { user: tag('verified-sub'), login: tag(session().loginId) }
  assert.deepEqual(trail, [
    { event: 'auth:refresh:exchanged', rt: tag('trail-refresh'), next: tag('rotated-refresh'), expiresIn: tokenResponse().expires_in },
    { event: 'auth:session:renewed', ...ids, rt: tag('trail-refresh') },
    { event: 'auth:refresh:rejected', rt: tag('rotated-refresh'), status: 400, error: 'invalid_grant' },
    { event: 'auth:session:ended', ...ids, rt: tag('rotated-refresh') },
  ])
  assert.doesNotMatch(JSON.stringify(logged), /trail-refresh|rotated-refresh|rotated-access|verified-sub|user@example/)
})

test('transient refresh preserves cookie; known-expired credentials do not reach the handler', async (t) => {
  mockRefreshNetwork(t, () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }))
  const live = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-transient-live' })))
  assert.equal(live.headers.get('set-cookie'), null)
  assert.ok(handledRequests.has(live))
  const expired = await requestSession(await requestWithSession('/api/prompt', session({ expiresAt: Date.now() - 1000, refreshToken: 'proxy-transient-expired' })))
  assert.equal(expired.status, 503)
  assert.equal(expired.headers.get('set-cookie'), null)
  assert.equal(handledRequests.has(expired), false)
  assert.equal(expired.headers.get('cache-control'), 'no-store')
})

test('page identity reads do not renew expired grants', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('pages only read cookie identity'))
  const expired = session({ expiresAt: Date.now() - 1000 })
  for (const accept of ['text/html', 'text/x-component']) {
    const request = await requestWithSession('/', expired, { accept })
    assert.equal((await secure.getSessionFromRequest(request)).userId, 'verified-sub')
  }
})

test('after a page load, the parallel first API requests share one renewal', async (t) => {
  const calls = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const data = session({ refreshToken: 'proxy-parallel-refresh' })
  await secure.getSessionFromRequest(await requestWithSession('/', data, { accept: 'text/html' }))
  const paths = ['/api/credits', '/api/teams', '/api/events?session=x', '/api/model?session=x']
  const responses = await Promise.all(paths.map(async (path) => requestSession(await requestWithSession(path, data))))
  assert.equal(calls(), 1)
  for (const [i, response] of responses.entries()) {
    assert.ok(handledRequests.has(response))
    assert.equal((await secure.getGrantFromRequest(forwardedRequest(response, paths[i]))).accessToken, 'rotated-access')
  }
})

test('renewal reseals the grant as stored, without the in-app team choice', async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const data = session({ refreshToken: 'proxy-team-choice-refresh' })
  const choice = await secure.teamCookie(data.loginId, { teamId: 'team_chosen', teamSlug: 'chosen' })
  const grant = await secure.sealSessionCookie(data)
  const response = await requestSession(new NextRequest('https://fx0.example/api/prompt', { headers: {
    cookie: `${protocol.SESSION_COOKIE_NAME}=${data.loginId}; ${grant.cookieName}=${grant.value}; ${choice.cookieName}=${choice.value}`,
  } }))
  const forwarded = forwardedRequest(response)
  assert.equal((await secure.getGrantFromRequest(forwarded)).teamId, 'team_granted')
  assert.equal((await secure.getGrantFromRequest(forwarded)).accessToken, 'rotated-access')
  assert.equal((await secure.getSessionFromRequest(forwarded)).teamId, 'team_chosen')
})

test('an expired short-lived cached result is not dispatched, but its rotated refresh token is preserved', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const calls = mockRefreshNetwork(t, () => Response.json(tokenResponse({ expires_in: 60 })))
  const request = await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-short-lived-refresh' }))
  const first = await requestSession(request)
  assert.ok(handledRequests.has(first))
  t.mock.timers.setTime(Date.now() + 70_000)
  const second = await requestSession(request)
  assert.equal(calls(), 1, 'reuse the encrypted result; never exchange the stale refresh token twice')
  assert.equal(second.status, 503)
  assert.equal(handledRequests.has(second), false)
  const cookie = second.headers.getSetCookie().find((value) => value.startsWith(`${secure.grantCookieName(session().loginId)}=`))
  const next = new NextRequest('https://fx0.example', { headers: {
    cookie: `${secure.SESSION_COOKIE_NAME}=${session().loginId}; ${cookie.split(';')[0]}`,
  } })
  assert.equal((await secure.getSessionFromRequest(next)).refreshToken, 'rotated-refresh')
})

test('signin uses trusted APP_URL, required scopes and PKCE, and one encrypted short-lived flow cookie', async () => {
  const response = await signin(new NextRequest('https://attacker.example/api/auth/signin?reauth=true'))
  const url = new URL(response.headers.get('location'))
  assert.equal(url.searchParams.get('redirect_uri'), 'https://fx0.example/api/auth/callback')
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('teamSelection'), 'single-team')
  const cookie = response.cookies.get(protocol.FLOW_COOKIE_NAME)
  assert.ok(cookie)
  const flow = await unsealData(cookie.value, { password: process.env.SESSION_SECRET, ttl: protocol.FLOW_TTL_SECONDS })
  assert.equal(flow.state, url.searchParams.get('state'))
  assert.equal(flow.nonce, url.searchParams.get('nonce'))
  assert.equal(createHash('sha256').update(flow.codeVerifier).digest('base64url'), url.searchParams.get('code_challenge'))
  assert.ok(!cookie.value.includes(flow.codeVerifier))
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i)
  assert.match(response.headers.get('set-cookie'), /Max-Age=600/i)
  assert.equal(protocol.validOAuthFlow(flow, flow.state), true)
  assert.equal(protocol.validOAuthFlow(flow, 'wrong-state'), false)
  assert.equal(protocol.validOAuthFlow(flow, flow.state, flow.createdAt + 600_000), false)
})

test('jose verifies signature, issuer, audience, expiration and nonce before exposing stable sub', async () => {
  const pair = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'auth-test-key', alg: 'RS256' }
  const keys = createLocalJWKSet({ keys: [jwk] })
  const sign = (claims = {}, key = pair.privateKey) => new SignJWT({ sub: 'stable-sub', email: 'user@example.com', nonce: 'expected-nonce', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://vercel.com')
    .setAudience('auth-test-client').setExpirationTime('5m').sign(key)
  const params = { clientId: 'auth-test-client', nonce: 'expected-nonce' }
  assert.equal((await protocol.verifyVercelIdToken(await sign(), params, keys)).userId, 'stable-sub')
  await assert.rejects(protocol.verifyVercelIdToken(await sign({ nonce: 'wrong' }), params, keys))
  await assert.rejects(protocol.verifyVercelIdToken(await sign(), { ...params, clientId: 'wrong-client' }, keys))
  const wrongIssuer = await new SignJWT({ sub: 's', email: 'e', nonce: 'expected-nonce' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://attacker.example').setAudience(params.clientId).setExpirationTime('5m').sign(pair.privateKey)
  await assert.rejects(protocol.verifyVercelIdToken(wrongIssuer, params, keys))
  const expired = await new SignJWT({ sub: 's', email: 'e', nonce: 'expected-nonce' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://vercel.com').setAudience(params.clientId).setExpirationTime(Math.floor(Date.now() / 1000) - 1).sign(pair.privateKey)
  await assert.rejects(protocol.verifyVercelIdToken(expired, params, keys))
  await assert.rejects(protocol.verifyVercelIdToken(await sign({}, (await generateKeyPair('RS256')).privateKey), params, keys))
  await assert.rejects(protocol.verifyVercelIdToken(await sign({ sub: '' }), params, keys))
})

test('team selection probes Gateway permissions, never returns unapproved membership or owner default', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push(String(url))
    assert.equal(options.headers.Authorization, 'Bearer user-token')
    if (String(url).startsWith('https://api.vercel.com/v2/teams')) return Response.json({ teams: [
      { id: 'user_not_a_team' }, { id: 'team_denied', slug: 'denied' }, { id: 'team_allowed', slug: 'allowed' },
    ] })
    return String(url).includes('team_denied') ? Response.json({}, { status: 403 }) : Response.json({ balance: '0' })
  })
  assert.deepEqual(await auth.getGrantedTeam('user-token'), { teamId: 'team_allowed', teamSlug: 'allowed' })
  assert.equal(seen.length, 3)
  t.mock.method(globalThis, 'fetch', async (url) => String(url).startsWith('https://api.vercel.com')
    ? Response.json({ teams: [{ id: 'team_denied' }] }) : Response.json({}, { status: 401 }))
  await assert.rejects(auth.getGrantedTeam('user-token'), (error) => error.status === 403)
  t.mock.method(globalThis, 'fetch', async (url) => String(url).startsWith('https://api.vercel.com')
    ? Response.json({ teams: [{ id: 'team_denied' }, { id: 'team_other' }] }) : Response.json({}, { status: 503 }))
  await assert.rejects(auth.getGrantedTeam('user-token'), (error) => error.status === 503)
})

test('one throttled or failing team probe hides only that team', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://api.vercel.com')) return Response.json({ teams: [{ id: 'team_throttled' }, { id: 'team_down' }, { id: 'team_ok', slug: 'ok' }] })
    if (String(url).includes('team_throttled')) return Response.json({}, { status: 429 })
    if (String(url).includes('team_down')) throw new TypeError('fetch failed')
    return Response.json({ balance: '12.5' })
  })
  assert.deepEqual(await auth.listGatewayTeams('user-token'), [{ teamId: 'team_ok', teamSlug: 'ok', balance: 12.5 }])
  assert.deepEqual(await auth.getGrantedTeam('user-token'), { teamId: 'team_ok', teamSlug: 'ok' })
})

test('sign-in that cannot start lands on the login page, relative to the requested host', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const prior = process.env.VERCEL_OAUTH_CLIENT_SECRET
  delete process.env.VERCEL_OAUTH_CLIENT_SECRET
  try {
    const response = await signin(new NextRequest('https://untrusted.example/api/auth/signin'))
    assert.equal(response.status, 307)
    assert.equal(response.headers.get('location'), '/login?error=signin_unavailable')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    // The cause is in the server log, not in the response.
    assert.match(logged.mock.calls[0].arguments[0], /"event":"auth:signin:unavailable".*OAuth is not configured/)
  } finally { process.env.VERCEL_OAUTH_CLIENT_SECRET = prior }
})

test('logout rejects cross-origin or missing Origin; same-origin clears both cookies even if revocation fails', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    assert.equal(options.body.get('token'), 'old-access')
    throw new Error('revoke temporarily unavailable')
  })
  for (const origin of [undefined, 'https://attacker.example']) {
    const request = new NextRequest('https://fx0.example/api/auth/signout', { method: 'POST', headers: origin ? { origin } : {} })
    assert.equal((await signout(request)).status, 403)
  }
  assert.equal(calls, 0)
  const request = await requestWithSession('/api/auth/signout', session(), { origin: 'https://fx0.example' })
  const response = await signout(request)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('clear-site-data'), null, 'cached previews revalidate against the session instead')
  await globalThis.__signoutAfter
  assert.equal(calls, 1)
  const cookies = response.headers.getSetCookie()
  assert.ok(cookies.some((value) => value.startsWith(`${secure.SESSION_COOKIE_NAME}=`) && value.includes('Max-Age=0')))
  assert.ok(cookies.some((value) => value.startsWith(`${secure.grantCookieName(session().loginId)}=`) && value.includes('Max-Age=0')))
  assert.ok(cookies.some((value) => value.startsWith(`${protocol.FLOW_COOKIE_NAME}=`) && value.includes('Max-Age=0')))
  assert.ok(cookies.some((value) => value.startsWith('fx0-signed-in=;') && value.includes('Max-Age=0')))
  assert.equal(globalThis.__signedOutUser, 'verified-sub')
})

test('preview deployments trust only their own deployment and branch hosts', () => {
  const saved = { env: process.env.VERCEL_ENV, url: process.env.VERCEL_URL, branch: process.env.VERCEL_BRANCH_URL }
  Object.assign(process.env, { VERCEL_ENV: 'preview', VERCEL_URL: 'fx0-abc.example.dev', VERCEL_BRANCH_URL: 'fx0-git-branch.example.dev' })
  try {
    const request = (host, origin) => ({ headers: new Headers({ host, ...(origin ? { origin } : {}) }) })
    assert.equal(protocol.requestOrigin(request('fx0-git-branch.example.dev'), ''), 'https://fx0-git-branch.example.dev')
    assert.equal(protocol.requestOrigin(request('fx0-abc.example.dev'), ''), 'https://fx0-abc.example.dev')
    assert.throws(() => protocol.requestOrigin(request('evil.example'), ''), /APP_URL is required/)
    assert.doesNotThrow(() => protocol.assertSameOrigin(request('x', 'https://fx0-abc.example.dev'), ''))
    assert.throws(() => protocol.assertSameOrigin(request('x', 'https://evil.example'), ''), /Cross-origin/)
    // A configured APP_URL always wins.
    assert.equal(protocol.requestOrigin(request('fx0-abc.example.dev'), 'https://fx0.vercel.dev'), 'https://fx0.vercel.dev')
  } finally {
    for (const [key, value] of [['VERCEL_ENV', saved.env], ['VERCEL_URL', saved.url], ['VERCEL_BRANCH_URL', saved.branch]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('API auth leaves the readable signed-in hint to login, logout and account bootstrap', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('a fresh session needs no network'))
  const hint = (response) => response.headers.getSetCookie().find((value) => value.startsWith(`${protocol.SIGNED_IN_HINT_COOKIE}=`))
  const steady = await requestWithSession('/api/sessions', session({ expiresAt: Date.now() + 3600_000 }))
  steady.cookies.set(protocol.SIGNED_IN_HINT_COOKIE, '1')
  assert.equal(hint(await requestSession(steady)), undefined)
  const visitor = new NextRequest('https://fx0.example/api/sessions', { headers: { cookie: `${protocol.SIGNED_IN_HINT_COOKIE}=1` } })
  assert.equal(hint(await requestSession(visitor)), undefined)
  assert.equal(hint(await requestSession(await requestWithSession('/api/sessions', session({ expiresAt: Date.now() + 3600_000 })))), undefined)
})
