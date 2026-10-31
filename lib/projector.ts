import type { FxAgent, FxStreamLine } from 'libfx'
import { generationErrorMessage } from './output-recovery'
import { tail } from './tools'
import {
  finishTurnWork,
  getActiveTurn,
  projectEvents,
  projectedCursor,
  readEvents,
  readPreviewWaits,
  readSession,
  readTurnWork,
  type TurnSettings,
  type TurnStart,
  type TurnWork,
} from './journal'
import { recordGeneration, recordTurn, type TurnRecord } from './history'
import { readExecutionFunding } from './turn-credential'
import { effectiveEffort, effectiveFast, effectiveModel, INSTANCE, log, type SessionState } from './session'
import type { StreamItem } from './events'
import { TRIAL_MODEL } from './trial-policy'

// The projector copies a chat's libfx stream into fx0's transcript, the
// StreamItem protocol the page already renders. Any route following a chat runs
// one; the cursor check in projectEvents makes each line land once.

type Entry = Omit<StreamItem, 'seq'>

// fx0 sends each message with messageId `m<message id>`.
function messageNumber(messageId: unknown): number | null {
  const match = typeof messageId === 'string' ? /^m([0-9]+)$/.exec(messageId) : null
  return match ? Number(match[1]) : null
}

// The message whose turn a line belongs to.
export function messageIdOf(line: object): number | null {
  return messageNumber((line as { messageId?: unknown }).messageId)
}

export function toolLabel(line: Record<string, unknown>): string | undefined {
  const input = line.input as Record<string, unknown> | undefined
  if (line.name === 'publish_design') {
    const html = typeof input?.html === 'string' ? input.html : null
    return html == null ? 'complete HTML document' : `complete HTML document (${Buffer.byteLength(html, 'utf8')} bytes)`
  }
  if (input && typeof input === 'object') {
    const pick = (name: string) => (typeof input[name] === 'string' ? (input[name] as string) : null)
    const path = pick('path')
    const pattern = pick('pattern')
    let label = pick('command') ?? (pattern && path ? `${pattern} in ${path}` : null) ?? path ?? pick('url') ?? pick('query') ?? pick('task') ?? undefined
    if (!label) {
      const json = JSON.stringify(input)
      label = json.length > 120 ? json.slice(0, 120) + '…' : json
    }
    return label.length > 300 ? label.slice(0, 300) + '…' : label
  }
  if (line.inputTruncated === true && typeof line.inputPreview === 'string') return line.inputPreview.slice(0, 300) + '…'
  return undefined
}

// The transcript items for one libfx line. Pure: the turn bookkeeping that the
// line implies happens after its batch commits.
export function itemsOf(line: FxStreamLine, at: number): Entry[] {
  const id = messageIdOf(line)
  if (id == null) return []
  switch (line.type) {
    case 'turn_start':
      return [{ type: 'turn_start', id, turnId: id, instance: INSTANCE, at }]
    case 'turn_resume':
      return [{ type: 'status', id, turnId: id, text: 'continuing after an interruption…', at }]
    case 'user_message': {
      // A message that joined this turn, which the model now sees.
      const joined = messageNumber(line.id)
      return joined == null || joined === id ? [] : [{ type: 'status', id: joined, turnId: id, text: 'steering the running turn', at }]
    }
    case 'text_delta':
      return line.delta ? [{ type: 'text', delta: line.delta, turnId: id, at }] : []
    case 'reasoning_delta':
      return line.delta ? [{ type: 'reasoning', delta: line.delta, turnId: id, at }] : []
    case 'tool_start':
      return [{ type: 'tool_start', name: line.name || 'tool', command: toolLabel(line as Record<string, unknown>), turnId: id, at }]
    case 'tool_end':
      return [{ type: 'tool_end', name: line.name || 'tool', isError: line.isError === true, content: typeof line.content === 'string' ? tail(line.content) : undefined, toolCallId: line.id, turnId: id, at }]
    case 'turn_end': {
      const truncated = line.stopReason === 'max_output_tokens'
      const failed = truncated || line.stopReason === 'error' || line.stopReason === 'unknown' || (line.stopReason === 'refused' && line.error?.message)
      return [failed
        ? { type: 'error', id, turnId: id, text: generationErrorMessage(truncated ? 'max_output_tokens' : line.error?.message), at }
        : { type: 'done', id, turnId: id, stopReason: line.stopReason, usage: line.usage as StreamItem['usage'], at }]
    }
    default:
      return []
  }
}

// Adjacent deltas of one kind and turn become one item, so a batch writes a few
// transcript entries, not one per token.
export function mergeDeltas(entries: Entry[]): Entry[] {
  const out: Entry[] = []
  for (const entry of entries) {
    const last = out[out.length - 1]
    if (last && (entry.type === 'text' || entry.type === 'reasoning') && last.type === entry.type && last.turnId === entry.turnId) {
      out[out.length - 1] = { ...last, delta: `${last.delta ?? ''}${entry.delta ?? ''}` }
    } else {
      out.push(entry)
    }
  }
  return out
}

// A prompt is sent as `[author] text`; history keeps the text.
function promptText(input: string | undefined): string {
  return (input ?? '').replace(/^\[[^\]]*\] /, '')
}

async function readSettings(host: SessionState) {
  const stored = await readSession(host.id)
  host.preferredModel = stored?.preferredModel ?? null
  host.preferredEffort = stored?.preferredEffort ?? null
  host.preferredFast = stored?.preferredFast ?? null
  return stored
}

// A sponsored turn always runs the free model, whatever the chat has selected.
function turnSettings(host: SessionState, sponsored: boolean): TurnSettings {
  return sponsored
    ? { model: TRIAL_MODEL, effort: 'low', fast: true }
    : { model: effectiveModel(host), effort: effectiveEffort(host), fast: effectiveFast(host) }
}

// A turn's running record, read before its turn_start commits so that the commit
// can mark it running in the same script (see projectEvents). If these reads
// fail, nothing commits and the next follower projects the lines again.
async function readTurnStart(host: SessionState, id: number, input: string | undefined): Promise<TurnStart> {
  const [funding] = await Promise.all([readExecutionFunding(host.id, id), readSettings(host)])
  const credential = funding.ok ? funding.credential : null
  const sponsored = !!credential && 'kind' in credential
  return {
    id,
    startedAt: Date.now(),
    billingTeamId: credential?.teamId ?? null,
    ...(sponsored ? { sponsored: true as const } : {}),
    prompt: promptText(input),
    settings: turnSettings(host, sponsored),
  }
}

// A finished turn's history row, from the work its end left and the transcript
// since it started. `host` carries the chat's settings, for a turn whose start
// was never recorded.
export function turnHistoryRow(host: SessionState, work: TurnWork, events: StreamItem[]): TurnRecord {
  const turn = work.turn ?? null
  const settings = turn?.settings ?? turnSettings(host, !!turn?.sponsored)
  return {
    sessionId: host.id,
    turnId: work.turnId,
    prompt: turn?.prompt ?? '',
    response: events.filter((item) => item.type === 'text' && item.turnId === work.turnId).map((item) => item.delta ?? '').join(''),
    model: settings.model,
    effort: settings.effort,
    fast: settings.fast,
    status: work.type === 'done' ? 'done' : 'error',
    stopReason: work.type === 'done' ? work.stopReason ?? null : null,
    billingTeamId: turn?.billingTeamId ?? null,
    inputTokens: work.usage?.inputTokens ?? null,
    outputTokens: work.usage?.outputTokens ?? null,
    startedAt: turn?.startedAt ?? work.at ?? 0,
  }
}

// Writes the history of every finished turn still waiting: one row per turn and
// one design version, the design as the turn left it. Both inserts are idempotent,
// and a turn's work is removed only once they succeed, so a crash, a database
// error or a second follower can neither lose nor duplicate a row. A failure
// leaves the rest for the next follower of the chat.
export async function finishTurns(host: SessionState): Promise<void> {
  let work: TurnWork[]
  try {
    work = await readTurnWork(host.id)
    if (work.length) await readSettings(host)
  } catch (error) {
    log(host.id, 'history:read:error', { error: errorText(error) })
    return
  }
  for (const item of work) {
    try {
      if (item.design) await recordGeneration(host.id, item.design.revision, item.turnId, item.design.html)
      if (item.type) {
        const events = item.turn ? await readEvents(host.id, Math.max(0, item.turn.startSeq - 1)) : []
        await recordTurn(turnHistoryRow(host, item, events))
      }
      await finishTurnWork(host.id, item.turnId)
    } catch (error) {
      log(host.id, 'history:turn:error', { id: item.turnId, error: errorText(error) })
      return
    }
  }
}

const errorText = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200)

const BATCH_MS = 40

export interface FollowOptions {
  /** Stops following when this aborts. */
  signal?: AbortSignal
  /** Stops after this long with no line while no turn is running. */
  idleMs: number
}

// The preview wait a screenshot call recorded (lib/journal.ts), onto its tool_end.
export async function addPreviewWaits(sessionId: string, entries: Entry[]): Promise<void> {
  const ends = entries.filter((entry) => entry.type === 'tool_end' && entry.toolCallId && entry.name === 'screenshot_design')
  if (!ends.length) return
  const waits = await readPreviewWaits(sessionId, ends.map((entry) => entry.toolCallId!))
  for (const entry of ends) {
    const ms = waits.get(entry.toolCallId!)
    if (ms) entry.previewWaitMs = ms
  }
}

// Follows the chat's libfx stream from the projected cursor. Returns when the
// chat stays idle for idleMs, when the signal aborts, or when another projector
// moved the cursor first (that one carries on).
export async function project(agent: FxAgent, host: SessionState, libfxSessionId: string, options: FollowOptions): Promise<void> {
  // History an earlier follower could not finish, before following on.
  await finishTurns(host)
  let cursor = await projectedCursor(host.id)
  const reader = agent.session(libfxSessionId).stream(cursor).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pending: { line: FxStreamLine; entries: Entry[] }[] = []
  let running = (await getActiveTurn(host.id)) != null
  let stopped = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    stopped = true
    void reader.cancel().catch(() => {})
  }
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = running ? null : setTimeout(stop, options.idleMs)
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  armIdle()

  const commit = async (): Promise<boolean> => {
    const batch = pending
    pending = []
    if (!batch.length) return true
    const toCursor = batch[batch.length - 1].line.cursor ?? cursor
    const entries = mergeDeltas(batch.flatMap((part) => part.entries))
    const starts: Record<number, TurnStart> = {}
    for (const { line } of batch) {
      const id = line.type === 'turn_start' ? messageIdOf(line) : null
      if (id != null && line.type === 'turn_start') starts[id] = await readTurnStart(host, id, line.input)
    }
    await addPreviewWaits(host.id, entries)
    const items = await projectEvents(host.id, cursor, toCursor, entries, starts)
    if (!items) return false
    cursor = toCursor
    let ended = false
    for (const item of items) {
      if (item.type === 'turn_start') running = true
      else if (item.type === 'done' || item.type === 'error') {
        running = false
        ended = true
      }
    }
    if (ended) await finishTurns(host)
    armIdle()
    return true
  }

  // Commits start at most once per BATCH_MS. A line after a quiet spell, such as a
  // turn's first text, commits on the next tick with whatever its read brought;
  // lines that follow inside the window wait for it and go together.
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let committing: Promise<boolean> = Promise.resolve(true)
  let lastCommitAt = -Infinity
  const scheduleCommit = () => {
    flushTimer ??= setTimeout(() => {
      flushTimer = null
      lastCommitAt = performance.now()
      committing = committing.then((ok) => (ok ? commit() : false)).catch((error) => {
        // Nothing committed: the next follower projects these lines again.
        log(host.id, 'projector:error', { error: errorText(error) })
        return false
      }).then((ok) => {
        if (!ok) stop()
        return ok
      })
    }, Math.max(0, lastCommitAt + BATCH_MS - performance.now()))
  }

  try {
    while (!stopped) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const text = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!text) continue
        let line: FxStreamLine
        try { line = JSON.parse(text) as FxStreamLine } catch { continue }
        pending.push({ line, entries: itemsOf(line, Date.now()) })
        if (line.type === 'turn_start') running = true
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = null
        scheduleCommit()
      }
    }
  } catch (error) {
    if (!stopped) log(host.id, 'projector:error', { error: String((error as Error)?.message ?? error).slice(0, 200) })
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
      committing = committing.then((ok) => (ok ? commit() : false))
    }
    await committing.catch(() => false)
    options.signal?.removeEventListener('abort', stop)
  }
}
