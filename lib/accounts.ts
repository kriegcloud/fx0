// @ts-expect-error Node strip-types tests require the source extension.
import { localMode } from './local-mode.ts'
// Server-only account metadata and authoritative chat ownership; no OAuth tokens.
// @ts-expect-error Node strip-types tests require the source extension.
import { validSessionId } from './session-id.ts'

export { validSessionId }

export interface AccountUser {
  id: string
  name: string
  email: string | null
  picture: string | null
  guest?: true
}

export class AuthError extends Error {
  status: number
  constructor(status = 401, message = 'Sign in required') {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

export type AccountQuery = (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>

export const SESSION_PAGE_SIZE = 40
type SessionCursor = { at: string; id: string }
function decodeSessionCursor(value?: string | null): SessionCursor | null {
  if (!value) return null
  try {
    if (value.length > 300) throw new Error()
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString())
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || !validSessionId(parsed.id)) throw new Error()
    return parsed
  } catch { throw new AuthError(400, 'Invalid chat list cursor') }
}

// Neon HTTP has no request-owned connection or pool to drain. Never issue BEGIN
// across HTTP calls: writes needing atomicity are expressed as one SQL statement.
export async function withAccountDatabase<T>(work: (query: AccountQuery) => Promise<T>, { timeoutMs }: { timeoutMs?: number } = {}): Promise<T> {
  if (typeof window !== 'undefined') throw new Error('Accounts are server only')
  if (localMode()) {
    const { localDatabase } = await import('./local-database')
    const db = await localDatabase()
    return work(async (text, values = []) => (await db.query<Record<string, unknown>>(text, values)).rows)
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(connectionString)
  return work(async (text, values = []) => await sql.query(text, values,
    timeoutMs ? { fetchOptions: { signal: AbortSignal.timeout(timeoutMs) } } : undefined) as Record<string, unknown>[])
}

export function isNewSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
}

function validateIds(userId: string, sessionId?: string): void {
  if (!userId || userId.length > 256) throw new AuthError(400, 'Invalid account ID')
  if (sessionId !== undefined && !validSessionId(sessionId)) throw new AuthError(404, 'Session not found')
}

// Injection stays at the DB boundary; tests exercise production ownership SQL.
export function createAccountStore(query: AccountQuery) {
  async function reserve(user: AccountUser, sessionId: string, billingTeamId: string | null): Promise<void> {
    validateIds(user.id, sessionId)
    if (!isNewSessionId(sessionId)) throw new AuthError(400, 'New sessions require a UUID')
    const rows = await query(`WITH account AS (
        INSERT INTO fx0_accounts (id, name, email, picture) VALUES ($2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
          picture = EXCLUDED.picture, updated_at = now()
        RETURNING id
      )
      INSERT INTO fx0_chat_ownership (session_id, user_id, billing_team_id)
      SELECT $1, id, $6 FROM account
      ON CONFLICT (session_id) DO NOTHING RETURNING session_id`,
      [sessionId, user.id, user.name, user.email, user.picture, billingTeamId])
    if (!rows.length) throw new AuthError(404, 'Session not found')
  }
  return {
    async upsertAccount(user: AccountUser): Promise<void> {
      validateIds(user.id)
      await query(`INSERT INTO fx0_accounts (id, name, email, picture) VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
          picture = EXCLUDED.picture, updated_at = now()`, [user.id, user.name, user.email, user.picture])
    },
    async assertSessionOwner(userId: string, sessionId: string): Promise<void> {
      validateIds(userId, sessionId)
      const [row] = await query('SELECT user_id FROM fx0_chat_ownership WHERE session_id = $1', [sessionId])
      if (!row || row.user_id !== userId) throw new AuthError(404, 'Session not found')
    },
    // Caller must prove Redis absence before reservation. UUIDs only; the owner
    // changes only when its guest cookie is claimed by a verified login.
    // billing_team_id records the team the chat started with; each
    // turn records the team it actually billed (fx0_turns.billing_team_id).
    async reserveSession(user: AccountUser, sessionId: string, billingTeamId: string): Promise<void> {
      if (typeof billingTeamId !== 'string' || !billingTeamId.startsWith('team_')) {
        throw new AuthError(403, 'Grant a Vercel team with AI Gateway access')
      }
      return reserve(user, sessionId, billingTeamId)
    },
    async reserveGuestSession(user: AccountUser, sessionId: string): Promise<void> {
      if (!user.guest || !/^guest:[0-9a-f]{32}$/.test(user.id)) throw new AuthError(403, 'Invalid guest identity')
      return reserve(user, sessionId, null)
    },
    async claimGuestSessions(guestId: string, userId: string): Promise<void> {
      if (!/^guest:[0-9a-f]{32}$/.test(guestId) || userId.startsWith('guest:')) throw new AuthError(403, 'Invalid guest identity')
      validateIds(userId)
      await query('UPDATE fx0_chat_ownership SET user_id = $1 WHERE user_id = $2', [userId, guestId])
    },
    async ownedSessionIds(userId: string): Promise<string[]> {
      validateIds(userId)
      const rows = await query('SELECT session_id FROM fx0_chat_ownership WHERE user_id = $1 ORDER BY created_at DESC, session_id', [userId])
      return rows.map((row) => String(row.session_id))
    },
    async removeOwnedSession(userId: string, sessionId: string): Promise<void> {
      validateIds(userId, sessionId)
      const rows = await query('DELETE FROM fx0_chat_ownership WHERE session_id = $1 AND user_id = $2 RETURNING session_id', [sessionId, userId])
      if (!rows.length) throw new AuthError(404, 'Session not found')
    },
    async ownedSessionPage(userId: string, cursor?: string | null): Promise<{ ids: string[]; nextCursor: string | null }> {
      validateIds(userId)
      const position = decodeSessionCursor(cursor)
      const rows = await query(`SELECT session_id, updated_at::text AS activity_at FROM fx0_chat_ownership
        WHERE user_id = $1 AND title IS NOT NULL
          AND ($2::timestamptz IS NULL OR (updated_at, session_id) < ($2::timestamptz, $3::text))
        ORDER BY updated_at DESC, session_id DESC LIMIT $4`, [userId, position?.at ?? null, position?.id ?? null, SESSION_PAGE_SIZE + 1])
      const page = rows.slice(0, SESSION_PAGE_SIZE)
      const last = page.at(-1)
      return { ids: page.map((row) => String(row.session_id)), nextCursor: rows.length > SESSION_PAGE_SIZE && last
        ? Buffer.from(JSON.stringify({ at: last.activity_at, id: last.session_id })).toString('base64url') : null }
    },
    async touchOwnedSession(userId: string, sessionId: string, title: string, at: number): Promise<void> {
      validateIds(userId, sessionId)
      // Even an image-only prompt marks the row as populated; reservations do not.
      await query(`UPDATE fx0_chat_ownership SET title = COALESCE(title, $3), updated_at = GREATEST(updated_at, to_timestamp($4 / 1000.0))
        WHERE session_id = $1 AND user_id = $2`, [sessionId, userId, [...title].slice(0, 40).join(''), at])
    },
  }
}

export async function upsertAccount(user: AccountUser): Promise<void> {
  return withAccountDatabase((query) => createAccountStore(query).upsertAccount(user))
}

export async function assertSessionOwner(userId: string, sessionId: string): Promise<void> {
  return withAccountDatabase((query) => createAccountStore(query).assertSessionOwner(userId, sessionId))
}

export async function reserveSession(user: AccountUser, sessionId: string, billingTeamId: string): Promise<void> {
  return withAccountDatabase((query) => createAccountStore(query).reserveSession(user, sessionId, billingTeamId))
}

export async function ownedSessionIds(userId: string): Promise<string[]> {
  return withAccountDatabase((query) => createAccountStore(query).ownedSessionIds(userId))
}

export async function ownedSessionPage(userId: string, cursor?: string | null) {
  return withAccountDatabase((query) => createAccountStore(query).ownedSessionPage(userId, cursor))
}

export async function touchOwnedSession(userId: string, sessionId: string, title: string, at: number): Promise<void> {
  return withAccountDatabase((query) => createAccountStore(query).touchOwnedSession(userId, sessionId, title, at), { timeoutMs: 5000 })
}

// Call only after durable Redis cleanup succeeds, never in a finally block.
export async function removeOwnedSession(userId: string, sessionId: string): Promise<void> {
  return withAccountDatabase((query) => createAccountStore(query).removeOwnedSession(userId, sessionId))
}

export async function reserveGuestSession(user: AccountUser, sessionId: string): Promise<void> {
  return withAccountDatabase(query => createAccountStore(query).reserveGuestSession(user, sessionId))
}

export async function claimGuestSessions(guestId: string, userId: string): Promise<void> {
  return withAccountDatabase(query => createAccountStore(query).claimGuestSessions(guestId, userId))
}
