// KDE entry point. The installed wrapper serializes clicks with flock.
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, open, readFile, readlink, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(import.meta.dirname, '..')
const data = path.join(root, '.local')
const state = path.join(homedir(), '.local/state/fx0')
const url = 'http://127.0.0.1:3000'
const unit = 'fx0-local.service'
const build = path.join(root, '.next')
await mkdir(state, { recursive: true, mode: 0o700 })
const log = await open(path.join(state, 'desktop.log'), 'a', 0o600)
await log.write(`\n${new Date().toISOString()} Build and open fx0\n`)

function run(command, args, { capture = false, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', capture ? 'pipe' : log.fd, log.fd] })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      code === 0 ? resolve(output.trim()) : reject(new Error(`${command} ${args[0] ?? ''} failed (${signal || code}); see ${state}/desktop.log`))
    })
  })
}
const systemctl = (...args) => run('/usr/bin/systemctl', ['--user', ...args])
async function notify(message, critical = false) {
  await run('/usr/bin/notify-send', ['--app-name=fx0', '--icon=fx0', `--urgency=${critical ? 'critical' : 'normal'}`, 'fx0', message]).catch(() => {})
}
async function exists(file) { try { await access(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function json(route) {
  const response = await fetch(`${url}${route}`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`fx0 ${route.split('?')[0]} returned HTTP ${response.status}`)
  return response.json()
}
async function healthy() {
  const identity = await json('/api/auth/me')
  if (identity.user?.id !== 'local:workstation') throw new Error('Port 3000 is not the local fx0 app')
  const models = await json('/api/models')
  if (!Array.isArray(models.models) || !models.models.length) throw new Error('The local model catalog is unavailable')
  // Validate the POST origin path too, without admitting a turn or making a
  // model request. A readable homepage alone does not prove the app can send.
  const prompt = await fetch(`${url}/api/prompt?session=new`, { method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' }, body: '{"text":""}', signal: AbortSignal.timeout(5000) })
  if (prompt.status !== 400 || (await prompt.json()).error !== 'empty prompt') throw new Error('The production prompt route failed its readiness check')
}
async function busy() {
  let cursor
  do {
    const page = await json(`/api/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!Array.isArray(page.sessions)) throw new Error('Unable to check active chats')
    if (page.sessions.some(session => session.busy)) return true
    cursor = page.nextCursor
  } while (cursor)
  return false
}
async function launcherPid() {
  const lock = path.join(data, 'launcher.pid')
  if (!await exists(lock)) return null
  const pid = Number(await readFile(lock, 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid fx0 launcher lock')
  let args, cwd
  try {
    args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
    cwd = await readlink(`/proc/${pid}/cwd`)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (cwd !== root || !args.some(arg => arg === 'scripts/local-dev.mjs' || arg === path.join(root, 'scripts/local-dev.mjs'))) {
    throw new Error('The launcher lock belongs to another process; refusing to stop it')
  }
  return pid
}
async function stop(pid) {
  const managed = Number(await run('/usr/bin/systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], { capture: true }))
  // The unit may use its full TimeoutStopSec=30 before reaping Next.js.
  // Do not kill systemctl at the same deadline and abort an otherwise safe rebuild.
  if (managed === pid) await run('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 45000 })
  else process.kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await exists(`/proc/${pid}`)) return
    await delay(150)
  }
  throw new Error('fx0 is still shutting down; no build was started')
}
async function start() {
  await systemctl('start', unit)
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await healthy(); return } catch { await delay(500) }
  }
  throw new Error('The production server did not become ready')
}
async function openWindow() {
  await run('/usr/bin/systemd-run', ['--user', '--quiet', '--collect', `--unit=fx0-window-${Date.now()}`,
    '--setenv=CHROME_DESKTOP=fx0.desktop', '/usr/bin/google-chrome-stable',
    `--user-data-dir=${path.join(homedir(), '.local/share/fx0/browser')}`,
    '--no-first-run', '--no-default-browser-check', '--class=fx0', `--app=${url}`])
}

try {
  const pid = await launcherPid()
  if (pid) {
    await healthy()
    if (await busy()) {
      await notify('A chat is generating. Opening fx0 without rebuilding or interrupting it.')
      await openWindow()
      process.exitCode = 0
    } else {
      await stop(pid)
      await rebuild()
    }
  } else {
    // Never replace an unrelated listener just because it uses fx0's usual port.
    let occupied = false
    try { await fetch(url, { signal: AbortSignal.timeout(2000) }); occupied = true } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw new Error('Unable to establish that port 3000 is free')
    }
    if (occupied) throw new Error('Port 3000 is in use without a verified fx0 launcher')
    await rebuild()
  }
} catch (error) {
  await log.write(`${new Date().toISOString()} ${error.message}\n`)
  await notify(error.message, true)
  process.exitCode = 1
} finally { await log.close() }

async function rebuild() {
  await notify('Building the latest local fx0 code. The app window will open when ready.')
  const backups = path.join(data, 'desktop-builds')
  await mkdir(backups, { recursive: true, mode: 0o700 })
  const backup = await mkdtemp(path.join(backups, 'previous-'))
  const previous = path.join(backup, '.next')
  const hadBuild = await exists(path.join(build, 'BUILD_ID'))
  if (await exists(build)) await rename(build, previous)
  try {
    await run(process.execPath, ['node_modules/next/dist/bin/next', 'build'], { timeout: 600000 })
    await start()
  } catch (error) {
    await systemctl('stop', unit)
    // Only remove the output of the build above; retain the previous build until
    // the replacement has both built successfully and passed readiness checks.
    await rm(build, { recursive: true, force: true })
    if (await exists(previous)) await rename(previous, build)
    if (hadBuild) {
      await start()
      await notify('The new build failed. Restored the previous build; see ~/.local/state/fx0/desktop.log.', true)
      await openWindow()
    }
    throw error
  }
  await rm(backup, { recursive: true, force: true })
  await notify('Build complete. Opening fx0.')
  await openWindow()
  await log.write(`${new Date().toISOString()} Ready: ${url}\n`)
}
