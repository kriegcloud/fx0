import { appendEvent } from './journal'
import { redactSecrets } from './auth-crypto'
import { sanitizeSessionId } from './session-id'
import type { StreamItem } from './events'

const KEY = '__fx0Sessions'
export const DEFAULT_MODEL = 'anthropic/claude-opus-5.5-fast'

// libfx leaves step budgets to the host. Without this cap, a turn or subagent that
// keeps calling tools would run, and bill, until the function times out. The
// agent's fetch enforces it (libfx-agent.ts).
export const MAX_TURN_MODEL_STEPS = 64

// Instance id distinguishes function instances in logs — a different instance
// id mid-conversation is the multi-instance split made visible.
export const INSTANCE = Math.random().toString(36).slice(2, 6)

function logLine(level: 'info' | 'error', sessionId: string, event: string, detail?: Record<string, unknown>): void {
  console[level](JSON.stringify({ at: new Date().toISOString(), instance: INSTANCE, session: sessionId, event, ...detail }))
}

export function log(sessionId: string, event: string, detail?: Record<string, unknown>): void {
  logLine('info', sessionId, event, detail)
}

// ACP-shaped image block, validated and bounded by libfx at prompt time.
export interface PromptImage {
  type: 'image'
  data: string
  mimeType: string
}

// What one process keeps per chat. libfx owns the conversation and runs its
// turns; the journal owns the transcript and the chat's settings.
export interface SessionState {
  id: string
  // The signed-in caller's credential, bound by the route; the prompt route
  // stores it as the chat's turn credential.
  gatewaySession: import('./secure-session').SessionData | null
  // Set while this process deletes the chat.
  busy: boolean
  emitTail: Promise<void>
  toolSeq: number
  toolOutputs: Map<number, string>
  preferredModel: string | null
  preferredEffort: string | null
  preferredFast: boolean | null
  // The chat's DESIGN.md, loaded with its stored hash; part of the agent instructions.
  designMd: { name: string; sha: string; text: string } | null
}

function createState(id: string): SessionState {
  return {
    id,
    gatewaySession: null,
    busy: false,
    emitTail: Promise.resolve(),
    toolSeq: 0,
    toolOutputs: new Map(),
    preferredModel: null,
    preferredEffort: null,
    preferredFast: null,
    designMd: null,
  }
}

export function registry(): Map<string, SessionState> {
  const g = globalThis as unknown as Record<string, Map<string, SessionState> | undefined>
  if (!g[KEY]) g[KEY] = new Map()
  return g[KEY]
}

export function getSession(rawId: string | null | undefined): SessionState {
  const id = sanitizeSessionId(rawId)
  const sessions = registry()
  if (!sessions.has(id)) sessions.set(id, createState(id))
  return sessions.get(id)!
}

// Real error causes are shown to users and logs, as on main. libfx never holds the
// OAuth token (it gets a placeholder apiKey) and Gateway bodies are scrubbed in the
// transport; this still strips anything bearer- or token-shaped as a last guard.
export function errorText(error: unknown): string {
  return redactSecrets(String((error as Error)?.message ?? error)).slice(0, 500)
}


export function effectiveModel(host: SessionState): string {
  return host.preferredModel ?? process.env.FX0_MODEL ?? DEFAULT_MODEL
}

export function effectiveFast(host: SessionState): boolean {
  return host.preferredFast ?? false
}

export function effectiveEffort(host: SessionState): string {
  return host.preferredEffort ?? process.env.FX0_EFFORT ?? 'low'
}

// Transcript items a tool writes directly (questions, status), in order per chat.
export function emit(host: SessionState, entry: Omit<StreamItem, 'seq' | 'at'> & { at?: number }): Promise<void> {
  host.emitTail = host.emitTail
    .then(async () => {
      const item = await appendEvent(host.id, { ...entry, instance: entry.instance ?? INSTANCE })
      if (item.type !== 'text' && item.type !== 'reasoning') {
        log(host.id, `emit:${item.type}`, { seq: item.seq, id: item.id, turnId: item.turnId, qid: item.qid, text: (item.text ?? '').slice(0, 120) || undefined })
      }
    })
    .catch(() => logLine('error', host.id, 'journal:event:error', { error: 'journal event write failed' }))
  return host.emitTail
}

// Page render only needs these three fields, so it derives them from the stored
// record instead of hydrating a session.
export interface GenerationPreference {
  model: string
  effort: string
  fast: boolean
}

// The session record wins; the fallback is the viewer's last choice, so a new
// chat opens on the model they were using instead of the app default.
export function generationOptionsFor(
  stored: { preferredModel: string | null; preferredEffort: string | null; preferredFast: boolean | null } | null,
  fallback: Partial<GenerationPreference> = {},
): GenerationPreference {
  return {
    model: stored?.preferredModel ?? fallback.model ?? '',
    effort: stored?.preferredEffort ?? fallback.effort ?? '',
    fast: stored?.preferredFast ?? fallback.fast ?? false,
  }
}
