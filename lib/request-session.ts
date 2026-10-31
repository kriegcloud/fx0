// @ts-expect-error Node strip-types tests require the source extension.
import { localMode, localSession, assertLocalRequest } from './local-mode.ts'
import { NextRequest } from 'next/server.js'
// @ts-expect-error Node strip-types tests require the source extension.
import { needsTokenRefresh, refreshAccessToken, sessionWithRefresh } from './auth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { forwardSessionCookie, grantCookieName, GRANT_COOKIE_PREFIX, isLoginId, logAuth, SESSION_COOKIE_NAME } from './auth-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { logTag } from './auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { getGrantFromRequest, getSessionFromRequest, isAuthenticatedSession, sealSessionCookie, type SessionCookie, type SessionData } from './secure-session.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { loginRevoked } from './turn-credential.ts'

type SessionHandler = (request: Request, session: Partial<SessionData>) => Response | Promise<Response>

// Renewal belongs to the API request that consumes the credential. Pages only
// read identity, and login/logout own selector changes.
export function withRequestSession(body: SessionHandler) {
  return async (request: Request): Promise<Response> => {
    if (localMode()) {
      try {
        assertLocalRequest(request)
        if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== process.env.APP_URL) {
          return Response.json({ error: 'Cross-origin request denied' }, { status: 403 })
        }
      } catch { return Response.json({ error: 'Local access denied' }, { status: 403 }) }
      return body(request, localSession())
    }
    const cookies: SessionCookie[] = []
    let response: Response
    try {
      const incoming = request instanceof NextRequest ? request : new NextRequest(request.url, { headers: request.headers })
      const selector = incoming.cookies.get(SESSION_COOKIE_NAME)?.value
      const selectedName = isLoginId(selector) ? grantCookieName(selector) : undefined
      const obsolete = incoming.cookies.getAll()
        .filter(({ name }) => name.startsWith(GRANT_COOKIE_PREFIX) && name !== selectedName &&
          isLoginId(name.slice(GRANT_COOKIE_PREFIX.length)))
        .slice(0, 8)
      cookies.push(...await Promise.all(obsolete.map(({ name }) => sealSessionCookie(null, name.slice(GRANT_COOKIE_PREFIX.length)))))

      const grant = await getGrantFromRequest(incoming)
      // A signed-out login's grant is no session, even replayed from a copy: the
      // request runs signed out, its grant cookie is cleared, and it never refreshes.
      const revoked = isAuthenticatedSession(grant) && await loginRevoked(grant.loginId)
      if (revoked) cookies.push(await sealSessionCookie(null, grant.loginId))
      let sealed: SessionCookie | undefined
      let expiresAt = grant.expiresAt ?? 0
      if (!revoked && isAuthenticatedSession(grant) && needsTokenRefresh(grant)) {
        const result = await refreshAccessToken(grant.refreshToken!)
        if (result.status === 'terminal') {
          sealed = await sealSessionCookie(null, grant.loginId)
        } else if (result.status === 'ok') {
          const refreshed = sessionWithRefresh(grant, result)
          expiresAt = refreshed.expiresAt
          sealed = await sealSessionCookie(refreshed)
        }
        if (sealed) cookies.push(sealed)
        if (result.status !== 'transient') {
          // Session age separates a token that outlived its grant from a recent
          // login whose rotated cookie never reached this browser.
          const now = Date.now()
          logAuth(result.status === 'ok' ? 'auth:session:renewed' : 'auth:session:ended', {
            user: logTag(grant.userId), login: logTag(grant.loginId), rt: logTag(grant.refreshToken!),
            sessionAgeS: Math.round((now - grant.loginAt) / 1000), accessExpiresInS: Math.round((grant.expiresAt - now) / 1000),
          }, result.status === 'ok' ? 'info' : 'error')
        }
      }

      if (!revoked && isAuthenticatedSession(grant) && expiresAt <= Date.now() && sealed?.value !== '') {
        response = Response.json({ error: 'Authentication temporarily unavailable. Retry shortly.' }, {
          status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
        })
      } else {
        let forwarded = request
        let sessionRequest = incoming
        if (cookies.length) {
          let headers = new Headers(incoming.headers)
          for (const cookie of cookies) headers = forwardSessionCookie(headers, cookie.cookieName, cookie.value || null)
          // Next wraps route requests in a Proxy, which native Request cannot
          // clone. Rebuild from the URL; NextRequest handles streaming duplex.
          sessionRequest = new NextRequest(request.url, {
            method: request.method, headers, body: request.body, signal: request.signal,
          })
          forwarded = sessionRequest
        }
        response = await body(forwarded, await getSessionFromRequest(sessionRequest))
      }
    } catch {
      response = Response.json({ error: 'Request failed' }, { status: 503, headers: { 'cache-control': 'private, no-store' } })
    }

    // Keep rotation on errors and streams too. Rewrap headers without reading or
    // buffering the response body, which may already be an open event stream.
    const headers = new Headers(response.headers)
    for (const cookie of cookies) headers.append('set-cookie', cookie.setCookie)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
