import type { SessionInfo, SessionView, StreamItem } from '../lib/events'
import type { ChatEntry } from './thread'

export const DEFAULT_VIEW: SessionView = { artifactRevision: 0 }

function isHiddenTranscriptStatus(text?: string): boolean {
  const normalized = text?.trim().toLowerCase() ?? ''
  return (
    normalized.startsWith('effort set to ') ||
    normalized === 'fast mode on' ||
    normalized === 'fast mode off' ||
    normalized.startsWith('model set to ') ||
    normalized.startsWith('model request in flight')
  )
}

function withoutHiddenEntries(entries: ChatEntry[]): ChatEntry[] {
  return entries.filter((entry) => !(entry.type === 'status' && isHiddenTranscriptStatus(entry.text)))
}

export function isPreviewOpenFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('view') !== 'chat'
}

export interface ReplayedChatState {
  entries: ChatEntry[]
  view: SessionView
  activeTurnId: number | null
  activeTurnStartedAt: number | null
  startedTurns: Set<number>
  lastSeq: number
  serverInstance: string | null
}

export type TurnActivityState = 'running' | 'succeeded' | 'failed' | 'inactive'

export type ThreadRow =
  | { kind: 'entry'; key: string; entry: ChatEntry; index: number }
  // `writing`: the turn is live and its answer, rendered outside the group, is streaming.
  | { kind: 'activity'; key: string; entries: ChatEntry[]; state: TurnActivityState; writing: boolean }

export function groupThreadEntries(entries: ChatEntry[], activeTurnId: number | null = null): ThreadRow[] {
  const stateByTurn = new Map<number, TurnActivityState>()
  for (const entry of entries) {
    if (entry.turnId == null) continue
    if (entry.type === 'error') stateByTurn.set(entry.turnId, 'failed')
    else if (entry.type === 'divider' && stateByTurn.get(entry.turnId) !== 'failed') {
      stateByTurn.set(entry.turnId, 'succeeded')
    }
  }

  // The answer renders outside the activity group from its first token, in the
  // place it keeps once the turn succeeds, so nothing jumps when the turn ends.
  // While running, the latest text counts as the answer until a tool or more
  // reasoning follows it, which turns it back into narration.
  const finalTextByTurn = new Map<number, ChatEntry>()
  for (const entry of entries) {
    if (entry.turnId == null) continue
    const state = stateByTurn.get(entry.turnId)
    const live = state == null && entry.turnId === activeTurnId
    if (state !== 'succeeded' && !live) continue
    if (entry.type === 'text' && entry.text?.trim()) finalTextByTurn.set(entry.turnId, entry)
    else if (live && (entry.type === 'tool' || entry.type === 'reasoning')) finalTextByTurn.delete(entry.turnId)
  }

  // A turn can publish several revisions (one per edit), but it is one version: its
  // last revision, numbered among the chat's versions. Earlier ones are not shown.
  const lastArtifactByTurn = new Map<number, ChatEntry>()
  for (const entry of entries) {
    if (entry.turnId != null && entry.type === 'artifact') lastArtifactByTurn.set(entry.turnId, entry)
  }
  const versionOf = new Map<ChatEntry, number>()
  const hiddenArtifacts = new Set<ChatEntry>()
  for (const entry of entries) {
    if (entry.type !== 'artifact') continue
    if (entry.turnId != null && lastArtifactByTurn.get(entry.turnId) !== entry) hiddenArtifacts.add(entry)
    else versionOf.set(entry, versionOf.size + 1)
  }

  // A message that joined a turn splits its activity where the model took it,
  // as the fx CLI shows a steer: what the turn did before stays above the
  // message, what it did after goes below. Each part opens where its first
  // entry is; the first keeps the key a whole group has.
  const activityByPart = new Map<string, { turnId: number; entries: ChatEntry[] }>()
  const activityEntries = new Set<ChatEntry>()
  const anchorPart = new Map<number, string>()
  const lastPartOfTurn = new Map<number, string>()
  const partOfTurn = new Map<number, { part: number; messages: number }>()
  let messages = 0
  entries.forEach((entry, index) => {
    if (entry.type === 'user') messages += 1
    if (entry.turnId == null || entry.type === 'user') return
    const previous = partOfTurn.get(entry.turnId)
    const part = previous == null ? 0 : previous.messages === messages ? previous.part : previous.part + 1
    const key = part === 0 ? `activity-turn-${entry.turnId}` : `activity-turn-${entry.turnId}-${part}`
    if (previous?.part !== part) anchorPart.set(index, key)
    partOfTurn.set(entry.turnId, { part, messages })
    lastPartOfTurn.set(entry.turnId, key)
    // The divider (duration and usage) closes the turn below its answer, so it stays out of the group.
    if (entry.type === 'divider' || finalTextByTurn.get(entry.turnId) === entry || lastArtifactByTurn.get(entry.turnId) === entry || hiddenArtifacts.has(entry)) return
    const activity = activityByPart.get(key)
    if (activity) activity.entries.push(entry)
    else activityByPart.set(key, { turnId: entry.turnId, entries: [entry] })
    activityEntries.add(entry)
  })

  const activityRow = (key: string): ThreadRow | null => {
    const activity = activityByPart.get(key)
    if (!activity?.entries.length) return null
    const { turnId } = activity
    const live = !stateByTurn.has(turnId) && turnId === activeTurnId
    // A part a message came after is done, even while its turn goes on.
    const last = lastPartOfTurn.get(turnId) === key
    return {
      kind: 'activity',
      key,
      entries: activity.entries,
      state: stateByTurn.get(turnId) ?? (!last ? 'succeeded' : live ? 'running' : 'inactive'),
      writing: last && live && finalTextByTurn.has(turnId),
    }
  }

  // A turn's activity opens the turn, above its answer, in the order it happened. The
  // group is one collapsed line, so activity arriving mid-answer only changes its label.
  const rows: ThreadRow[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const part = anchorPart.get(index)
    if (part) {
      const row = activityRow(part)
      if (row) rows.push(row)
    }
    if (activityEntries.has(entry) || hiddenArtifacts.has(entry)) continue
    const version = versionOf.get(entry)
    rows.push({ kind: 'entry', key: entry.key, entry: version ? { ...entry, version } : entry, index })
  }
  return rows
}

// Revisions only grow, so a stale snapshot can never move the preview backwards.
export function mergeSessionView(current: SessionView, incoming: SessionView): SessionView {
  return incoming.artifactRevision > current.artifactRevision ? incoming : current
}

export function projectSessionView(view: SessionView, item: StreamItem): SessionView {
  if (item.type !== 'artifact' || item.artifactRevision == null) return view
  return mergeSessionView(view, { artifactRevision: item.artifactRevision })
}

export function shouldAcceptSessionEvent(
  activeSessionId: string,
  sourceSessionId: string,
  item: StreamItem,
  seenSeq: Set<number>,
  snapshotSeq = 0,
): boolean {
  if (sourceSessionId !== activeSessionId) return false
  if (typeof item.seq !== 'number') return true
  if (item.seq <= snapshotSeq || seenSeq.has(item.seq)) return false
  seenSeq.add(item.seq)
  return true
}

// A message waits at the end of the transcript, below the running turn, until
// a turn takes it: it joins the running one, or its own starts. The fx CLI
// shows a steer where the model takes it, so the words a turn writes after a
// message was sent stay above that message.
function isWaiting(entry: ChatEntry): boolean {
  return entry.type === 'user' && entry.waiting === true && entry.failed !== true
}

// Where the messages still waiting start, at the end of the transcript.
function waitingStart(entries: ChatEntry[]): number {
  let index = entries.length
  while (index > 0 && isWaiting(entries[index - 1])) index -= 1
  return index
}

// Adds a turn's entry above the messages still waiting.
function insertEntry(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const at = waitingStart(entries)
  return [...entries.slice(0, at), entry, ...entries.slice(at)]
}

// Message `id` was taken by a turn: it stops waiting where the transcript is
// now, above the messages that still wait. Only that one: libfx takes inputs
// in the order they reach it, which concurrent sends can make differ from the
// order fx0 numbered them.
function placeMessage(entries: ChatEntry[], id: number): ChatEntry[] {
  const start = waitingStart(entries)
  const index = entries.findIndex((entry, at) => at >= start && entry.id === id)
  if (index < 0) return entries
  return [
    ...entries.slice(0, start),
    { ...entries[index], waiting: false },
    ...entries.slice(start).filter((_, at) => at + start !== index),
  ]
}

export function applyStreamItem(entries: ChatEntry[], item: StreamItem): ChatEntry[] {
  const key = item.seq != null ? `s${item.seq}` : `x${item.at ?? Date.now()}`
  // fx0 numbers a turn by the message that starts it: anything of that turn
  // means the message was taken.
  if (item.type !== 'user' && item.type !== 'accepted' && item.turnId != null) entries = placeMessage(entries, item.turnId)
  const joined = joinedMessageId(item)
  if (joined != null) entries = placeMessage(entries, joined)

  if (item.type === 'turn_start' && item.id != null) {
    const recovering = entries.some((entry) => entry.turnId === item.id)
    // Admission/storage can fail before libfx's delayed turn_start is projected.
    // Retain the error explaining the cancellation, even when a start (or a
    // recovery start) replaces the turn's provisional output.
    return recovering ? entries.filter((entry) => entry.turnId !== item.id || entry.type === 'error') : entries
  }

  if (item.type === 'accepted' && item.clientId) {
    const index = entries.findIndex((entry) => entry.type === 'user' && entry.clientId === item.clientId)
    if (index < 0) return entries
    const next = [...entries]
    next[index] = { ...next[index], id: item.id, pending: false, failed: false }
    return next.filter((entry) => entry.key !== `delivery-${item.clientId}`)
  }

  if (item.type === 'user' && item.clientId) {
    const index = entries.findIndex((entry) => entry.type === 'user' && entry.clientId === item.clientId)
    if (index >= 0) {
      const next = [...entries]
      // The server decides whether the DESIGN.md applied (only a chat's first prompt).
      next[index] = { ...next[index], id: item.id, seq: item.seq, key, pending: false, failed: false, designMd: item.designMd?.name }
      return next.filter((entry) => entry.key !== `delivery-${item.clientId}`)
    }
  }

  if (item.type === 'text' || item.type === 'reasoning') {
    const at = waitingStart(entries)
    const last = entries[at - 1]
    if (last?.type === item.type && last.turnId === item.turnId) {
      const next = [...entries]
      next[at - 1] = { ...last, text: (last.text ?? '') + (item.delta ?? '') }
      return next
    }
    return insertEntry(entries, { key, type: item.type, seq: item.seq, turnId: item.turnId, text: item.delta ?? '' })
  }

  if (item.type === 'tool_start' || item.type === 'tool_input') {
    return insertEntry(
      entries,
      {
        key,
        type: 'tool',
        seq: item.seq,
        turnId: item.turnId,
        name: item.name ?? 'tool',
        command: item.command,
        callId: item.callId,
        toolStatus: 'running',
        startedAt: item.at,
      },
    )
  }

  if (item.type === 'tool_end') {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry.type !== 'tool' || entry.toolStatus !== 'running') continue
      const callMatches = item.callId != null ? entry.callId === item.callId : !item.name || entry.name === item.name
      if (!callMatches) continue
      const next = [...entries]
      next[index] = {
        ...entry,
        toolStatus: item.isError ? 'error' : 'done',
        content: item.content,
        durationMs: entry.startedAt != null && item.at != null ? item.at - entry.startedAt : undefined,
      }
      return next
    }
    return entries
  }

  if (item.type === 'question') {
    return insertEntry(entries, { key, type: 'question', seq: item.seq, turnId: item.turnId, qid: item.qid, questions: item.questions })
  }

  if (item.type === 'question_resolved') {
    const index = entries.findIndex((entry) => entry.type === 'question' && entry.qid === item.qid)
    if (index < 0) return entries
    const next = [...entries]
    next[index] = {
      ...next[index],
      resolved: !item.cancelled,
      cancelled: item.cancelled === true,
      answers: item.answers,
    }
    return next
  }

  if (item.type === 'done') {
    return insertEntry(entries, { key, type: 'divider', seq: item.seq, turnId: item.turnId, usage: item.usage, durationMs: item.durationMs })
  }
  if (item.type === 'error') {
    return insertEntry(entries, { key, type: 'error', seq: item.seq, turnId: item.turnId, text: item.text })
  }
  if (item.type === 'status') {
    // A message joining the running turn shows as that message, as in the fx CLI.
    if (joined != null) return entries
    if (isHiddenTranscriptStatus(item.text)) return withoutHiddenEntries(entries)
    return insertEntry(entries, { key, type: 'status', seq: item.seq, turnId: item.turnId, text: item.text })
  }
  if (item.type === 'artifact') {
    return insertEntry(entries, { key, type: 'artifact', seq: item.seq, turnId: item.turnId, artifactRevision: item.artifactRevision })
  }
  if (item.type === 'user') {
    return [
      ...entries,
      {
        key,
        type: 'user',
        seq: item.seq,
        id: item.id,
        clientId: item.clientId,
        author: item.author,
        text: item.text,
        imageCount: item.imageCount,
        images: item.imagePreviews?.map((preview) => ({ data: '', mimeType: 'image/jpeg', preview })),
        designMd: item.designMd?.name,
        waiting: true,
      },
    ]
  }
  return entries
}

const DESIGN_TOOLS = new Set(['publish_design', 'edit_design'])

// What a message the running turn has not taken waits for, as the fx CLI holds
// a steer: one with images runs as the next turn, and any other joins this turn
// once the design or tool in progress finishes. `drafting`: a design streams
// into the preview, which only viewers on the instance running the turn see.
export function waitingLabel(
  entry: ChatEntry,
  entries: ChatEntry[],
  activeTurnId: number | null,
  startedTurns: Set<number>,
  drafting: boolean,
): string | null {
  if (entry.type !== 'user' || entry.pending || entry.id == null || startedTurns.has(entry.id) || activeTurnId == null) return null
  if ((entry.images?.length ?? 0) > 0 || (entry.imageCount ?? 0) > 0) return 'runs next'
  if (drafting) return 'waiting for the design to finish'
  const tool = entries.findLast((item) => item.type === 'tool' && item.turnId === activeTurnId && item.toolStatus === 'running')
  if (tool) return DESIGN_TOOLS.has(tool.name ?? '') ? 'waiting for the design to finish' : 'waiting for the tool to finish'
  return 'waiting to join'
}

// The message a status item says joined another message's running turn, which
// no longer waits.
// When each chat's current activity began on this device, so its counter keeps
// counting after switching to another chat and back. A send while the chat is
// busy keeps the first start; a chat drops its start once its activity ends.
export type ActivityStarts = ReadonlyMap<string, number>

export function startActivity(starts: ActivityStarts, chatId: string, now: number): ActivityStarts {
  return starts.has(chatId) ? starts : new Map(starts).set(chatId, now)
}

// A draft's chat gets its ID once the server accepts its first prompt.
export function renameActivity(starts: ActivityStarts, from: string, to: string): ActivityStarts {
  const at = starts.get(from)
  if (at === undefined) return starts
  const next = new Map(starts)
  next.delete(from)
  return next.set(to, at)
}

export function endActivity(starts: ActivityStarts, chatId: string): ActivityStarts {
  if (!starts.has(chatId)) return starts
  const next = new Map(starts)
  next.delete(chatId)
  return next
}

export function joinedMessageId(item: StreamItem): number | null {
  return item.type === 'status' && item.id != null && item.turnId != null && item.id !== item.turnId ? item.id : null
}

export function replayEvents(
  events: StreamItem[],
  initialView: SessionView = DEFAULT_VIEW,
  initial?: ReplayedChatState,
): ReplayedChatState {
  let entries = initial?.entries ?? []
  let view = initial ? mergeSessionView(initial.view, initialView) : initialView
  let activeTurnId = initial?.activeTurnId ?? null
  let activeTurnStartedAt = initial?.activeTurnStartedAt ?? null
  let serverInstance = initial?.serverInstance ?? null
  let lastSeq = initial?.lastSeq ?? 0
  const startedTurns = new Set(initial?.startedTurns)

  for (const item of events) {
    if (item.seq != null && item.seq <= (initial?.lastSeq ?? 0)) continue
    entries = applyStreamItem(entries, item)
    view = projectSessionView(view, item)
    if (item.instance) serverInstance = item.instance
    if (item.type === 'turn_start') {
      activeTurnId = item.id ?? null
      activeTurnStartedAt = item.at ?? null
      if (item.id != null) startedTurns.add(item.id)
    }
    const joined = joinedMessageId(item)
    if (joined != null) startedTurns.add(joined)
    if (item.type === 'done' || item.type === 'error') {
      activeTurnId = null
      activeTurnStartedAt = null
    }
    if (item.seq != null) lastSeq = Math.max(lastSeq, item.seq)
  }

  return { entries, view, activeTurnId, activeTurnStartedAt, startedTurns, lastSeq, serverInstance }
}

export function upsertSession(
  sessions: SessionInfo[],
  sessionId: string,
  item: StreamItem,
): SessionInfo[] {
  if (!['user', 'turn_start', 'done', 'error'].includes(item.type)) return sessions
  const index = sessions.findIndex((session) => session.id === sessionId)
  const current = index >= 0 ? sessions[index] : null
  const next: SessionInfo = {
    id: sessionId,
    title: current?.title ?? (item.type === 'user' && item.text ? item.text.slice(0, 40) : null),
    createdAt: current?.createdAt ?? item.at ?? Date.now(),
    // Only a prompt moves a chat in the sidebar, as on the server; a turn that
    // starts or ends keeps its place.
    lastActivity: item.type === 'user'
      ? item.at ?? current?.lastActivity ?? Date.now()
      : current?.lastActivity ?? item.at ?? Date.now(),
    busy: item.type === 'user' || item.type === 'turn_start' ? true : item.type === 'done' || item.type === 'error' ? false : current?.busy ?? false,
  }
  if (
    current &&
    current.title === next.title &&
    current.lastActivity === next.lastActivity &&
    current.busy === next.busy
  ) {
    return sessions
  }
  const updated = index >= 0 ? sessions.map((session, i) => (i === index ? next : session)) : [...sessions, next]
  return updated.toSorted((a, b) => b.lastActivity - a.lastActivity)
}
