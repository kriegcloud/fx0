// Runs all workstation-only services as children; Ctrl-C stops this app's children.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createClient } from 'redis'
import { readProxyKey } from './proxy-key.mjs'

const root = path.resolve(import.meta.dirname, '..')
const nextCommand = process.argv.includes('--production') ? 'start' : 'dev'
process.chdir(root)
const data = path.resolve(process.env.FX0_LOCAL_DATA_DIR || '.local')
await mkdir(data, { recursive: true, mode: 0o700 })
const secretPath = path.join(data, 'session-secret')
let secret
try { secret = await readFile(secretPath, 'utf8') } catch (error) {
  if (error.code !== 'ENOENT') throw error
  secret = randomBytes(48).toString('base64url')
  await writeFile(secretPath, secret, { mode: 0o600, flag: 'wx' })
}

const apiKey = await readProxyKey()
const baseUrl = process.env.FX0_PROXY_BASE_URL || 'http://127.0.0.1:8317/v1'
const url = new URL(baseUrl)
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
  throw new Error('The local proxy must use a loopback HTTP URL without credentials')
}
const models = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
  headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000),
})
if (!models.ok) throw new Error(`CLIProxyAPI model check failed (${models.status})`)
const model = process.env.FX0_MODEL || 'gpt-6.1-sol'
if (!(await models.json()).data?.some(entry => entry.id === model)) throw new Error(`CLIProxyAPI does not advertise ${model}`)

// Do not start two Redis writers or Postgres instances on the same data directory.
const lock = path.join(data, 'launcher.pid')
try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }) } catch (error) {
  if (error.code !== 'EEXIST') throw error
  const pid = Number(await readFile(lock, 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid launcher lock: ${lock}`)
  try { process.kill(pid, 0); throw new Error('fx0 is already running with this data directory') } catch (probe) {
    if (probe.code !== 'ESRCH') throw probe
  }
  await unlink(lock)
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
}
const children = new Set()
const socket = path.join(data, 'redis.sock')
let stopping = false
let bridge
let redis
async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  bridge?.closeAllConnections()
  bridge?.close()
  redis?.destroy()
  for (const child of children) child.kill('SIGTERM')
  await Promise.all([...children].map(child => new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))))
  await unlink(lock).catch(() => {})
  process.exit(code)
}
function child(command, args, options = {}) {
  const proc = spawn(command, args, { stdio: 'inherit', ...options })
  children.add(proc)
  proc.on('error', () => { console.error(`Unable to start ${command}`); void shutdown(1) })
  proc.on('exit', code => { children.delete(proc); if (!stopping) void shutdown(code || 1) })
  return proc
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
try {
  child('redis-server', ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700',
    '--dir', data, '--appendonly', 'yes', '--appendfsync', 'everysec', '--loglevel', 'warning'])
  redis = createClient({ RESP: 2, socket: { path: socket, reconnectStrategy: retries => retries < 30 ? 100 : false } })
  redis.on('error', () => {})
  await redis.connect()
  const restToken = randomBytes(32).toString('base64url')
  const encode = value => typeof value === 'string' ? (value === 'OK' ? value : Buffer.from(value).toString('base64'))
    : Array.isArray(value) ? value.map(encode) : value
  bridge = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== `Bearer ${restToken}`) { response.writeHead(401).end('{}'); return }
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 32 * 1024 * 1024) throw new Error('Request too large')
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString())
      const batch = ['/pipeline', '/multi-exec'].includes(request.url)
      const commands = batch ? input : [input]
      let results
      if (request.url === '/multi-exec') {
        const multi = redis.multi()
        for (const command of commands) multi.addCommand(command.map(String))
        results = (await multi.exec()).map(result => ({ result }))
      } else {
        results = []
        for (const command of commands) {
          try { results.push({ result: await redis.sendCommand(command.map(String)) }) }
          catch { results.push({ error: 'Local Redis command failed' }) }
        }
      }
      if (request.headers['upstash-encoding'] === 'base64') results = results.map(entry => 'result' in entry ? { result: encode(entry.result) } : entry)
      response.end(JSON.stringify(batch ? results : results[0]))
    } catch { response.writeHead(400).end(JSON.stringify({ error: 'Local Redis request failed' })) }
  })
  await new Promise((resolve, reject) => {
    bridge.once('error', reject)
    bridge.listen(0, '127.0.0.1', resolve)
  })
  const port = process.env.FX0_LOCAL_PORT || '3000'
  const env = {
    ...process.env, FX0_LOCAL: '1', APP_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: secret, FX_SESSIONS_DIR: path.join(data, 'sessions'), FX0_PROXY_BASE_URL: baseUrl, FX0_PROXY_API_KEY: apiKey,
    FX0_MODEL: model, FX0_EFFORT: process.env.FX0_EFFORT || 'medium', FX0_FREE_PROMPTS: '0',
    FX0_REFERENCE_ROOTS: process.env.FX0_REFERENCE_ROOTS || JSON.stringify([homedir()]),
    FX0_WORKSTATION_TOOLS: process.env.FX0_WORKSTATION_TOOLS || '1',
    FX0_LOCAL_DATA_DIR: data, FX0_REDIS_PREFIX: 'fx0:local',
    KV_REST_API_URL: `http://127.0.0.1:${bridge.address().port}`, KV_REST_API_TOKEN: restToken,
  }
  console.log(`fx0 workstation: ${env.APP_URL} → CLIProxyAPI (${model}, ${env.FX0_EFFORT})`)
  child(process.execPath, ['node_modules/next/dist/bin/next', nextCommand, '--hostname', '127.0.0.1', '--port', port], { env })
} catch (error) {
  console.error(error instanceof Error ? error.message.replaceAll(apiKey, '[redacted]') : 'Local startup failed')
  await shutdown(1)
}
