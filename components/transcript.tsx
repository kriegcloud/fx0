'use client'

import { memo, useCallback, useMemo } from 'react'
import { groupThreadEntries, waitingLabel, type TurnActivityState } from './chat-state'
import { ThreadEntry, type ChatEntry } from './thread'
import { ActivityGroup } from './tool-widget'
import { fastClick } from '../lib/fast-click'
import { Skeleton } from './ui/skeleton'
import { canRecoverOutput, OUTPUT_RECOVERY_PROMPT } from '../lib/output-recovery'

const SUGGESTIONS = [
  'Design a landing page for a CLI coding agent',
  'Create a polished pricing page',
  'Design an analytics dashboard',
]

interface ActivityProps {
  entries: ChatEntry[]
  state: TurnActivityState
  writing: boolean
  sessionId: string
  onOpenRevision?: (revision: number) => void
}

const TranscriptActivity = memo(function TranscriptActivity({ entries, state, writing, sessionId, onOpenRevision }: ActivityProps) {
  const renderEntry = useCallback((entry: ChatEntry) => (
    <ThreadEntry sessionId={sessionId} entry={entry} waiting={null} onOpenRevision={onOpenRevision} />
  ), [sessionId, onOpenRevision])
  return <ActivityGroup entries={entries} state={state} writing={writing} renderEntry={renderEntry} />
}, (a, b) => (
  a.state === b.state && a.writing === b.writing && a.sessionId === b.sessionId && a.onOpenRevision === b.onOpenRevision &&
  a.entries.length === b.entries.length && a.entries.every((entry, index) => entry === b.entries[index])
))

export default memo(function Transcript({ sessionId, entries, activeTurnId, startedTurns, drafting, onOpenRevision, onSend }: {
  sessionId: string
  entries: ChatEntry[]
  activeTurnId: number | null
  startedTurns: number[]
  // A design streams into the preview while the model writes it.
  drafting: boolean
  onOpenRevision?: (revision: number) => void
  onSend: (text: string) => unknown
}) {
  const rows = useMemo(() => groupThreadEntries(entries, activeTurnId), [entries, activeTurnId])
  const started = useMemo(() => new Set(startedTurns), [startedTurns])
  return (
    <>
      {entries.length === 0 && (
        // A chat loading from its URL: the shape of a first message and its answer.
        <div aria-hidden="true" className="hidden [html.chat-url_&]:block">
          <div className="mb-4 flex justify-end"><Skeleton className="h-9 w-3/5" /></div>
          <div className="space-y-2.5">
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      )}
      {entries.length === 0 && (
        <div className="mx-auto mt-[12vh] max-w-xl [html.chat-url_&]:hidden">
          <div className="mt-6 space-y-0.5">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                {...fastClick(() => onSend(suggestion))}
                className="group flex min-h-10 w-full items-center gap-3 px-2 py-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="flex-1">{suggestion}</span>
                <svg
                  viewBox="0 0 16 16"
                  className="size-3.5 opacity-50 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                  fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"
                >
                  <path d="M3 8h10M9 4l4 4-4 4" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}
      {rows.map((row) => row.kind === 'activity' ? (
        <TranscriptActivity
          key={row.key} sessionId={sessionId} entries={row.entries}
          state={row.state} writing={row.writing} onOpenRevision={onOpenRevision}
        />
      ) : (
        <ThreadEntry
          key={row.key} sessionId={sessionId} entry={row.entry} onOpenRevision={onOpenRevision}
          waiting={waitingLabel(row.entry, entries, activeTurnId, started, drafting)}
        />
      ))}
      {canRecoverOutput(entries, activeTurnId) && (
        <button
          type="button"
          {...fastClick(() => onSend(OUTPUT_RECOVERY_PROMPT))}
          className="mb-3 rounded border border-border px-3 py-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          Continue in smaller steps
        </button>
      )}
    </>
  )
})
