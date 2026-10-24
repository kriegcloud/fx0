import { localMode } from '../../../lib/local-mode'
import { createHash } from 'node:crypto'
import { AuthError } from '../../../lib/accounts'
import { listGatewayTeams, type GatewayTeam } from '../../../lib/auth'
import { withUserRoute } from '../../../lib/route-auth'
import { teamCookie } from '../../../lib/secure-session'

export const maxDuration = 30

// Probing costs one Gateway request per team, so the list is cached briefly per
// grant. Keys never cross users or rotated tokens.
const cache = new Map<string, { at: number; teams: GatewayTeam[] }>()

async function gatewayTeams(accessToken: string): Promise<GatewayTeam[]> {
  const key = createHash('sha256').update(accessToken).digest('hex')
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.teams
  const teams = await listGatewayTeams(accessToken)
  if (cache.size >= 100) cache.delete(cache.keys().next().value!)
  cache.set(key, { at: Date.now(), teams })
  return teams
}

// A failed listing is about Vercel's team API, not the fx0 session: answering 401/403
// would make the client treat it as a lost grant and block sending.
export const GET = withUserRoute(async (_request, { session }) => {
  if (localMode()) return Response.json({ teams: [{ teamId: 'team_local', teamSlug: 'CLIProxyAPI subscriptions', balance: null }], current: 'team_local' })
  try {
    return Response.json({ teams: await gatewayTeams(session.accessToken), current: session.teamId ?? null })
  } catch {
    return Response.json({ error: 'Unable to list teams', teams: [], current: session.teamId ?? null }, { status: 502 })
  }
})

// Only a team Gateway accepts for this user's own token can be chosen.
export const POST = withUserRoute(async (request, { session }) => {
  if (localMode()) return Response.json({ error: 'Subscriptions are managed in CLIProxyAPI' }, { status: 400 })
  const body = await request.json().catch(() => null) as { teamId?: unknown } | null
  const teams = await gatewayTeams(session.accessToken).catch(() => {
    throw new AuthError(502, 'Unable to verify team access. Try again.')
  })
  const team = teams.find(({ teamId }) => teamId === body?.teamId)
  if (!team) throw new AuthError(400, 'That team does not have AI Gateway access for this account')
  const cookie = await teamCookie(session.loginId, { teamId: team.teamId, teamSlug: team.teamSlug })
  return Response.json({ teamId: team.teamId, teamSlug: team.teamSlug }, { headers: { 'set-cookie': cookie.setCookie } })
})
