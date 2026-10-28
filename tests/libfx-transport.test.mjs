import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFxAgent, createFxEngine, createMemoryPersistence } from 'libfx'
import { local } from 'libfx/durable-local'
import { gatewayFetch } from '../lib/gateway-session.ts'
import { createDraftContext } from '../lib/draft-context.ts'
import { proxyOptions } from '../lib/local-mode.ts'

// Exercise the installed SDK/native transport, not a mocked createFxAgent. The
// external Gateway response is synthetic; no provider or real credentials run.
test('installed libfx dispatch uses the user-scoped transport rather than a shared key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-transport-'))
  const original = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'owner-key-must-not-be-used'
  const calls = []
  const drafts = createDraftContext()
  const draftTurns = []
  const session = { loginId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', loginAt: Date.now(),
    userId: 'sdk-test-user', email: 'sdk@example.com', isLoggedIn: true,
    accessToken: 'sdk-synthetic-user-token', teamId: 'team_sdk_test', expiresAt: Date.now() + 3600_000 }
  const transport = gatewayFetch({ gatewaySession: session }, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'https://ai-gateway.vercel.sh')
    calls.push(url.pathname)
    if (url.pathname.endsWith('/language-model')) draftTurns.push(drafts.turn(new Headers(init.headers).get('x-session-id')))
    if (url.pathname.endsWith('/models')) {
      assert.equal(new Headers(init.headers).get('authorization'), null)
      assert.equal(new Headers(init.headers).get('x-vercel-ai-gateway-team'), null)
      return Response.json({ data: [{ id: 'anthropic/claude-opus-5.5-fast', type: 'language' }] })
    }
    assert.equal(init.headers.get('authorization'), 'Bearer sdk-synthetic-user-token')
    assert.equal(init.headers.get('x-vercel-ai-gateway-team'), 'team_sdk_test')
    return Response.json({ error: { message: 'synthetic denial' } }, { status: 401 })
  })
  let agent
  try {
    agent = createFxAgent({ durability: local({ dir }), apiKey: 'session-authenticated', model: 'anthropic/claude-opus-5.5-fast',
      instructions: 'Reply briefly.', tools: [], fetch: transport, onEvent: event => drafts.observe(event) })
    const turn = agent.session().prompt('Hello', { messageId: 'm31', signal: AbortSignal.timeout(5_000) })
    // Drain events and settle the result even when the synthetic provider denies.
    const result = turn.result.catch((error) => error)
    try { for await (const _event of turn) {} } catch {}
    await result
    assert.ok(calls.length > 0, 'libfx must invoke the provided transport')
    assert.ok(calls.every((path) => !path.includes('credits') && !path.includes('userinfo') && !path.includes('oauth')))
    assert.ok(draftTurns.length > 0, 'the installed SDK must dispatch a model request')
    assert.ok(draftTurns.every(id => id === 31), 'ACP diagnostics identify the actual durable prompt before its fetch')
  } finally {
    await agent?.close()
    await rm(dir, { recursive: true, force: true })
    if (original === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = original
  }
})

test('installed libfx rebinds a running turn the session cap evicted before its next model request', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-binding-'))
  const drafts = createDraftContext()
  const seen = []
  const sse = (...items) => new Response([...items.map((item) => `data: ${JSON.stringify(item)}`), 'data: [DONE]', ''].join('\n\n'),
    { headers: { 'content-type': 'text/event-stream' } })
  const finish = (reason) => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } })
  const fetcher = async (_url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') return Response.json({ data: [{ id: 'sdk/binding-model', type: 'language' }] })
    seen.push(drafts.turn(new Headers(init.headers).get('x-session-id')))
    return seen.length === 1
      ? sse({ type: 'tool-call', toolCallId: 'wait-1', toolName: 'wait_for_answer', input: '{}' }, finish('tool-calls'))
      : sse({ type: 'text-delta', id: 'answer', delta: 'Done.' }, finish('stop'))
  }
  // While the turn waits in its tool, 250 other sessions start turns in this
  // process, past the 200-session cap.
  const crowd = async () => {
    for (let i = 0; i < 250; i++) {
      drafts.observe({ type: 'acp.send', message: { method: 'session/prompt', params: { sessionId: `other-${i}`, _meta: { fx: { turnId: `m${1000 + i}` } } } } })
    }
    return 'Answered.'
  }
  let agent
  try {
    agent = createFxAgent({ durability: local({ dir }), apiKey: 'synthetic-binding-key', model: 'sdk/binding-model', instructions: 'Reply briefly.', fetch: fetcher,
      tools: [{ name: 'wait_for_answer', description: 'Wait for an answer.', inputSchema: { type: 'object', properties: {} }, idempotent: true, execute: crowd }],
      onEvent: (event) => drafts.observe(event), hooks: { onEvent: (event) => drafts.observe(event) } })
    const turn = agent.session().prompt('Ask me', { messageId: 'm31', signal: AbortSignal.timeout(5_000) })
    try { for await (const _event of turn) {} } catch {}
    assert.equal((await turn.result).stopReason, 'end_turn')
    assert.deepEqual(seen, [31, 31], 'the request after the wait still names its own turn')
  } finally {
    await agent?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('installed libfx restores the original turn before its first recovered model request', { timeout: 10_000 }, async () => {
  const persistence = createMemoryPersistence()
  let first
  let recovered
  const calls = []
  const context = createDraftContext()
  const receipts = []
  let firstRequest = true
  const fetcher = async (_url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      return Response.json({ data: [{ id: 'sdk/recovery-model', type: 'language' }] })
    }
    calls.push(context.turn(new Headers(init.headers).get('x-session-id')))
    if (firstRequest) {
      firstRequest = false
      return new Response([
        'data: {"type":"tool-call","toolCallId":"read-1","toolName":"read_design","input":"{}"}',
        'data: {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":1},"outputTokens":{"total":1}}}',
        'data: [DONE]', '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response([
      'data: {"type":"text-delta","id":"answer","delta":"Recovered."}',
      'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":1},"outputTokens":{"total":1}}}',
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
  }
  const options = { apiKey: 'synthetic-recovery-key', model: 'sdk/recovery-model', instructions: 'Reply briefly.',
    tools: [{ name: 'read_design', description: 'Read the current design.', inputSchema: { type: 'object', properties: {} }, execute: async () => 'Current design.' }], fetch: fetcher, persistence }
  try {
    // A storage failure after a tool barrier preserves an open opaque journal,
    // just as a replaced worker can leave it. The replacement has a fresh map.
    first = await createFxEngine({ ...options, persistence: {
      load: () => persistence.load(), marks: true,
      append: input => input.marks?.some(mark => mark.end)
        ? Promise.reject(new Error('synthetic terminal append failure')) : persistence.append(input),
    } })
    const sessionId = first.sessionId
    const initial = first.prompt('Hello', { turnId: 'm41' })
    const initialResult = initial.result.catch(error => error)
    try { for await (const _event of initial) {} } catch {}
    await initialResult
    await first.close().catch(() => {})
    first = null
    calls.length = 0
    assert.equal(context.turn(sessionId), undefined, 'the recovered worker begins without a prompt diagnostic')
    recovered = await createFxEngine({
      ...options, sessionId,
      onEvent: event => {
        if (event.type === 'acp.send' && event.message?.method === 'session/prompt') receipts.push(event.message.params._meta?.fx)
        context.observe(event)
      },
      hooks: { onEvent: event => {
        if (event.type === 'journal.restore') receipts.push(event.data)
        context.observe(event)
      } },
    })
    const turn = recovered.resume()
    const result = turn.result
    for await (const _event of turn) {}
    assert.equal((await result).stopReason, 'end_turn')
    assert.deepEqual(calls, [41], 'the first recovered fetch must select the original durable turn')
    assert.ok(receipts.some(receipt => receipt.resumable && receipt.openTurnId === 'm41'))
    assert.ok(receipts.some(receipt => receipt.continueRecovery && receipt.turnId === undefined), 'recovery has no fresh ACP turn id')
  } finally {
    await first?.close()
    await recovered?.close()
  }
})

for (const model of ['claude-opus-5-5', 'claude-opus-5.5']) {
  test(`local proxy sends first and follow-up Opus image prompts (${model})`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fx0-proxy-images-'))
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII='
    const requests = []
    let agent
    try {
      const options = proxyOptions()
      agent = createFxAgent({
        ...options, credentials: async () => ({ apiKey: 'synthetic-proxy-key' }),
        durability: local({ dir }), model, instructions: 'Reply briefly.', tools: [],
        fetch: async (input, init = {}) => {
          assert.equal(String(input), `${options.provider.baseUrl}/chat/completions`)
          assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-proxy-key')
          requests.push(JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)))
          return new Response([
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Image received."},"finish_reason":null}]}',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]', '',
          ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
        },
      })
      const session = agent.session()
      for (const messageId of ['m1', 'm2']) {
        const turn = session.prompt([
          { type: 'text', text: 'Use this image.' },
          { type: 'image', mimeType: 'image/png', data: png },
        ], { messageId, signal: AbortSignal.timeout(5000) })
        const result = turn.result
        void result.catch(() => {})
        const events = []
        for await (const event of turn) events.push(event)
        assert.equal((await result).stopReason, 'end_turn')
        assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), 'Image received.')
      }
      assert.equal(requests.length, 2)
      for (const request of requests) {
        assert.equal(request.model, model)
        const user = request.messages.filter(message => message.role === 'user').at(-1)
        assert.ok(user.content.some(part => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${png}`),
          'the proxy request must retain the exact image bytes')
      }
    } finally {
      await agent?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('installed libfx admits first and follow-up image prompts through a durable queue', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-images-'))
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII='
  const requests = []
  let agent
  try {
    agent = createFxAgent({
      // Exercise the production admission order: a durable queue acknowledges
      // before its consumer writes the input. Ordinary local() writes first,
      // which hides the image-steer self-cancellation regression.
      durability: { ...local({ dir }), queueDurable: true },
      apiKey: 'synthetic-image-test', model: 'sdk/vision-model', instructions: 'Reply briefly.', tools: [],
      fetch: async (_url, init = {}) => {
        if ((init.method ?? 'GET') === 'GET') {
          return Response.json({ object: 'list', data: [{ id: 'sdk/vision-model', type: 'language', tags: ['vision', 'file-input'] }] })
        }
        requests.push(JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)))
        return new Response([
          'data: {"type":"text-delta","id":"answer","delta":"Image received."}',
          'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":1},"outputTokens":{"total":1}}}',
          'data: [DONE]', '',
        ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const session = agent.session()
    for (const messageId of ['m1', 'm2']) {
      const turn = session.prompt([
        { type: 'text', text: 'Use this image.' },
        { type: 'image', mimeType: 'image/png', data: png },
      ], { messageId, signal: AbortSignal.timeout(5000) })
      const result = turn.result
      void result.catch(() => {})
      await turn.accepted
      const events = []
      for await (const event of turn) events.push(event)
      assert.equal((await result).stopReason, 'end_turn', 'the image must not cancel its own turn')
      assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), 'Image received.')
    }
    assert.equal(requests.length, 2, 'each image prompt reaches the model exactly once')
    for (const request of requests) {
      const user = request.prompt.filter(message => message.role === 'user').at(-1)
      assert.ok(user.content.some(part => part.type === 'file'), 'the model request retains its image')
    }
  } finally {
    await agent?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
