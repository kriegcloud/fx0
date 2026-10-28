import assert from 'node:assert/strict'
import test from 'node:test'
import { compactTranscript, createTranscriptReader, transcriptState } from '../lib/transcript.ts'
import { replayEvents, shouldAcceptSessionEvent } from '../components/chat-state.ts'

const view = { artifactRevision: 0 }
const events = [
  { type: 'user', id: 1, seq: 1, text: 'Design', imagePreviews: ['data:image/jpeg;base64,AA=='], designMd: { name: 'Apple' } },
  { type: 'turn_start', id: 1, turnId: 1, seq: 2, at: 10 },
  { type: 'tool_start', turnId: 1, seq: 3, callId: 4, name: 'design', at: 11 },
  { type: 'text', turnId: 1, seq: 4, delta: 'Hello' },
  { type: 'text', turnId: 1, seq: 5, delta: ' world' },
  { type: 'tool_end', turnId: 1, seq: 6, callId: 4, content: 'done', at: 20 },
  { type: 'question', turnId: 1, seq: 7, qid: 1, questions: [{ question: 'Color?', options: [] }] },
  { type: 'question_resolved', turnId: 1, seq: 8, qid: 1, answers: { 'Color?': 'Blue' } },
  { type: 'artifact', turnId: 1, seq: 9, artifactRevision: 3 },
  { type: 'done', id: 1, turnId: 1, seq: 10 },
]

test('every checkpoint boundary replays exactly like the full journal', () => {
  for (let split = 0; split <= events.length; split++) {
    const checkpoint = compactTranscript(events.slice(0, split), view)
    // A browser round trip loses Sets; the checkpoint must remain serializable.
    const decoded = JSON.parse(JSON.stringify(checkpoint))
    const wire = (value) => JSON.parse(JSON.stringify(value, (_, field) => field instanceof Set ? [...field] : field))
    assert.deepEqual(wire(transcriptState(compactTranscript(events.slice(split), view, decoded))), wire(replayEvents(events, view)))
  }
})

test('restarting a turn clears its old entries even across a checkpoint', () => {
  const previous = compactTranscript(events.slice(0, 5), view)
  const tail = [{ type: 'turn_start', id: 1, turnId: 1, seq: 11 }, { type: 'text', turnId: 1, delta: 'Recovered', seq: 12 }]
  assert.deepEqual(transcriptState(compactTranscript(tail, view, previous)), replayEvents([...events.slice(0, 5), ...tail], view))
})

test('an attachment error survives a delayed turn start and cancellation at every checkpoint boundary', () => {
  const failure = [
    { type: 'user', id: 1, seq: 1, text: 'Use these images' },
    { type: 'error', id: 1, turnId: 1, seq: 2, text: 'The attached images could not be stored. Send the message again.' },
    { type: 'turn_start', id: 1, turnId: 1, seq: 3 },
    { type: 'done', id: 1, turnId: 1, seq: 4, stopReason: 'cancelled' },
  ]
  for (let split = 0; split <= failure.length; split++) {
    const previous = compactTranscript(failure.slice(0, split), view)
    const result = compactTranscript(failure.slice(split), view, JSON.parse(JSON.stringify(previous)))
    assert.deepEqual(result.entries.filter(entry => entry.type === 'error').map(entry => entry.text), [failure[1].text])
    assert.equal(result.activeTurnId, null)
  }
})

test('text deltas preserve mounted message keys and old events cannot duplicate a snapshot', () => {
  const previous = compactTranscript(events.slice(0, 4), view)
  const updated = compactTranscript(events.slice(3, 5), view, previous)
  assert.equal(updated.entries.at(-1).key, previous.entries.at(-1).key)
  assert.equal(updated.entries.at(-1).text, 'Hello world')
  const seen = new Set()
  assert.equal(shouldAcceptSessionEvent('chat', 'chat', events[3], seen, 5), false)
  assert.equal(seen.size, 0)
  assert.equal(shouldAcceptSessionEvent('chat', 'chat', events[5], seen, 5), true)
})

test('a warm reader processes only the tail; a checkpoint write failure preserves the transcript', async () => {
  let previous = null
  let tail = events
  const offsets = []
  const read = createTranscriptReader({
    async read() { offsets.push(previous?.lastSeq ?? 0); return { previous, events: tail, view, summary: null } },
    async publish(_, snapshot) { previous = snapshot },
  })
  await read('chat')
  tail = [{ type: 'user', id: 2, seq: 11, text: 'Again' }]
  const next = await read('chat')
  assert.deepEqual(offsets, [0, 10])
  assert.equal(next.transcript.entries.at(-1).text, 'Again')
  const failing = createTranscriptReader({
    async read() { return { previous: null, events, view, summary: null } },
    async publish() { throw new Error('Redis write unavailable') },
  })
  assert.deepEqual((await failing('chat')).transcript, compactTranscript(events, view))
})

test('a long response compacts thousands of deltas into one message', () => {
  const journal = [{ type: 'turn_start', seq: 1, id: 1, turnId: 1 },
    ...Array.from({ length: 10000 }, (_, i) => ({ type: 'text', seq: i + 2, turnId: 1, delta: 'x' }))]
  const snapshot = compactTranscript(journal, view)
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0].text.length, 10000)
  assert.ok(JSON.stringify(snapshot).length < JSON.stringify(journal).length / 20)
})

test('a page may publish its checkpoint after responding without delaying the transcript', async () => {
  let job, published = false
  const read = createTranscriptReader({
    async read() { return { previous: null, events, view, summary: null } },
    async publish() { published = true },
  })
  assert.equal((await read('chat', (publish) => { job = publish })).transcript.lastSeq, 10)
  assert.equal(published, false)
  await job()
  assert.equal(published, true)
})

test('a screenshot call reports its own time, not the time it waited for the preview to load', () => {
  const view = { artifactRevision: 1 }
  const state = compactTranscript([
    { type: 'turn_start', id: 1, seq: 1, at: 0 },
    // The capture event may land before the call's tool_start (the projector writes libfx's
    // lines in batches); the wait travels on the tool_end instead.
    { type: 'capture', turnId: 1, seq: 2, cid: 'c1', artifactRevision: 1, at: 1_009 },
    { type: 'tool_start', turnId: 1, seq: 3, name: 'screenshot_design', at: 1_000 },
    { type: 'tool_end', turnId: 1, seq: 4, name: 'screenshot_design', toolCallId: 'call_1', previewWaitMs: 515, content: 'Screenshot', at: 2_208 },
  ], view)
  const tool = state.entries.find((entry) => entry.type === 'tool')
  assert.equal(tool.durationMs, 693)
  assert.equal(tool.previewWaitMs, 515)
  assert.equal(state.entries.filter((entry) => entry.type === 'tool').length, 1, 'capture events add no rows')
})
