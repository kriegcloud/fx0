import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { FxHostTool, FxToolContext } from 'libfx'
import type { ToolHost } from './tools'
// @ts-expect-error Node strip-types tests require the source extension.
import { localMode } from './local-mode.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { sniffImageType } from './image-sniff.ts'

export function workstationEnabled(): boolean {
  return localMode() && process.env.FX0_WORKSTATION_TOOLS === '1'
}

const OUTPUT_LIMIT = 32 * 1024
const BUFFER_LIMIT = 2 * 1024 * 1024
const SECRET_ENV = /(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY)(?:_|$)|^OP_SESSION_|^DATABASE_URL$/
function redact(text: string): string {
  for (const [key, value] of Object.entries(process.env)) if (SECRET_ENV.test(key) && value && value.length > 3) text = text.replaceAll(value, '[redacted]')
  return text
}
export function commandEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: process.env.NODE_ENV, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV.test(key) && !key.startsWith('FX0_') && key !== 'OP_ALLOW_DESKTOP')) }
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`${name} must be nonempty text without NUL bytes`)
  return value
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Expected an integer from ${min} to ${max}`)
  return Number(value)
}
function location(value?: string): string {
  const cwd = process.env.FX0_WORKING_DIRECTORY || process.cwd()
  return path.resolve(cwd, value === '~' ? homedir() : value?.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value || '.')
}
type Process = {
  owner: string; child: ChildProcessWithoutNullStreams; output: string; omitted: number;
  exited: boolean; exitCode: number | null; signal: string | null; finished: Promise<void>; stop: () => void;
}
const global = globalThis as unknown as { __fx0WorkstationProcesses?: Map<string, Process> }
const processes = global.__fx0WorkstationProcesses ??= new Map<string, Process>()
async function collect(id: string, entry: Process, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([entry.finished, new Promise(resolve => { timer = setTimeout(resolve, wait) })]) }
  finally { clearTimeout(timer) }
  const output = redact(entry.output)
  const omitted = entry.omitted + Math.max(0, output.length - OUTPUT_LIMIT)
  entry.output = ''; entry.omitted = 0
  if (entry.exited) processes.delete(id)
  return { process_id: entry.exited ? null : id, running: !entry.exited, exit_code: entry.exitCode, signal: entry.signal,
    output: output.slice(-OUTPUT_LIMIT), omitted_characters: omitted }
}

export async function executeCommand(input: { command: string; workdir?: string; tty?: boolean; yield_time_ms?: number; timeout_ms?: number }, ctx: FxToolContext) {
  ctx.signal.throwIfAborted()
  const command = text(input.command, 'command')
  const cwd = location(input.workdir)
  const wait = integer(input.yield_time_ms, 1000, 1, 30000)
  const timeout = integer(input.timeout_ms, 120000, 100, 3600000)
  if (processes.size >= 32) throw new Error('Too many running commands; finish or terminate an existing process first')
  const env = commandEnvironment()
  const shell = env.SHELL || '/bin/bash'
  // util-linux script supplies a real PTY for interactive CLIs and yubi-sudo.
  const child = input.tty
    ? spawn('/usr/bin/script', ['--quiet', '--return', '--flush', '--command', command, '/dev/null'], { cwd, env: { ...env, SHELL: shell }, detached: true, stdio: 'pipe' })
    : spawn(shell, ['-lc', command], { cwd, env, detached: true, stdio: 'pipe' })
  const id = randomUUID()
  let finish!: () => void
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const entry: Process = { owner: ctx.sessionId, child, output: '', omitted: 0, exited: false, exitCode: null, signal: null,
    finished: new Promise(resolve => { finish = resolve }), stop() {
      if (entry.exited || !child.pid) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
      killTimer ??= setTimeout(() => { if (!entry.exited && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }, 1000)
    } }
  const append = (chunk: string) => {
    entry.output += chunk
    if (entry.output.length > BUFFER_LIMIT) { entry.omitted += entry.output.length - BUFFER_LIMIT; entry.output = entry.output.slice(-BUFFER_LIMIT) }
  }
  child.stdout.setEncoding('utf8').on('data', append)
  child.stderr.setEncoding('utf8').on('data', append)
  child.stdin.on('error', () => {})
  child.on('error', error => append(`Command failed: ${error.message}`))
  const deadline = setTimeout(entry.stop, timeout)
  ctx.signal.addEventListener('abort', entry.stop, { once: true })
  child.once('close', (code, signal) => {
    entry.exited = true; entry.exitCode = code; entry.signal = signal
    clearTimeout(deadline); clearTimeout(killTimer)
    ctx.signal.removeEventListener('abort', entry.stop)
    finish()
    // Keep a completed result briefly for the next poll, without leaking handles.
    const expiry = setTimeout(() => processes.delete(id), 300000)
    expiry.unref()
  })
  processes.set(id, entry)
  if (ctx.signal.aborted) entry.stop()
  return collect(id, entry, wait)
}

const string = { type: 'string' as const }
const number = (min: number, max: number) => ({ type: 'integer' as const, minimum: min, maximum: max })
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false })

export function workstationTools(host: ToolHost): FxHostTool[] {
  if (!workstationEnabled()) return []
  const definitions: FxHostTool[] = [
    {
      name: 'workstation_context', description: 'Discover this local agent working directory, user home, filesystem/shell permissions, and skill locations. These are real host tools, separate from the isolated design preview.',
      inputSchema: schema({}), idempotent: true,
      execute: async () => ({ cwd: location(), home: homedir(), access: 'current OS user: filesystem read/write, shell, network and installed CLIs',
        skill_directories: [path.join(homedir(), '.agents/skills'), path.join(homedir(), '.codex/skills')],
        instructions: 'Read applicable AGENTS.md/CLAUDE.md and requested skills before project work. Preserve unrelated edits.' }),
    },
    {
      name: 'exec_command', description: 'Run a shell command on the workstation: git, builds, tests, curl/network requests, installed coding CLIs and other command-line tools. Optional real PTY supports interactive programs. Returns a process_id while running; poll or send input using write_stdin. Cancellation stops the process group. Never print credentials; use the workstation YubiKey wrappers for privilege.',
      inputSchema: schema({ command: string, workdir: string, tty: { type: 'boolean' }, yield_time_ms: number(1, 30000), timeout_ms: number(100, 3600000) }, ['command']),
      idempotent: false, writes: true, execute: executeCommand,
    },
    {
      name: 'write_stdin', description: 'Poll a running exec_command, send terminal input, or terminate it. Only processes owned by this agent session are accessible. Never send passwords or other secret human input; use the workstation sensitive-input route.',
      inputSchema: schema({ process_id: string, chars: string, terminate: { type: 'boolean' }, yield_time_ms: number(1, 30000) }, ['process_id']),
      idempotent: false, writes: true,
      async execute(input: { process_id: string; chars?: string; terminate?: boolean; yield_time_ms?: number }, ctx) {
        const entry = processes.get(text(input.process_id, 'process_id'))
        if (!entry || entry.owner !== ctx.sessionId) throw new Error('No process with this ID belongs to this session')
        if (input.terminate) entry.stop()
        else if (input.chars !== undefined) {
          if (typeof input.chars !== 'string' || input.chars.length > 65536) throw new Error('chars must be a string of at most 65536 characters')
          entry.child.stdin.write(input.chars)
        }
        return collect(input.process_id, entry, integer(input.yield_time_ms, 1000, 1, 30000))
      },
    },
    {
      name: 'read_file', description: 'Read any local UTF-8 file accessible to the current user, including project handoffs, AGENTS.md, skills, dotfiles and source code. Returns numbered lines with paging. Do not read or disclose secret values; use configured credential tools instead.',
      inputSchema: schema({ path: string, start_line: number(1, 100000000), line_count: number(1, 1000) }, ['path']), idempotent: true,
      async execute(input: { path: string; start_line?: number; line_count?: number }, ctx) {
        const file = location(text(input.path, 'path'))
        if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('Use exec_command to page this file; it exceeds the 16 MiB read buffer')
        const content = await readFile(file, { encoding: 'utf8', signal: ctx.signal })
        if (content.includes('\0')) throw new Error('This is a binary file; use view_image or an appropriate command-line reader')
        const lines = redact(content).split('\n'); const start = integer(input.start_line, 1, 1, 100000000) - 1
        const end = Math.min(lines.length, start + integer(input.line_count, 200, 1, 1000))
        const result = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n')
        return { path: file, content: result.slice(0, OUTPUT_LIMIT), next_line: end < lines.length ? end + 1 : null, truncated: result.length > OUTPUT_LIMIT, total_lines: lines.length }
      },
    },
    {
      name: 'list_files', description: 'List a local directory, including hidden files, without reference-root restrictions. Use exec_command with rg --files or find for recursive discovery.',
      inputSchema: schema({ path: string, offset: number(0, 100000000) }), idempotent: true,
      async execute(input: { path?: string; offset?: number }) {
        const directory = location(input.path); const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
        const start = integer(input.offset, 0, 0, 100000000)
        return { path: directory, entries: entries.slice(start, start + 200).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'symlink' : 'file' })), next_offset: start + 200 < entries.length ? start + 200 : null }
      },
    },
    {
      name: 'write_file', description: 'Create or replace a UTF-8 file on the workstation. Existing files require overwrite=true. Read existing content first and preserve unrelated changes. Parent directories must already exist.',
      inputSchema: schema({ path: string, content: string, overwrite: { type: 'boolean' } }, ['path', 'content']), idempotent: false, writes: true,
      async execute(input: { path: string; content: string; overwrite?: boolean }, ctx) {
        if (typeof input.content !== 'string') throw new Error('content must be text')
        const file = location(text(input.path, 'path'))
        await writeFile(file, input.content, { flag: input.overwrite === true ? 'w' : 'wx', signal: ctx.signal })
        return { path: file, bytes_written: Buffer.byteLength(input.content) }
      },
    },
    {
      name: 'edit_file', description: 'Replace one exact text occurrence in a local file. Fails on missing or ambiguous matches instead of guessing or overwriting unrelated content.',
      inputSchema: schema({ path: string, old_text: string, new_text: string }, ['path', 'old_text', 'new_text']), idempotent: false, writes: true,
      async execute(input: { path: string; old_text: string; new_text: string }, ctx) {
        const file = location(text(input.path, 'path')); const old = text(input.old_text, 'old_text')
        if (typeof input.new_text !== 'string') throw new Error('new_text must be text')
        const source = await readFile(file, { encoding: 'utf8', signal: ctx.signal })
        const index = source.indexOf(old)
        if (index < 0 || source.indexOf(old, index + 1) >= 0) throw new Error('old_text must match exactly once; read the file and use more context')
        await writeFile(file, source.slice(0, index) + input.new_text + source.slice(index + old.length), { signal: ctx.signal })
        return { path: file, replacements: 1 }
      },
    },
    {
      name: 'search_files', description: 'Search local file contents with ripgrep regular expressions, including hidden files. Gitignore rules apply. Use exec_command for other rg flags or file-name searches.',
      inputSchema: schema({ pattern: string, path: string }, ['pattern']), idempotent: true,
      async execute(input: { pattern: string; path?: string }, ctx) {
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
        return executeCommand({ command: `rg --line-number --hidden --max-count 100 -- ${quote(text(input.pattern, 'pattern'))} ${quote(location(input.path))}`, yield_time_ms: 1000 }, ctx)
      },
    },
    {
      name: 'view_image', description: 'Inspect a local PNG/JPEG/GIF/WebP and import it into this chat as an fx0-asset reference usable in the design. Files are read on the server; filesystem URLs never go into the preview.',
      inputSchema: schema({ path: string }, ['path']), idempotent: false,
      async execute(input: { path: string }, ctx) {
        const file = location(text(input.path, 'path'))
        if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('Resize the image to at most 2 MiB with a local command before viewing')
        const bytes = await readFile(file, { signal: ctx.signal }); const mimeType = sniffImageType(bytes)
        if (!mimeType) throw new Error('Unsupported image format')
        const image = { type: 'image' as const, mimeType, data: bytes.toString('base64') }
        const asset = await host.importReferenceImage(image)
        return { type: 'libfx.tool-result', text: JSON.stringify({ path: file, asset }), images: [image] }
      },
    },
  ]
  return definitions.map(tool => ({ ...tool, writes: tool.writes ?? false,
    async execute(input, ctx) {
      if (!workstationEnabled()) throw new Error('Workstation tools are available only in explicitly enabled local mode')
      ctx.signal.throwIfAborted()
      const id = host.reportInvocation(tool.name)
      const result = await tool.execute(input, ctx)
      // Image bytes are handed to libfx, never copied into the textual tool log.
      const summary = result && typeof result === 'object' && 'type' in result && result.type === 'libfx.tool-result' && 'text' in result ? String(result.text) : JSON.stringify(result)
      host.storeResult(id, redact(summary))
      return result
    },
  }))
}
