// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError, assertSessionOwner, claimGuestSessions, isNewSessionId, ownedSessionPage, reserveSession, reserveGuestSession, validSessionId, type AccountUser } from './accounts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { publicUser, resolveGrantedTeam } from './auth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { assertSameOrigin } from './auth-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { withRequestSession } from './request-session.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { isAuthenticatedSession } from './secure-session.ts'
import { getSession, registry } from './session'
import { bindGatewaySession } from './gateway-session'
import { readSessionSummaries, sessionExists } from './journal'
import type { SessionData } from './secure-session'
import type { SessionPage } from './events'
import type { SessionState } from './session'
// @ts-expect-error Node strip-types tests require the source extension.
import { clearGuestSession, createGuestSession, getGuestSession, guestUser, trialEnabled, type GuestSession } from './trial.ts'

export interface UserRouteContext { session: SessionData; user: AccountUser }
export interface ChatRouteContext { session: SessionData | GuestSession; user: AccountUser }
export interface SessionRouteContext extends ChatRouteContext { id: string; host: SessionState; created: boolean }
export interface PromptRouteContext extends ChatRouteContext {
  existing: SessionRouteContext | null
  activate(): Promise<SessionRouteContext>
}

type UserHandler = (request: Request, context: UserRouteContext) => Response | Promise<Response>
type SessionHandler = (request: Request, context: SessionRouteContext) => Response | Promise<Response>

function privateResponse(response: Response): Response {
  if (!/^private\b/i.test(response.headers.get('cache-control') ?? '')) response.headers.set('cache-control', 'private, no-store')
  return response
}

function routeFailure(error: unknown): Response {
  return Response.json({ error: error instanceof AuthError ? error.message : 'Request failed' }, {
    status: error instanceof AuthError ? error.status : 503,
    headers: { 'cache-control': 'private, no-store' },
  })
}

export function withUserRoute(body: UserHandler) {
  return withRequestSession(async (request, session): Promise<Response> => {
    try {
      if (!isAuthenticatedSession(session)) throw new AuthError()
      if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request)
      const response = await body(request, { session, user: publicUser(session) })
      // Never in a shared cache: a route may keep its own private policy (a design
      // preview by revision); anything else stays out of every cache.
      return privateResponse(response)
    } catch (error) {
      return routeFailure(error)
    }
  })
}

// Chat ownership may come from OAuth or the sealed guest cookie. Account/team
// routes still use withUserRoute and never accept the anonymous principal.
export function withChatRoute(body: (request: Request, context: ChatRouteContext) => Response | Promise<Response>, { createGuest = false } = {}) {
  return withRequestSession(async (request, signedIn): Promise<Response> => {
    try {
      let session: SessionData | GuestSession
      if (isAuthenticatedSession(signedIn)) session = signedIn
      else {
        const guest = await getGuestSession()
        if (!guest && (!createGuest || !trialEnabled())) throw new AuthError()
        // No cookie creation, account reservation or prompt before origin proof.
        if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request)
        session = guest ?? await createGuestSession()
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request)
      if ('kind' in session) return privateResponse(await body(request, { session, user: guestUser(session) }))
      // A guest who signs in keeps their chats; the claim runs once, then the cookie goes,
      // so later requests skip the database write.
      const guest = await getGuestSession()
      if (guest) {
        await claimGuestSessions(guest.userId, session.userId)
        await clearGuestSession()
      }
      return privateResponse(await body(request, { session, user: publicUser(session) }))
    } catch (error) { return routeFailure(error) }
  })
}

// Ownership is checked at route entrance, before host creation or body parsing: at
// most one owner SELECT, skipped for a runtime already bound to this user (below).
// Streams/workers retain the bound session, never re-query per event.
async function ownedSession(request: Request, context: ChatRouteContext, submitter = false): Promise<SessionRouteContext> {
  const id = new URL(request.url).searchParams.get('session')
  if (!validSessionId(id)) throw new AuthError(404, 'Session not found')
  // A chat belongs to its owner; billing follows the team the owner has selected
  // now, so a chat can continue under any team the user switches to.
  if (!('kind' in context.session)) await resolveGrantedTeam(context.session)
  // Ownership never changes, and a runtime is bound only after this check passed
  // for that user; deletion drops the runtime and logout unbinds it. So a runtime
  // already bound to this user skips the Neon round trip. Anyone else, or a cold
  // runtime, still gets the authoritative query.
  if (registry().get(id)?.gatewaySession?.userId !== context.user.id) await assertSessionOwner(context.user.id, id)
  const host = getSession(id)
  if (!('kind' in context.session)) bindGatewaySession(host, context.session, { submitter })
  return { ...context, id, host, created: false }
}

export function withSessionRoute(body: SessionHandler) {
  return withChatRoute(async (request, context) => body(request, await ownedSession(request, context)))
}

// New public prompts validate their input, BotID and allowance before reserving
// SQL ownership or a runtime. Existing private chats still prove ownership before
// parsing the body. Only this prompt-specific wrapper can create a chat.
export function withPromptRoute(body: (request: Request, context: PromptRouteContext) => Response | Promise<Response>) {
  return withChatRoute(async (request, context) => {
    if (new URL(request.url).searchParams.get('session') !== 'new') {
      const existing = await ownedSession(request, context, true)
      return body(request, { ...context, existing, activate: async () => existing })
    }
    const team = 'kind' in context.session ? null : await resolveGrantedTeam(context.session)
    return body(request, { ...context, existing: null, activate: async () => {
      const id = team ? await reserveNewSession(context.user, team.teamId) : await reserveNewGuestSession(context.user)
      const host = getSession(id)
      if (!('kind' in context.session)) bindGatewaySession(host, context.session, { submitter: true })
      return { ...context, id, host, created: true }
    } })
  }, { createGuest: true })
}

async function reserveNewGuestSession(user: AccountUser, id = crypto.randomUUID()): Promise<string> {
  if (await sessionExists(id)) throw new AuthError(404, 'Session not found')
  await reserveGuestSession(user, id)
  return id
}

export async function reserveNewSession(user: AccountUser, billingTeamId: string, id = crypto.randomUUID()): Promise<string> {
  if (!isNewSessionId(id)) throw new AuthError(400, 'New sessions require a UUID')
  // Never claim an id that already has journal data or a deletion tombstone.
  if (await sessionExists(id)) throw new AuthError(404, 'Session not found')
  await reserveSession(user, id, billingTeamId)
  return id
}

export async function listOwnedSessions(userId: string, cursor?: string | null): Promise<SessionPage> {
  const { ids, nextCursor } = await ownedSessionPage(userId, cursor)
  return { sessions: await readSessionSummaries(ids), nextCursor, now: Date.now() }
}
