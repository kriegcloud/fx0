import assert from 'node:assert/strict'
import test from 'node:test'
import { createFxEngine } from 'libfx'
import { proxyOptions } from '../lib/local-mode.ts'
import { createTools } from '../lib/tools.ts'

// Synthetic pixel only; never use a workstation screenshot or personal media.
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }
const imagesIn = body => (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : [])
const sse = delta => new Response(`data: ${JSON.stringify({ id: 'vision-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const options = model => ({ ...proxyOptions(), model, credentials: async () => ({ apiKey: 'synthetic-test-key' }) })
async function drain(turn) {
  void turn.result.catch(() => {})
  for await (const _ of turn) { /* drain */ }
  return turn.result
}

test('K3 and K3.1 Pro image prompts reach the proxy as OpenAI image content with exact model IDs', async () => {
  for (const model of ['kimi-k3', 'kimi-k3.1-pro']) {
    let calls = 0
    const engine = await createFxEngine({ ...options(model), fetch: async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init.body)); calls++
      assert.equal(body.model, model)
      assert.equal(body.max_tokens, 65536)
      assert.equal(imagesIn(body).length, 1)
      assert.equal(imagesIn(body)[0].image_url.url, `data:image/png;base64,${image.data}`)
      return sse({ content: 'Red.' })
    } })
    try {
      assert.equal((await drain(engine.prompt([{ type: 'text', text: 'Synthetic: identify this color.' }, image]))).stopReason, 'end_turn')
      assert.equal(calls, 1)
    } finally { await engine.close() }
  }
})

test('K2 remains text-only and missing metadata reproduces the original local rejection', async () => {
  for (const model of ['kimi-k2', 'kimi-k2-thinking', 'unknown-kimi-fixture']) {
    let calls = 0
    const engine = await createFxEngine({ ...options(model), fetch: async () => { calls++; return sse({ content: 'unexpected' }) } })
    try {
      await assert.rejects(drain(engine.prompt([{ type: 'text', text: 'Synthetic image.' }, image])), /Image prompts are unavailable/)
      assert.equal(calls, 0, 'text-only images are rejected before upstream inference')
    } finally { await engine.close() }
  }
  const models = proxyOptions().provider.models
  for (const [id, metadata] of Object.entries(models).filter(([id]) => id.startsWith('kimi-'))) {
    assert.equal(metadata.supportsVision, !['kimi-k2', 'kimi-k2-thinking'].includes(id), id)
  }
})

test('screenshot_design returns a real image to the next Kimi model request', async () => {
  const screenshot = createTools({
    reportInvocation: () => 1,
    captureDesign: async () => ({ revision: 1, images: [{ data: image.data, mimeType: image.mimeType, width: 1, height: 1 }] }),
    log: () => {},
  }).find(tool => tool.name === 'screenshot_design')
  let calls = 0
  const engine = await createFxEngine({ ...options('kimi-k3'), tools: [screenshot], fetch: async (_url, init) => {
    const body = JSON.parse(new TextDecoder().decode(init.body)); calls++
    if (calls === 1) return sse({ tool_calls: [{ index: 0, id: 'shot', type: 'function', function: { name: 'screenshot_design', arguments: '{}' } }] })
    assert.equal(imagesIn(body).length, 1, 'screenshot is visual input, not just capture metadata')
    assert.equal(imagesIn(body)[0].image_url.url, `data:image/png;base64,${image.data}`)
    return sse({ content: 'The screenshot is red.' })
  } })
  try {
    assert.equal((await drain(engine.prompt('Synthetic: inspect the preview screenshot.'))).stopReason, 'end_turn')
    assert.equal(calls, 2)
  } finally { await engine.close() }
})
