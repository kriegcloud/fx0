import assert from 'node:assert/strict'
import test from 'node:test'
import { createFxEngine } from 'libfx'
import { proxyOptions } from '../lib/local-mode.ts'
import { KIMI_MODEL_LIMITS } from '../lib/local-model-limits.ts'
import { KIMI_MODELS } from '../lib/local-models.ts'
import { canRecoverOutput, generationErrorMessage, OUTPUT_RECOVERY_PROMPT } from '../lib/output-recovery.ts'

test('recovery is available for historical and current truncations, but never after newer work', () => {
  for (const text of ['OutputTruncated', 'Error: OutputTruncated', generationErrorMessage('max_output_tokens')]) {
    const entries = [{ type: 'user' }, { type: 'error', text }]
    assert.equal(canRecoverOutput(entries, null), true)
    assert.equal(canRecoverOutput(entries, 2), false)
    for (const type of ['user', 'divider']) assert.equal(canRecoverOutput([...entries, { type }], null), false)
  }
  assert.equal(canRecoverOutput([{ type: 'error', text: 'authentication failed' }], null), false)
  assert.equal(generationErrorMessage('authentication failed'), 'authentication failed')
})

const sse = (...choices) => new Response(choices.map(choice => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })

test('real libfx sends Kimi limits, rejects truncated tool JSON without execution, and can continue safely', async () => {
  assert.deepEqual(Object.keys(KIMI_MODEL_LIMITS).sort(), Object.keys(KIMI_MODELS).sort())
  let phase = 0
  const calls = []
  const engine = await createFxEngine({
    ...proxyOptions(), credentials: async () => ({ apiKey: 'synthetic-test-key' }), model: 'kimi-k3.1-pro',
    tools: [{ name: 'publish_design', description: 'Publish a design', inputSchema: { type: 'object', properties: { html: { type: 'string' } }, required: ['html'], additionalProperties: false }, execute: ({ html }) => { calls.push(html); return { ok: true } } }],
    fetch: async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init.body))
      assert.equal(body.model, 'kimi-k3.1-pro')
      assert.equal(body.max_tokens, 65536)
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(body.stream, true)
      phase++
      if (phase === 1) return sse(
        { delta: { tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'publish_design', arguments: '{"html":"<!doctype' } }] }, finish_reason: null },
        { delta: {}, finish_reason: 'length' },
      )
      if (phase === 2) return sse({ delta: { tool_calls: [{ index: 0, id: 'complete', type: 'function', function: { name: 'publish_design', arguments: JSON.stringify({ html: '<!doctype html><html><head></head><body>Recovered</body></html>' }) } }] }, finish_reason: 'tool_calls' })
      return sse({ delta: { content: 'Published.' }, finish_reason: 'stop' })
    },
  })
  try {
    const failed = engine.prompt('Synthetic fixture: publish a small design.')
    void failed.result.catch(() => {})
    await assert.rejects(async () => { for await (const _ of failed) { /* drain */ } await failed.result }, /OutputTruncated/)
    assert.deepEqual(calls, [], 'an incomplete call must never execute')
    const recovered = engine.prompt(OUTPUT_RECOVERY_PROMPT)
    for await (const _ of recovered) { /* drain */ }
    assert.equal((await recovered.result).stopReason, 'end_turn')
    assert.equal(calls.length, 1, 'only the complete replacement executes')
  } finally { await engine.close() }
})

test('real libfx uses per-model budgets and leaves non-Kimi requests unchanged', async () => {
  for (const [model, expected] of [['kimi-k2.5', 32768], ['kimi-k3-256k', 65536], ['gpt-6.1-sol', undefined]]) {
    const engine = await createFxEngine({ ...proxyOptions(), credentials: async () => ({ apiKey: 'synthetic-test-key' }), model, fetch: async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init.body))
      assert.equal(body.model, model)
      assert.equal(body.max_tokens, expected)
      return sse({ delta: { content: 'OK' }, finish_reason: 'stop' })
    } })
    try { const turn = engine.prompt('Synthetic'); for await (const _ of turn) { /* drain */ } await turn.result }
    finally { await engine.close() }
  }
})
