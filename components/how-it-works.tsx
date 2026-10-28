'use client'

import { BeepWordmark } from './beep-wordmark'
import { useId, useRef, useState, type ReactNode } from 'react'
import { fastClick } from '../lib/fast-click'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export const REPO_URL = 'https://github.com/vercel-labs/fx0'

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:no-underline">
      {children}
    </a>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <div className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">{children}</div>
    </section>
  )
}

// The help dialog's intro; the empty preview has its own, about the space it fills.
const INTRO = (
  <>
    beep uses <External href="https://www.npmjs.com/package/libfx">libfx</External>, the agent
    from fx as a JavaScript library. One <code>createFxAgent()</code> call gives you the agent loop, streaming, tool
    calls and durable sessions.
  </>
)

const BODY = (
  <>
    <Section title="when you send">
      <p>libfx runs the agent inside the app server. It calls the model and the tools and streams each step to your tab.</p>
    </Section>

    <Section title="durable">
      <p>
        Each chat is a libfx session, saved step by step in local storage on this workstation or
        a <External href="https://workflow-sdk.dev/worlds">Workflow world</External> when hosted.
        A restored session can continue from its saved steps.
      </p>
    </Section>

    <Section title="make it yours">
      <p>
        The instructions are in <code>lib/agent.ts</code> and the tools in <code>lib/tools.ts</code>.
      </p>
    </Section>
  </>
)

// A short intro for the preview before there is a design. The rest opens above a
// footer that expands practical help without taking you out of the workspace.
export function HowItWorksPanel() {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  return (
    <article aria-labelledby="fx0-intro-title" className="text-sm leading-6 text-muted-foreground">
      <h2 id="fx0-intro-title" className="text-foreground"><BeepWordmark className="text-2xl" /></h2>
      <p className="mt-2">
        A workspace for exploring and refining interface ideas.
      </p>
      <p className="mt-2">Describe a page in the chat and it shows up here as one HTML file.</p>
      <div id={bodyId} hidden={!expanded}>{BODY}</div>
      <div className="mt-6 flex items-center justify-between gap-4">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
          className="text-foreground underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? 'read less' : 'read more'}
        </button>
      </div>
    </article>
  )
}

export default function HowItWorks() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const openedByKeyboard = useRef(false)
  const openHandlers = fastClick(() => setOpen(true))
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label="how it works"
            onPointerDown={(event) => { openedByKeyboard.current = false; openHandlers.onPointerDown(event) }}
            onClick={(event) => { if (event.detail === 0) openedByKeyboard.current = true; openHandlers.onClick(event) }}
            className="grid size-8 shrink-0 place-items-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* Geist's question mark at its usual size, in a square frame with room around it. */}
            <svg viewBox="-2 -2 20 20" className="size-5" aria-hidden="true">
              <rect x="-1.625" y="-1.625" width="19.25" height="19.25" fill="none" stroke="currentColor" strokeWidth="0.75" />
              <path
                fill="currentColor"
                d="M9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0M7.1 5.82a1 1 0 1 1 1.04 1.42c-.44.06-.89.44-.89 1.01v1h1.5v-.61a2.5 2.5 0 1 0-3-3.46l-.33.68 1.35.64z"
              />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent>how it works</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Focus the dialog itself: a keyboard-opened dialog otherwise lands a focus ring on the close button. */}
        <DialogContent
          onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus() }}
          // Radix returns focus only to a DialogTrigger. A pointer never focused this
          // button, so focusing it on close would paint a focus ring nobody asked for.
          onCloseAutoFocus={(event) => { event.preventDefault(); if (openedByKeyboard.current) trigger.current?.focus() }}
          className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto p-7"
        >
          <DialogClose
            aria-label="close"
            className="absolute right-4 top-4 inline-flex size-8 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </DialogClose>

          <DialogTitle className="text-lg font-medium">how it works</DialogTitle>
          <DialogDescription className="mt-3 text-sm leading-6 text-muted-foreground">{INTRO}</DialogDescription>

          {BODY}


        </DialogContent>
      </Dialog>
    </>
  )
}
