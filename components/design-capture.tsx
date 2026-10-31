'use client'

import { useEffect, useRef } from 'react'
import {
  CAPTURE_FAILURES,
  CAPTURE_PAINT_MS,
  CAPTURE_REPLY,
  CAPTURE_REQUEST,
  CAPTURE_TIMING_HEADER,
  CAPTURE_TAB_MS,
  CAPTURE_VIEWPORT,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_TILES,
  type CaptureFailure,
  type CaptureReply,
  type FrameTiming,
} from '../lib/capture-protocol'
import { fetchUi } from './auth-ui'

// The app side of the screenshot protocol (lib/capture-protocol.ts). The tab acknowledges a
// request as it receives it; the preview on screen answers when it shows the asked revision
// (PreviewPane), otherwise DesignCapture loads a hidden copy and answers from it. Both send
// what the frame returned with sendCapture: the photo, or the reason there is none.

export interface CaptureRequest {
  cid: string
  sessionId: string
  // When this tab received the request, on this tab's clock: the preview wait counts from it.
  receivedAt: number
  // The revision the tool asked for; the preview on screen answers only if it shows it.
  revision: number
  // The whole page in viewport-high tiles instead of the visible viewport.
  full?: boolean
  // The hidden copy's viewport width in CSS px, instead of CAPTURE_VIEWPORT's.
  width?: number
  // The preview on screen could not answer, so the hidden copy does.
  offscreen?: boolean
}

const captureUrl = (request: CaptureRequest, params: Record<string, string>) =>
  `/api/capture?${new URLSearchParams({ session: request.sessionId, cid: request.cid, ...params })}`

/** Tells the waiting call this tab took the request; false when it is no longer open. */
export async function acknowledgeCapture(request: CaptureRequest): Promise<boolean> {
  try {
    const response = await fetchUi(captureUrl(request, { ack: '1' }), { method: 'POST' })
    return response.ok && (await response.json()).ok === true
  } catch {
    return false
  }
}

/** Asks one preview wrapper for its design's photo; null if it sends no reply in time. */
export function captureFrame(target: Window, cid: string, full = false): Promise<CaptureReply | null> {
  return new Promise((resolve) => {
    const done = (reply: CaptureReply | null) => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(reply)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== target) return
      if (event.data?.type !== CAPTURE_REPLY || event.data.cid !== cid) return
      const blobs: unknown = event.data.blobs
      if (Array.isArray(blobs) && blobs.every((blob) => blob instanceof Blob)) done(event.data as CaptureReply)
    }
    const timer = setTimeout(() => done(null), CAPTURE_TAB_MS)
    window.addEventListener('message', onMessage)
    target.postMessage({ type: CAPTURE_REQUEST, cid, full }, window.location.origin)
  })
}

/** Where a photo came from, and when this tab asked the frame for it (this tab's clock). */
export interface CaptureSource {
  path: 'preview' | 'hidden'
  askedAt: number
}

async function postCapture(url: string, init: RequestInit): Promise<void> {
  try {
    await fetchUi(url, { method: 'POST', ...init })
  } catch {
    // The waiting call times out instead.
  }
}

/** Tells the waiting call this tab cannot send a photo, and why. */
export const reportCaptureFailure = (request: CaptureRequest, reason: CaptureFailure) =>
  postCapture(captureUrl(request, { failed: reason }), {})

/**
 * Sends a frame's reply to /api/capture: its photo with this tab's part of the trace, or
 * the failure. No reply in time, the frame's own error, or a photo past the limits (a
 * design can answer for itself) all become failures, so the call never waits for nothing.
 */
export async function sendCapture(request: CaptureRequest, reply: CaptureReply | null, source: CaptureSource): Promise<void> {
  if (!reply) return reportCaptureFailure(request, 'no-reply')
  if (reply.error || !reply.blobs.length) {
    return reportCaptureFailure(request, reply.error && Object.hasOwn(CAPTURE_FAILURES, reply.error) ? reply.error : 'capture-failed')
  }
  const bytes = reply.blobs.reduce((sum, blob) => sum + blob.size, 0)
  if (reply.blobs.length > MAX_CAPTURE_TILES || bytes > MAX_CAPTURE_BYTES) return reportCaptureFailure(request, 'too-large')
  const size = (n: unknown) => (Number.isFinite(n) ? `${Math.round(n as number)}` : '')
  const form = new FormData()
  for (const blob of reply.blobs) form.append('image', blob)
  const sentAt = Date.now()
  // The frame's timing comes from the design's own document: kept only as plain numbers.
  const { fontsMs, libraryMs, encodeMs } = reply.timing ?? {}
  const frame = [fontsMs, libraryMs, encodeMs].every(Number.isFinite) ? { fontsMs, libraryMs, encodeMs } as FrameTiming : null
  const timing = {
    path: source.path, receivedAt: request.receivedAt, sentAt,
    previewWaitMs: source.askedAt - request.receivedAt, roundTripMs: sentAt - source.askedAt, frame,
  }
  await postCapture(captureUrl(request, { w: size(reply.width), h: size(reply.height), ...(reply.truncated ? { truncated: '1' } : {}) }), {
    body: form, headers: { [CAPTURE_TIMING_HEADER]: JSON.stringify(timing) },
  })
}

// The hidden copy loads the preview's own URL, so a revision this tab already loaded comes
// from the browser's cache. It stays inside the viewport, invisible: Chrome stops rendering
// cross-origin frames outside it, and the design would never paint. A design that focuses
// an element would take the keyboard from the composer, so focus goes back where it was.
export default function DesignCapture({ request, onDone }: { request: CaptureRequest; onDone: (cid: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ request, onDone })
  latest.current = { request, onDone }
  const { cid, sessionId, revision } = request

  useEffect(() => {
    let started = false
    const onPainted = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (started || !target || event.source !== target || event.origin !== window.location.origin) return
      if (event.data?.type !== 'fx0-artifact-painted') return
      started = true
      const askedAt = Date.now()
      void captureFrame(target, cid, latest.current.request.full)
        .then((reply) => sendCapture(latest.current.request, reply, { path: 'hidden', askedAt }))
        .finally(() => latest.current.onDone(cid))
    }
    const timer = setTimeout(() => {
      if (started) return
      void reportCaptureFailure(latest.current.request, 'not-painted').finally(() => latest.current.onDone(cid))
    }, CAPTURE_PAINT_MS)
    const focused = document.activeElement
    const onBlur = () => setTimeout(() => {
      if (document.activeElement !== frame.current) return
      if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected) focused.focus()
      else frame.current?.blur()
    })
    window.addEventListener('message', onPainted)
    window.addEventListener('blur', onBlur)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('message', onPainted)
      window.removeEventListener('blur', onBlur)
    }
  }, [cid])

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden opacity-0">
      <iframe
        ref={frame}
        src={`/api/artifact-frame?session=${encodeURIComponent(sessionId)}&v=${revision}`}
        referrerPolicy="no-referrer"
        tabIndex={-1}
        title="Design screenshot"
        style={{ ...CAPTURE_VIEWPORT, ...(request.width ? { width: request.width } : {}), border: 0 }}
      />
    </div>
  )
}
