'use client'

import { useId, useState, type ReactNode } from 'react'
import {
  IconTerminal,
  IconFileText,
  IconPencilEdit,
  IconGlobe,
  IconQuestion,
  IconCopy,
  IconCheck,
  IconChevronCircleDown,
  IconChevronCircleRight,
} from './geist-icons'
import { fastClick } from '../lib/fast-click'
import type { TurnActivityState } from './chat-state'
import type { ChatEntry } from './thread'

export interface ToolWidgetConfig {
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

const TOOL_WIDGETS: Record<string, ToolWidgetConfig> = {
  read_design: { label: 'read design', icon: IconFileText },
  publish_design: { label: 'publish design', icon: IconPencilEdit },
  edit_design: { label: 'edit design', icon: IconPencilEdit },
  screenshot_design: { label: 'screenshot', icon: IconFileText },
  web_fetch: { label: 'fetch url', icon: IconGlobe },
  web_search: { label: 'web search', icon: IconGlobe },
  ask_user_question: { label: 'ask a question', icon: IconQuestion },
  subagent: { label: 'subagent', icon: IconTerminal },
}

const FALLBACK: ToolWidgetConfig = { label: 'tool', icon: IconTerminal }

const STATUS = {
  running: { label: 'running', className: 'text-foreground-secondary', dot: 'bg-foreground-secondary pulse-dot' },
  done: { label: 'done', className: 'text-muted-foreground', dot: 'bg-border-strong' },
  error: { label: 'failed', className: 'text-error', dot: 'bg-error' },
} as const

const TOOL_ACTIVITY: Record<string, { group: string; one: string; many: string }> = {
  publish_design: { group: 'edits', one: 'published a design', many: 'published designs' },
  edit_design: { group: 'edits', one: 'edited a design', many: 'edited designs' },
  read_design: { group: 'reads', one: 'read a design', many: 'read designs' },
  screenshot_design: { group: 'reads', one: 'checked the design', many: 'checked the design' },
  web_fetch: { group: 'web', one: 'used the web', many: 'used the web' },
  web_search: { group: 'web', one: 'searched the web', many: 'searched the web' },
  ask_user_question: { group: 'questions', one: 'asked for input', many: 'asked for input' },
  subagent: { group: 'subagents', one: 'ran a subagent', many: 'ran subagents' },
}

const toolLabel = (entry: ChatEntry) => (TOOL_WIDGETS[entry.name ?? ''] ?? FALLBACK).label

// `writing` comes from the row: the streaming answer renders outside the group.
function runningSummary(tools: ChatEntry[], writing: boolean): string {
  const runningTool = tools.findLast((entry) => entry.toolStatus === 'running')
  const current = runningTool ? toolLabel(runningTool) : writing ? 'writing' : 'thinking'
  const done = new Set(tools.filter((entry) => entry.toolStatus !== 'running').map(toolLabel))
  return [current, [...done].join(', ')].filter(Boolean).join(' · ')
}

function summarizeActivity(entries: ChatEntry[], state: TurnActivityState, writing: boolean) {
  const tools = entries.filter((entry) => entry.type === 'tool')
  const reasoningCount = entries.filter((entry) => entry.type === 'reasoning').length
  const messageCount = entries.filter((entry) => entry.type === 'text').length
  const running = state === 'running' || tools.some((entry) => entry.toolStatus === 'running')
  const counts = { tools, reasoningCount, messageCount, running }
  if (running) return { ...counts, summary: runningSummary(tools, writing) }

  const phrases = reasoningCount > 0 ? ['reasoned'] : []
  const groups = new Map<string, { count: number; one: string; many: string }>()
  for (const entry of tools) {
    const activity = TOOL_ACTIVITY[entry.name ?? ''] ?? { group: 'tools', one: 'used a tool', many: 'used tools' }
    const current = groups.get(activity.group)
    if (current) current.count++
    else groups.set(activity.group, { count: 1, one: activity.one, many: activity.many })
  }

  phrases.push(...Array.from(groups.values()).map((activity) => (activity.count === 1 ? activity.one : activity.many)))
  if (messageCount > 0) phrases.push(`${messageCount} update${messageCount === 1 ? '' : 's'}`)
  return { ...counts, summary: phrases.join(', ') || 'activity' }
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function ToolWidget({
  name,
  command,
  status,
  content,
  durationMs,
  previewWaitMs,
  callId,
}: {
  name: string
  command?: string
  status: 'running' | 'done' | 'error'
  content?: string
  durationMs?: number
  previewWaitMs?: number
  callId?: number
}) {
  const [open, setOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const outputId = useId()
  const config = TOOL_WIDGETS[name] ?? FALLBACK
  const Icon = config.icon
  const state = STATUS[status]
  const duration = durationMs != null ? formatDuration(durationMs) : null
  const hasOutput = content != null && content !== ''

  const header = (
    <>
      <span className={`size-1.5 shrink-0 rounded-full ${state.dot}`} aria-hidden="true" />
      <Icon size={12} className="shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs font-medium text-foreground">{config.label}</span>
      {command && <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground-tertiary">{command}</code>}
      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {callId != null && <span title="Tool call ID">#{callId}</span>}
        {duration && <span title={previewWaitMs ? `plus ${formatDuration(previewWaitMs)} waiting for the preview to load` : undefined}>{duration}</span>}
        <span role="status" className={`font-medium ${state.className}`}>
          {state.label}
        </span>
        {hasOutput && (
          <span className="text-muted-foreground" aria-hidden="true">
            {open ? <IconChevronCircleDown size={13} /> : <IconChevronCircleRight size={13} />}
          </span>
        )}
      </span>
    </>
  )

  async function copyOutput() {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    window.setTimeout(() => setCopyState('idle'), 1600)
  }

  return (
    <section className="my-1.5 overflow-hidden bg-muted/30 text-card-foreground">
      {hasOutput ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={outputId}
          {...fastClick(() => setOpen((value) => !value))}
          className="flex min-h-7 w-full items-center gap-2 px-2 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {header}
        </button>
      ) : (
        <div className="flex min-h-7 items-center gap-2 px-2 py-1">
          {header}
        </div>
      )}

      {open && hasOutput && (
        <div id={outputId} className="border-t border-border bg-background-2/70">
          <div className="flex min-h-8 items-center justify-between px-2.5">
            <span className="text-[11px] text-foreground-tertiary">output</span>
            <button
              type="button"
              {...fastClick(() => void copyOutput())}
              className="flex min-h-8 items-center gap-1.5 px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copyState === 'copied' ? <IconCheck size={12} /> : <IconCopy size={12} />}
              {copyState === 'copied' ? 'copied' : copyState === 'error' ? 'copy failed' : 'copy'}
            </button>
            <span aria-live="polite" className="sr-only">
              {copyState === 'copied'
                ? 'Tool output copied'
                : copyState === 'error'
                  ? 'Unable to copy tool output'
                  : ''}
            </span>
          </div>
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-mono text-xs leading-5 text-foreground-secondary">
            {content}
          </pre>
        </div>
      )}
    </section>
  )
}

export function ActivityGroup({
  entries,
  state,
  writing,
  renderEntry,
}: {
  entries: ChatEntry[]
  state: TurnActivityState
  writing: boolean
  renderEntry: (entry: ChatEntry) => ReactNode
}) {
  const { summary, tools, reasoningCount, messageCount, running } = summarizeActivity(entries, state, writing)
  const failedCount = tools.filter((entry) => entry.toolStatus === 'error').length

  return (
    <section className="mb-3">
      <div className="flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
        <svg
          className="size-3 shrink-0"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M1.5 8h2.25l1.5-3 3 6 1.5-3h4.75" />
        </svg>
        <span className="min-w-0 flex-1 truncate font-medium">{summary}</span>
        {running && <span className="shrink-0 text-foreground-secondary">running</span>}
        {!running && state === 'failed' && <span className="shrink-0 text-error">failed</span>}
        {!running && state !== 'failed' && failedCount > 0 && (
          <span className="shrink-0 text-error">{failedCount} failed</span>
        )}
        <span className="sr-only">
          {reasoningCount > 0 ? `${reasoningCount} reasoning update${reasoningCount === 1 ? '' : 's'}` : ''}
          {reasoningCount > 0 && tools.length > 0 ? ', ' : ''}
          {tools.length > 0 ? `${tools.length} tool call${tools.length === 1 ? '' : 's'}` : ''}
          {(reasoningCount > 0 || tools.length > 0) && messageCount > 0 ? ', ' : ''}
          {messageCount > 0 ? `${messageCount} interim message${messageCount === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      <div>
        {entries.map((entry) => {
          if (entry.type === 'reasoning') {
            return (
              <div key={entry.key} className="py-1.5 text-xs">
                <p className="text-[11px] text-foreground-tertiary">reasoning</p>
                <p className="mt-1 whitespace-pre-wrap italic leading-5 text-muted-foreground">{entry.text}</p>
              </div>
            )
          }
          if (entry.type === 'tool') {
            return (
              <ToolWidget
                key={entry.key}
                name={entry.name ?? 'tool'}
                command={entry.command}
                status={entry.toolStatus ?? 'done'}
                content={entry.content}
                durationMs={entry.durationMs}
                previewWaitMs={entry.previewWaitMs}
                callId={entry.callId}
              />
            )
          }
          // Entries carry the turn's block margin (mb-3); inside the group only this
          // wrapper's padding spaces them from the tools.
          return (
            <div key={entry.key} className="py-1.5 [&>*]:mb-0">
              {renderEntry(entry)}
            </div>
          )
        })}
      </div>
    </section>
  )
}
