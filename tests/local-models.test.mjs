import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { KIMI_MODELS, isLocalTextModel, modelDisplayName } from '../lib/local-models.ts'

registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/app/api/models/route.ts')) {
    if (specifier === 'next/server.js') return { url: 'data:text/javascript,export async function connection() {}', shortCircuit: true }
    if (specifier === '../../../lib/session') return { url: 'data:text/javascript,export const DEFAULT_MODEL = "hosted-default"', shortCircuit: true }
    if (specifier.startsWith('../../../lib/')) return next(`${specifier}.ts`, context)
  }
  return next(specifier, context)
} })
const { GET } = await import('../app/api/models/route.ts')

test('direct Kimi names retain exact IDs and cannot enable unrelated provider routes', () => {
  assert.equal(Object.keys(KIMI_MODELS).length, 12)
  for (const id of Object.keys(KIMI_MODELS)) assert.equal(isLocalTextModel(id), true)
  for (const id of ['venice/kimi-k3.1-pro', 'kimi-image', 'gpt-image-1', 'grok-video', 'toString']) assert.equal(isLocalTextModel(id), false)
  assert.equal(modelDisplayName('kimi-k3.1-pro'), 'Kimi K3.1 Pro')
  assert.equal(modelDisplayName('kimi-k3.1-pro-highspeed'), 'Kimi K3.1 Pro Highspeed')
  assert.equal(modelDisplayName('venice/kimi-k3.1-pro'), 'kimi-k3.1-pro')
  assert.equal(modelDisplayName('gpt-6.1-sol'), 'gpt-6.1-sol')
})

test('local catalog authenticates server-side, lists only advertised choices and preserves defaults', async (t) => {
  const previous = { ...process.env }
  t.after(() => { process.env = previous })
  Object.assign(process.env, { FX0_LOCAL: '1', APP_URL: 'http://127.0.0.1:3000', FX0_MODEL: 'gpt-6.1-sol', FX0_PROXY_API_KEY: 'synthetic-key' })
  delete process.env.VERCEL
  delete process.env.FX0_PROXY_BASE_URL
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let available = true
  const network = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8317/v1/models')
    assert.equal(init.headers.authorization, 'Bearer synthetic-key')
    return available ? Response.json({ data: [
      ...Object.keys(KIMI_MODELS).map(id => ({ id })),
      { id: 'gpt-6.1-sol' }, { id: 'claude-opus-5-5' }, { id: 'grok-4.7' },
      { id: 'gpt-image-1' }, { id: 'venice/kimi-k2' },
    ] }) : new Response(null, { status: 401 })
  })
  const response = await GET()
  assert.equal(response.status, 200)
  const catalog = await response.json()
  assert.equal(catalog.defaultModel, 'gpt-6.1-sol')
  assert.equal(catalog.models.length, 15)
  assert.ok(catalog.featured.includes('kimi-k3.1-pro'))
  assert.deepEqual(catalog.efforts, { 'gpt-6.1-sol': ['low', 'medium', 'high'] })
  assert.deepEqual(catalog.fast, [])
  assert.equal(JSON.stringify(catalog).includes('synthetic-key'), false)
  await GET()
  assert.equal(network.mock.callCount(), 1)
  now += 300_001
  available = false
  const failed = await GET()
  assert.equal(failed.status, 502)
  assert.equal(failed.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await failed.json()).models, [])
})
