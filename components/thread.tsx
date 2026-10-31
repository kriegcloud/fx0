'use client'

import { memo, useId, useRef, useState, type ReactNode } from 'react'
import ImagePreview from './image-preview'
import Markdown from './markdown'
import { AuthRouteError, fetchUi } from './auth-ui'
import { formatDuration } from './tool-widget'
import { fastClick } from '../lib/fast-click'
import { generationErrorMessage } from '../lib/output-recovery'

function QuestionWidget({ entry, sessionId }: { entry: ChatEntry; sessionId: string }) {
  const groupId = useId()
  const firstQuestionRef = useRef<HTMLFieldSetElement>(null)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const questions = entry.questions ?? []
  const allAnswered = questions.every((question) => selected[question.question])

  async function submit() {
    if (!allAnswered) {
      setSubmitError('Choose an answer for each question.')
      firstQuestionRef.current?.focus()
      return
    }

    setSubmitting(true)
    setSubmitError('')
    try {
      const response = await fetchUi(`/api/answer?session=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qid: entry.qid, answers: selected }),
      })
      const result = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || 'The answer was not accepted.')
      }
    } catch (error) {
      if (error instanceof AuthRouteError) return
      setSubmitError(`${(error as Error).message} Review your choices and try again.`)
    } finally {
      setSubmitting(false)
    }
  }

  // Same language as the effort list: plain rows, the choice in bright semibold,
  // the rest dim. No box, no header, no radio chrome.
  return (
    <section className="my-3 border-l border-border pl-3" aria-labelledby={`${groupId}-title`}>
      <div className="space-y-4">
        {questions.map((question, questionIndex) => (
          <fieldset
            key={question.question}
            ref={questionIndex === 0 ? firstQuestionRef : undefined}
            tabIndex={-1}
            className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <legend id={questionIndex === 0 ? `${groupId}-title` : undefined} className="text-sm leading-5">
              {question.question}
            </legend>
            <div className="mt-1.5">
              {question.options.map((option) => {
                const chosenValue = entry.resolved ? entry.answers?.[question.question] : selected[question.question]
                const isChosen = chosenValue === option.label
                return (
                  <label
                    key={option.label}
                    className="flex cursor-pointer items-baseline gap-2 py-0.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-disabled:cursor-default"
                  >
                    <input
                      type="radio"
                      name={`${groupId}-${questionIndex}`}
                      value={option.label}
                      checked={isChosen}
                      disabled={entry.resolved || entry.cancelled || submitting}
                      onChange={() => {
                        setSelected((current) => ({ ...current, [question.question]: option.label }))
                        setSubmitError('')
                      }}
                      className="sr-only"
                    />
                    <span aria-hidden="true" className={`w-3 shrink-0 ${isChosen ? 'text-foreground' : 'text-transparent'}`}>
                      ›
                    </span>
                    <span className={isChosen ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="min-w-0 truncate text-xs text-foreground-tertiary">{option.description}</span>
                    )}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {!entry.resolved && !entry.cancelled && (
        <button
          type="button"
          {...fastClick(() => void submit())}
          disabled={submitting || !allAnswered}
          className="mt-3 font-mono text-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-foreground-tertiary disabled:no-underline"
        >
          {submitting ? 'sending…' : 'send'}
        </button>
      )}
      {submitError && (
        <p role="alert" className="mt-2 text-xs text-error">
          {submitError}
        </p>
      )}
      {entry.cancelled && <p className="mt-2 text-xs text-muted-foreground">cancelled</p>}
    </section>
  )
}

export interface ChatEntry {
  key: string
  type:
    | 'user'
    | 'text'
    | 'tool'
    | 'status'
    | 'artifact'
    | 'error'
    | 'divider'
    | 'question'
    | 'reasoning'
  seq?: number
  clientId?: string
  id?: number
  turnId?: number
  author?: string
  text?: string
  images?: { data: string; mimeType: string; preview: string }[]
  imageCount?: number
  // The DESIGN.md this prompt started the chat with, for display.
  designMd?: string
  // A design's place among the chat's versions (one per turn), for display.
  version?: number
  pending?: boolean
  failed?: boolean
  // A message no turn has taken yet: it shows below the running turn.
  waiting?: boolean
  name?: string
  command?: string
  toolStatus?: 'running' | 'done' | 'error'
  content?: string
  startedAt?: number
  durationMs?: number
  // Part of a tool call spent waiting for the preview, left out of durationMs.
  previewWaitMs?: number
  artifactRevision?: number
  qid?: number
  questions?: { question: string; options: { label: string; description?: string }[] }[]
  answers?: Record<string, string>
  resolved?: boolean
  cancelled?: boolean
  callId?: number
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
}

function EventLine({ action, detail, children }: { action: string; detail?: string; children?: ReactNode }) {
  return (
    <p className="mb-3 flex items-start gap-2 text-xs leading-5">
      <span className="shrink-0 font-medium text-foreground-secondary">{action}</span>
      {detail && <span className="min-w-0 whitespace-pre-wrap text-muted-foreground">{detail}</span>}
      {children}
    </p>
  )
}

const renderers: Record<string, (entry: ChatEntry, waiting: string | null, sessionId: string, onOpenRevision?: (revision: number) => void) => ReactNode> = {
  user: (entry, waiting) => (
    <div className="mb-4 flex justify-end">
      <div
        className={`max-w-[86%] bg-secondary px-3 py-2 text-sm leading-5 text-secondary-foreground sm:max-w-[80%] ${
          entry.pending ? 'opacity-65' : ''
        } ${entry.failed ? 'ring-1 ring-error/50' : ''}`}
      >
        <span className="whitespace-pre-wrap break-words">{entry.text}</span>
        {entry.images && entry.images.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-2">
            {entry.images.map((image, index) => (
              <ImagePreview
                key={index}
                src={image.preview}
                alt={`Attached image ${index + 1}`}
                className="h-auto max-h-20 w-auto max-w-40 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              />
            ))}
          </span>
        )}
        {!entry.images && (entry.imageCount ?? 0) > 0 && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {entry.imageCount} image{entry.imageCount === 1 ? '' : 's'} attached
          </span>
        )}
        {entry.designMd && (
          <span className="mt-1 block text-xs text-muted-foreground">
            design.md: <span className="text-secondary-foreground">{entry.designMd}</span>
          </span>
        )}
        {entry.failed && <span className="ml-2 text-xs text-error">not sent</span>}
        {waiting && <span className="ml-2 text-xs text-muted-foreground">{waiting}</span>}
      </div>
    </div>
  ),

  text: (entry) => (
    <div className="mb-3">
      <Markdown>{entry.text ?? ''}</Markdown>
    </div>
  ),

  question: (entry, _waiting, sessionId) => <QuestionWidget entry={entry} sessionId={sessionId} />,
  status: (entry) => <EventLine action={entry.text?.trim() || 'status update'} />,
  artifact: (entry, _waiting, _sessionId, onOpenRevision) => (
    <EventLine
      action="design published"
      detail={entry.version != null ? `version ${entry.version}` : entry.artifactRevision != null ? `revision ${entry.artifactRevision}` : undefined}
    >
      {onOpenRevision && entry.artifactRevision != null && (
        <button
          type="button"
          {...fastClick(() => onOpenRevision(entry.artifactRevision!))}
          className="shrink-0 text-blue-hover underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          View
        </button>
      )}
    </EventLine>
  ),
  error: (entry) => (
    <div role="alert" className="my-2 bg-error/10 px-3 py-2 text-sm leading-5 text-error">
      {generationErrorMessage(entry.text)}
    </div>
  ),
  divider: (entry) => (
    <div className="mb-6 flex min-h-4 justify-end">
      {(entry.durationMs != null || entry.usage) && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {[
            entry.durationMs != null && formatDuration(entry.durationMs),
            entry.usage?.inputTokens != null && `${Math.round(entry.usage.inputTokens / 1000)}k in`,
            entry.usage?.outputTokens != null && `${Math.round(entry.usage.outputTokens / 1000)}k out`,
            entry.usage?.reasoningTokens ? `${Math.round(entry.usage.reasoningTokens / 1000)}k reasoning` : false,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
    </div>
  ),
  unknown: () => null,
}

export const ThreadEntry = memo(function ThreadEntry({ entry, waiting, sessionId, onOpenRevision }: {
  entry: ChatEntry
  // What a message the running turn has not taken waits for.
  waiting: string | null
  sessionId: string
  onOpenRevision?: (revision: number) => void
}) {
  const render = renderers[entry.type] ?? renderers.unknown
  return <>{render(entry, waiting, sessionId, onOpenRevision)}</>
})
