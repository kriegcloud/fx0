import assert from 'node:assert/strict'
import test from 'node:test'
import { localMode, localSession, assertLocalRequest, proxyBaseUrl, proxyOptions } from '../lib/local-mode.ts'

test('local identity is opt-in, loopback-only, and unavailable on Vercel', () => {
  const previous = { ...process.env }
  try {
    delete process.env.FX0_LOCAL
    assert.equal(localMode(), false)
    process.env.FX0_LOCAL = '1'
    process.env.APP_URL = 'http://127.0.0.1:3000'
    assert.equal(localMode(), true)
    process.env.VERCEL = '1'
    assert.throws(localMode)
    delete process.env.VERCEL
    process.env.APP_URL = 'http://0.0.0.0:3000'
    assert.throws(localMode)
  } finally { process.env = previous }
})

test('local API rejects DNS rebinding, foreign origins, and cross-site reads', () => {
  const previous = { ...process.env }
  try {
    process.env.APP_URL = 'http://127.0.0.1:3000'
    const request = headers => new Request('http://localhost:3000/api/session', { headers: { host: '127.0.0.1:3000', ...headers } })
    assert.doesNotThrow(() => assertLocalRequest(request({})))
    assert.doesNotThrow(() => assertLocalRequest(request({ origin: process.env.APP_URL, 'sec-fetch-site': 'same-origin' })))
    assert.throws(() => assertLocalRequest(request({ host: 'evil.example:3000' })))
    assert.throws(() => assertLocalRequest(request({ origin: 'https://evil.example' })))
    assert.throws(() => assertLocalRequest(request({ 'sec-fetch-site': 'cross-site' })))
    assert.throws(() => assertLocalRequest(new Request('http://evil.example:3000/api/session')))
  } finally { process.env = previous }
})

test('provider credentials stay at the credential callback and cannot go to a remote URL', async () => {
  const previous = { ...process.env }
  try {
    process.env.FX0_PROXY_API_KEY = 'test-private-key'
    delete process.env.FX0_PROXY_BASE_URL
    const options = proxyOptions()
    assert.equal(options.provider.baseUrl, 'http://127.0.0.1:8317/v1')
    assert.equal(JSON.stringify(options).includes('test-private-key'), false)
    assert.deepEqual(await options.credentials(), { apiKey: 'test-private-key' })
    assert.equal(JSON.stringify(localSession()).includes('test-private-key'), false)
    for (const url of ['http://evil.example/v1', 'https://example.com/v1', 'http://key@127.0.0.1/v1', 'http://127.0.0.1/v1?key=secret']) {
      process.env.FX0_PROXY_BASE_URL = url
      assert.throws(proxyBaseUrl)
    }
  } finally { process.env = previous }
})
