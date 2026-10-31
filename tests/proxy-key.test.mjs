import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readProxyKey } from '../scripts/proxy-key.mjs'

test('launcher key precedence, legacy fallback, and fail-closed token errors', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'fx0-proxy-key-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = path.join(home, '.cli-proxy-api')
  await mkdir(dir)
  const config = path.join(dir, 'config.yaml')
  const token = path.join(dir, 'client-token')
  await writeFile(config, 'api-keys: [synthetic-config-key]')
  assert.equal(await readProxyKey({}, home), 'synthetic-config-key')
  await writeFile(token, 'synthetic-token-key\n')
  assert.equal(await readProxyKey({}, home), 'synthetic-token-key')
  assert.equal(await readProxyKey({ FX0_PROXY_CONFIG: config }, home), 'synthetic-config-key')
  assert.equal(await readProxyKey({ FX0_PROXY_CONFIG: config, FX0_PROXY_TOKEN_FILE: token }, home), 'synthetic-token-key')
  assert.equal(await readProxyKey({ FX0_PROXY_API_KEY: 'synthetic-override' }, home), 'synthetic-override')
  await assert.rejects(readProxyKey({ FX0_PROXY_TOKEN_FILE: path.join(dir, 'missing') }, home))
  await writeFile(token, '\n')
  await assert.rejects(readProxyKey({}, home), /empty/)
  await writeFile(config, 'api-keys: [synthetic-secret-with-broken-yaml')
  await assert.rejects(readProxyKey({ FX0_PROXY_CONFIG: config }, home), error => !error.message.includes('synthetic-secret'))
})
