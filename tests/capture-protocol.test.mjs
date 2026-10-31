import assert from 'node:assert/strict'
import test from 'node:test'
import { captureTrace, captureWidth } from '../lib/capture-protocol.ts'

test('a capture width is rounded into range, and anything but a number asks for none', () => {
  assert.deepEqual([1440, 1440.4, 100, 5000].map(captureWidth), [1440, 1440, 320, 1920])
  assert.deepEqual([undefined, null, '1440', Number.NaN, Infinity].map(captureWidth), [undefined, undefined, undefined, undefined, undefined])
})

test('a capture trace splits the call into parts, and its network total survives a clock offset', () => {
  // The tab's clock runs 40 ms ahead of the servers'.
  const skew = 40
  const server = { totalMs: 700, setupMs: 9, emitMs: 6, emittedAt: 1_000_000, receivedAt: 1_000_685 }
  const shot = {
    path: 'preview', receivedAt: 1_000_150 + skew, sentAt: 1_000_520 + skew, previewWaitMs: 300, roundTripMs: 70,
    frame: { fontsMs: 1, libraryMs: 25, encodeMs: 30 }, arrivedAt: 1_000_670, authMs: 3, readMs: 1, storingAt: 1_000_675,
  }
  const trace = captureTrace(server, shot)
  assert.deepEqual(trace, {
    path: 'preview', totalMs: 700, setupMs: 9, emitMs: 6,
    deliveryMs: 150 + skew, previewWaitMs: 300, messagingMs: 14, fontsMs: 1, libraryMs: 25, encodeMs: 30,
    uploadMs: 150 - skew, networkMs: 300, authMs: 3, readMs: 1, storeAndWakeMs: 10,
  })
})

test("a capture trace without the frame's timing counts the whole round trip as messaging", () => {
  const trace = captureTrace(
    { totalMs: 100, setupMs: 1, emitMs: 1, emittedAt: 0, receivedAt: 100 },
    { path: 'hidden', receivedAt: 10, sentAt: 60, previewWaitMs: 20, roundTripMs: 30, frame: null, arrivedAt: 80, authMs: 2, readMs: 0, storingAt: 90 },
  )
  assert.equal(trace.messagingMs, 30)
  assert.equal(trace.fontsMs, null)
  assert.equal(trace.path, 'hidden')
})
