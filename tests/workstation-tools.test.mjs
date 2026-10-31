import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { workstationTools, commandEnvironment } from '../lib/workstation-tools.ts'

const before = { ...process.env }
let root
let calls = 0
const saved = new Map()
const host = { reportInvocation: () => ++calls, storeResult: (id, text) => saved.set(id, text) }
test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fx0-workstation-'))
  Object.assign(process.env, { FX0_LOCAL: '1', FX0_WORKSTATION_TOOLS: '1', FX0_WORKING_DIRECTORY: root, APP_URL: 'http://127.0.0.1:3000', SHELL: '/bin/bash', FX0_PROXY_API_KEY: 'synthetic-private-proxy-key', SESSION_SECRET: 'synthetic-private-session-secret' })
  delete process.env.VERCEL
})
test.after(async () => { process.env = before; await rm(root, { recursive: true, force: true }) })
const context = (signal = new AbortController().signal, sessionId = 'synthetic-owner') => ({ signal, sessionId, executionId: crypto.randomUUID() })
const tool = name => workstationTools(host).find(tool => tool.name === name)
const call = (name, input, ctx = context()) => tool(name).execute(input, ctx)

test('host tools require explicit local enablement and cannot run on Vercel', async () => {
  const existing = tool('read_file')
  process.env.FX0_WORKSTATION_TOOLS = '0'
  assert.deepEqual(workstationTools(host), [])
  await assert.rejects(existing.execute({ path: 'fixture.txt' }, context()), /explicitly enabled local/)
  process.env.FX0_WORKSTATION_TOOLS = '1'
  process.env.FX0_LOCAL = '0'
  assert.deepEqual(workstationTools(host), [])
  process.env.FX0_LOCAL = '1'
  process.env.VERCEL = '1'
  assert.throws(() => workstationTools(host), /outside Vercel/)
  delete process.env.VERCEL
})

test('read/write/edit and directory discovery operate on real fixture files and reject ambiguous edits', async () => {
  await call('write_file', { path: 'fixture.txt', content: 'one\ntwo\nthree\n' })
  await assert.rejects(call('write_file', { path: 'fixture.txt', content: 'clobber' }), /EEXIST/)
  const page = await call('read_file', { path: 'fixture.txt', start_line: 2, line_count: 1 })
  assert.equal(page.content, '2: two'); assert.equal(page.next_line, 3)
  await call('edit_file', { path: 'fixture.txt', old_text: 'two', new_text: 'updated' })
  assert.equal(await readFile(path.join(root, 'fixture.txt'), 'utf8'), 'one\nupdated\nthree\n')
  await assert.rejects(call('edit_file', { path: 'fixture.txt', old_text: 'missing', new_text: 'bad' }), /exactly once/)
  assert.ok((await call('list_files', {})).entries.some(entry => entry.name === 'fixture.txt'))
  assert.equal((await call('workstation_context', {})).cwd, root)
  assert.equal(tool('edit_file').idempotent, false)
  assert.equal(tool('edit_file').writes, true)
})

test('shell uses the requested cwd, finds files, and does not inherit application credentials', async () => {
  process.env.OP_AGENT_BACKEND = 'connect'
  process.env.OP_ALLOW_DESKTOP = '1'
  process.env.MCP_GATEWAY_AUTH_TOKEN = 'synthetic-gateway-token'
  assert.equal(commandEnvironment().FX0_PROXY_API_KEY, undefined)
  assert.equal(commandEnvironment().SESSION_SECRET, undefined)
  assert.equal(commandEnvironment().OP_AGENT_BACKEND, 'connect')
  assert.equal(commandEnvironment().OP_ALLOW_DESKTOP, undefined)
  assert.equal(commandEnvironment().MCP_GATEWAY_AUTH_TOKEN, undefined)
  const result = await call('exec_command', { command: 'printf "%s" "${FX0_PROXY_API_KEY-unset}:${SESSION_SECRET-unset}"; pwd', yield_time_ms: 1000 })
  assert.equal(result.exit_code, 0)
  assert.match(result.output, /unset:unset/)
  assert.ok(result.output.includes(root))
  const found = await call('search_files', { pattern: 'updated' })
  assert.equal(found.exit_code, 0)
  assert.match(found.output, /fixture.txt:2:updated/)
  await writeFile(path.join(root, 'redaction.txt'), process.env.FX0_PROXY_API_KEY)
  const redacted = await call('read_file', { path: 'redaction.txt' })
  assert.equal(redacted.content, '1: [redacted]')
  assert.ok([...saved.values()].every(value => !value.includes(process.env.FX0_PROXY_API_KEY)))
})

test('real PTY supports interactive input and process handles cannot cross sessions', async () => {
  const ctx = context()
  const running = await call('exec_command', { command: 'test -t 0 || exit 9; printf READY; read answer; printf "received:%s" "$answer"', tty: true, yield_time_ms: 200 }, ctx)
  assert.equal(running.running, true)
  await assert.rejects(call('write_stdin', { process_id: running.process_id }, context(undefined, 'another-session')), /belongs to this session/)
  const done = await call('write_stdin', { process_id: running.process_id, chars: 'hello\n', yield_time_ms: 1000 }, ctx)
  assert.equal(done.exit_code, 0)
  assert.match(done.output, /received:hello/)
})

test('turn cancellation terminates a running command and oversized output reports truncation', async () => {
  const abort = new AbortController(); const ctx = context(abort.signal)
  const running = await call('exec_command', { command: 'sleep 60', yield_time_ms: 10 }, ctx)
  assert.ok(running.process_id)
  abort.abort()
  const done = await call('write_stdin', { process_id: running.process_id, yield_time_ms: 2000 }, context())
  assert.equal(done.running, false)
  assert.equal(done.signal, 'SIGTERM')
  const output = await call('exec_command', { command: 'head -c 50000 /dev/zero | tr "\\0" x', yield_time_ms: 1000 })
  assert.equal(output.output.length, 32768)
  assert.ok(output.omitted_characters > 0)
})
