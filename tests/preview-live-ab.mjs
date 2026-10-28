// Live A/B for the first design preview load, in one owned tab of the normal, authenticated Chrome.
// A reconstructs the old JSON-first client flow: the helper's LEGACY_BASELINE guard is removed from the
// compiled PreviewPane. It is not the deployed old bundle. B is the unmodified current component.
// Both run in the same tab against the real /api/artifact-frame with the user's own cookies; nothing is
// mocked, delayed or retried. Only read requests are made, plus client-side revision changes and captures.
// Warm policy: the ordinary HTTP cache stays on; 2 warmup pairs are excluded; each sample is bracketed by a
// read-only source probe. Clocks are performance.now in the page; the host only polls over AppleEvents.
// imageReady = setRevision to the encoded image Blob. Decoding validates it afterward, outside the clock.
// It excludes server publication, LLM and upload work.
// Limits: one tab, network path and revision; the reused Next page's own timers may keep running after
// document.open; the baseline is a reconstruction; 30 pairs is a small sample for the bootstrap interval.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { MAX_CAPTURE_BYTES, MAX_CAPTURE_TILES } from '../lib/capture-protocol.ts'
import { LEGACY_BASELINE, OBSERVER, buildPaneFixture } from './helpers/preview-pane-fixture.mjs'

const execFileAsync = promisify(execFile)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FRAME = { width: 1000, height: 720 } // the fixture's front iframe size (helper CSS)
const IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png']
const WARMUP_ORDERS = ['AB', 'BA']
const BOOTSTRAP_RESAMPLES = 2000
const TAB_TIMEOUT_MS = 30_000
const USAGE = 'usage: node --experimental-strip-types tests/preview-live-ab.mjs --tab ID --session UUID --out FILE [--window ID] [--pairs N (even, 2..200)] [--seed UINT32]'

// Picks the tab by its id as text, activates it, and runs the JS payload that the host wrote to a temp file.
const TAB_SCRIPT = `on run argv
  set tabId to item 1 of argv
  set requiredWindow to item 3 of argv
  set jsText to read (POSIX file (item 2 of argv)) as «class utf8»
  try
    tell application "Google Chrome"
      repeat with w in windows
        repeat with i from 1 to count of tabs of w
          set t to tab i of w
          if ((id of t) as text) is tabId then
            if requiredWindow is not "" and ((id of w) as text) is not requiredWindow then return "ERROR:The owned tab moved to another window"
            set bounds of w to {0, 24, 1440, 1000}
            set active tab index of w to i
            activate
            return "WINDOW:" & ((id of w) as text) & "|" & (execute t javascript jsText)
          end if
        end repeat
      end repeat
    end tell
    return "NOTFOUND"
  on error errMessage number errNumber
    return "ERROR:" & errNumber & ":" & errMessage
  end try
end run
`

export function parseArgs(argv) {
  const options = { tab: null, window: null, session: null, pairs: 30, seed: null, out: null }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}. ${USAGE}`)
    if (flag === '--tab') options.tab = value
    else if (flag === '--window') options.window = value
    else if (flag === '--session') options.session = value
    else if (flag === '--pairs') options.pairs = Number(value)
    else if (flag === '--seed') options.seed = Number(value)
    else if (flag === '--out') options.out = value
    else throw new Error(`unknown option ${flag}. ${USAGE}`)
  }
  if (!/^\d+$/.test(options.tab ?? '')) throw new Error(`--tab must be the numeric tab id. ${USAGE}`)
  if (options.window !== null && !/^\d+$/.test(options.window)) throw new Error('--window must be a numeric window id')
  if (!UUID.test(options.session ?? '')) throw new Error(`--session must be the preview session UUID. ${USAGE}`)
  if (!options.out) throw new Error(`--out is required. ${USAGE}`)
  if (!Number.isSafeInteger(options.pairs) || options.pairs < 2 || options.pairs > 200 || options.pairs % 2) {
    throw new Error('--pairs must be an even integer from 2 to 200, so AB and BA counts match')
  }
  options.seed ??= randomBytes(4).readUInt32BE()
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) throw new Error('--seed must be a uint32')
  return options
}

// mulberry32: a small seeded PRNG, so the schedule and the bootstrap are reproducible from the output seed.
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeSchedule(pairs, seed) {
  const random = mulberry32(seed)
  const measured = Array.from({ length: pairs }, (_, index) => (index < pairs / 2 ? 'AB' : 'BA'))
  for (let index = measured.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[measured[index], measured[swap]] = [measured[swap], measured[index]]
  }
  return { seed, warmups: [...WARMUP_ORDERS], measured }
}

export function median(values) {
  if (!values.length) throw new Error('median of no values')
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const round = value => Math.round(value * 10) / 10

export function bootstrapMedianCI(values, seed, resamples = BOOTSTRAP_RESAMPLES) {
  const random = mulberry32(seed)
  const medians = Array.from({ length: resamples }, () => median(values.map(() => values[Math.floor(random() * values.length)])))
  medians.sort((a, b) => a - b)
  return [medians[Math.floor(0.025 * resamples)], medians[Math.ceil(0.975 * resamples) - 1]]
}

// Measured samples only: warmups are excluded by flag, and an incomplete pair fails instead of dropping out.
export function summarize(samples, seed) {
  const measured = samples.filter(sample => !sample.warmup)
  const pairs = new Map()
  for (const sample of measured) {
    const entry = pairs.get(sample.pair) ?? { pair: sample.pair, order: sample.order, A: null, B: null }
    if (entry.order !== sample.order || entry[sample.variant] !== null) throw new Error(`pair ${sample.pair} is inconsistent`)
    entry[sample.variant] = sample
    pairs.set(sample.pair, entry)
  }
  const rows = [...pairs.values()].sort((a, b) => a.pair - b.pair).map(entry => {
    if (!entry.A || !entry.B) throw new Error(`pair ${entry.pair} is incomplete`)
    const raw = entry.B.imageReadyMs - entry.A.imageReadyMs
    return { pair: entry.pair, order: entry.order, raw, deltaMs: round(raw) }
  })
  if (rows.length < 2) throw new Error('at least two measured pairs are required')
  const deltas = rows.map(row => row.raw)
  const variant = letter => {
    const values = measured.filter(sample => sample.variant === letter)
    return { n: values.length, medianImageReadyMs: round(median(values.map(sample => sample.imageReadyMs))), medianReadyMs: round(median(values.map(sample => sample.readyMs))) }
  }
  const [low, high] = bootstrapMedianCI(deltas, seed ^ 0x9e3779b9)
  const byOrder = order => {
    const values = rows.filter(row => row.order === order).map(row => row.raw)
    return values.length ? round(median(values)) : null
  }
  return {
    n: rows.length, A: variant('A'), B: variant('B'),
    pairedDeltaMs: { definition: 'B - A per pair, imageReady', median: round(median(deltas)), ci95: [round(low), round(high)], method: `percentile bootstrap of the median, ${BOOTSTRAP_RESAMPLES} resamples` },
    byOrder: { AB: byOrder('AB'), BA: byOrder('BA') },
    pairs: rows.map(({ pair, order, deltaMs }) => ({ pair, order, deltaMs })),
  }
}

// The host reads only the tab output line; the page itself has already timed everything it reports.
export function parseTabOutput(stdout, expectedWindow) {
  const text = stdout.replace(/\n$/, '')
  if (text === 'NOTFOUND') throw new Error('the owned test tab was not found')
  if (text.startsWith('ERROR:')) throw new Error(`AppleEvents error ${text.slice(0, 200)}`)
  const match = /^WINDOW:(\d+)\|/.exec(text)
  if (!match) throw new Error('unexpected AppleEvents output')
  if (expectedWindow && match[1] !== expectedWindow) throw new Error(`the tab is in window ${match[1]}, expected ${expectedWindow}`)
  return text.slice(match[0].length)
}

export function checkOrigin({ protocol, hostname }) {
  if (protocol !== 'https:' || !hostname.startsWith('fx0-') || !hostname.endsWith('.labs.vercel.dev')) {
    throw new Error(`the owned tab is not an fx0 preview origin (${protocol} ${hostname})`)
  }
}

export function checkProbe(probe, session, revision = null) {
  if (!probe?.ok) throw new Error(`source probe failed: ${probe?.error ?? 'no result'}`)
  if (probe.status !== 200 || probe.type !== 'basic' || probe.redirected) throw new Error(`source probe answered ${probe.status} (${probe.type})`)
  if (!String(probe.contentType).startsWith('application/json')) throw new Error('source probe is not JSON')
  if (probe.protocol !== 1 || probe.sessionId !== session) throw new Error('source probe has the wrong protocol or session')
  if (!Number.isSafeInteger(probe.revision) || probe.revision < 1 || (revision !== null && probe.revision !== revision)) throw new Error('source probe revision changed')
  if (!(probe.sourceLength > 0) || !/^[0-9a-f]{64}$/.test(probe.sha256 ?? '')) throw new Error('source probe has no source hash')
  if (probe.images !== 0) throw new Error('the live source has images; this benchmark requires none')
  return probe
}

export function checkResources(entries, variant, session) {
  const formats = entries.map(entry => entry.format)
  const expected = variant === 'A' ? ['json', 'html'] : ['html']
  if (JSON.stringify(formats) !== JSON.stringify(expected)) throw new Error(`variant ${variant} requests were ${formats.join(',') || 'none'}`)
  if (entries.some(entry => entry.session !== session)) throw new Error('a frame request has the wrong session')
}

export function checkTrial(trial, { variant, session, revision, viewport }) {
  if (!trial?.ok) throw Object.assign(new Error(`trial ${variant} failed: ${trial?.error ?? 'no result'}`), { diagnostics: trial ?? null })
  if (trial.errors !== 0) throw new Error(`trial ${variant} observed hydration or runtime errors`)
  if (trial.paint.sessionId !== session || trial.paint.revision !== revision || trial.paint.protocol !== 1 || typeof trial.paint.updateReady !== 'boolean') {
    throw new Error(`trial ${variant} painted the wrong revision or protocol`)
  }
  for (const side of [trial.viewport.before, trial.viewport.after]) {
    if (side.visibility !== 'visible') throw new Error('the owned tab was hidden during a trial')
    if (side.width !== viewport.width || side.height !== viewport.height) throw new Error('the viewport changed during a trial')
  }
  if (!(trial.readyMs >= 0) || trial.imageReadyMs < trial.readyMs) throw new Error(`trial ${variant} has inconsistent timings`)
  if (trial.frame.width !== FRAME.width || trial.frame.height !== FRAME.height) throw new Error('the front frame is not 1000x720')
  if (trial.reply.error) throw new Error(`capture failed: ${trial.reply.error}`)
  const { blobs } = trial.reply
  if (blobs.length < 1 || blobs.length > MAX_CAPTURE_TILES) throw new Error(`capture returned ${blobs.length} images`)
  if (blobs.reduce((sum, blob) => sum + blob.size, 0) > MAX_CAPTURE_BYTES) throw new Error('capture images contain too many bytes in total')
  for (const blob of blobs) {
    if (!IMAGE_TYPES.includes(blob.type) || !(blob.size > 0) || blob.size > MAX_CAPTURE_BYTES) throw new Error(`capture image is ${blob.type} ${blob.size} bytes`)
    if (blob.width !== FRAME.width || blob.height !== FRAME.height) throw new Error('a captured image is not 1000x720')
  }
  checkResources(trial.resources, variant, session)
  return trial
}

export function stripScripts(html) {
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  if (/<script\b/i.test(stripped)) throw new Error('a script tag survived stripping')
  return stripped
}

// Every browser step is a short expression; the only long text (the bundle) travels through a temp file.
const INFO_SOURCE = 'JSON.stringify({ protocol: location.protocol, hostname: location.hostname, visibility: document.visibilityState, width: innerWidth, height: innerHeight })'
const READ_PROBE = 'JSON.stringify(window.__abProbe ?? null)'
const READ_TRIAL = 'JSON.stringify(window.__abTrial ?? null)'
const READY = `JSON.stringify({
  fixtureReady: window.fixtureReady === true,
  frames: document.querySelectorAll('#preview-pane iframe').length,
  frameRequests: performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/api/artifact-frame').length,
  errors: window.observed ? observed.errors.length : -1,
  api: typeof window.setRevision === 'function' && typeof window.captureFrame === 'function' && typeof window.unmountFixture === 'function',
})`

// Read-only probe: the same authenticated GET the app makes; the hash is computed in the page.
function probeSource(session) {
  return `(() => {
  window.__abProbe = null
  ;(async () => {
    try {
      const response = await fetch(${JSON.stringify(`/api/artifact-frame?session=${encodeURIComponent(session)}&format=json`)}, { cache: 'no-store', redirect: 'manual', credentials: 'same-origin' })
      const contentType = response.headers.get('content-type') || ''
      const body = response.status === 200 && contentType.startsWith('application/json') ? JSON.parse(await response.text()) : null
      const html = typeof body?.sourceHtml === 'string' ? body.sourceHtml : ''
      const digest = html ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html)))].map(byte => byte.toString(16).padStart(2, '0')).join('') : null
      window.__abProbe = { ok: true, status: response.status, type: response.type, redirected: response.redirected, contentType,
        protocol: body?.protocol ?? null, sessionId: body?.sessionId ?? null, revision: body?.revision ?? null,
        sourceLength: html.length, images: Array.isArray(body?.images) ? body.images.length : null, sha256: digest }
    } catch (error) { window.__abProbe = { ok: false, error: String(error && error.message || error) } }
  })()
  return 'started'
})()`
}

function resetSource(html) {
  return `(() => {
  performance.clearResourceTimings()
  window.__abTrial = null
  if (typeof window.unmountFixture === 'function') window.unmountFixture()
  window.fixtureReady = false
  delete window.setRevision
  delete window.captureFrame
  delete window.unmountFixture
  document.open(); document.write(${JSON.stringify(html)}); document.close()
  return 'reset'
})()`
}

// The measured interval runs in the page: setRevision to a decoded image. The host only polls for the result.
function trialSource({ session, revision, expectedRequests }) {
  return `(() => {
  const session = ${JSON.stringify(session)}, revision = ${revision}, expectedRequests = ${expectedRequests}
  const frameSelector = '#preview-pane iframe[title="Design artifact preview"]:not([aria-hidden="true"])'
  const round = value => Math.round(value * 1000) / 1000
  const viewport = () => ({ width: innerWidth, height: innerHeight, visibility: document.visibilityState })
  const tick = () => new Promise(resolve => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 100) })
  const waitFor = async (label, check) => {
    const deadline = performance.now() + 15000
    for (;;) {
      const value = check()
      if (value) return value
      if (performance.now() > deadline) throw new Error('timed out waiting for ' + label)
      await tick()
    }
  }
  window.__abTrial = null
  const diagnostics = { phase: 'waiting for paint' }
  ;(async () => {
    try {
      const before = viewport()
      if (before.visibility !== 'visible') throw new Error('the tab is not visible')
      performance.clearResourceTimings()
      const start = performance.now()
      window.setRevision(revision)
      const paint = await waitFor('the trusted paint', () => observed.paints.find(entry => entry.observedAt >= start
        && entry.sessionId === session && entry.revision === revision && entry.protocol === 1 && typeof entry.updateReady === 'boolean'))
      const front = await waitFor('the front frame', () => {
        const frame = document.querySelector(frameSelector)
        return frame && frame.getAttribute('src') === paint.mountUrl ? frame : null
      })
      const readyMs = paint.observedAt - start
      Object.assign(diagnostics, { phase: 'capturing image', readyMs })
      const reply = await window.captureFrame(front.contentWindow, crypto.randomUUID(), false)
      const imageReadyMs = performance.now() - start
      diagnostics.imageReadyMs = imageReadyMs
      if (!reply) throw new Error('the capture reply did not arrive')
      const blobs = []
      for (const blob of reply.blobs) {
        const bitmap = await createImageBitmap(blob)
        blobs.push({ type: blob.type, size: blob.size, width: bitmap.width, height: bitmap.height })
        bitmap.close()
      }
      const frameEntries = () => performance.getEntriesByType('resource')
        .filter(entry => new URL(entry.name).pathname === '/api/artifact-frame')
        .sort((a, b) => a.startTime - b.startTime)
        .map(entry => {
          const url = new URL(entry.name)
          return { format: url.searchParams.get('format') === 'json' ? 'json' : 'html', session: url.searchParams.get('session'),
            initiator: entry.initiatorType, startMs: round(entry.startTime - start), durationMs: round(entry.duration),
            ttfbMs: round(entry.responseStart - entry.requestStart), transferSize: entry.transferSize,
            decodedBodySize: entry.decodedBodySize, responseStatus: entry.responseStatus }
        })
      Object.assign(diagnostics, { phase: 'collecting request timings', images: blobs, frameTiming: reply.timing ?? null })
      const resources = await waitFor('the frame request entries', () => { const entries = frameEntries(); return entries.length >= expectedRequests ? entries : null })
      const rect = front.getBoundingClientRect()
      window.__abTrial = { ok: true, readyMs: round(readyMs), imageReadyMs: round(imageReadyMs),
        paint: { sessionId: paint.sessionId, revision: paint.revision, protocol: paint.protocol, updateReady: paint.updateReady },
        mountId: new URL(paint.mountUrl, location.origin).searchParams.get('mount'),
        frame: { width: Math.round(rect.width), height: Math.round(rect.height) },
        reply: { error: reply.error ?? null, truncated: reply.truncated === true, blobs, timing: reply.timing ?? null },
        resources, viewport: { before, after: viewport() }, errors: observed.errors.length }
    } catch (error) {
      diagnostics.resources = performance.getEntriesByType('resource').map(entry => {
        const url = new URL(entry.name, location.origin)
        return { path: url.pathname, format: url.searchParams.get('format'), initiator: entry.initiatorType,
          durationMs: entry.duration, startTime: entry.startTime }
      })
      try {
        const frameWindow = document.querySelector(frameSelector)?.contentWindow
        diagnostics.frameNavigation = frameWindow ? frameWindow.performance.getEntriesByType('navigation').map(entry => ({
          path: new URL(entry.name).pathname, startTime: entry.startTime, durationMs: entry.duration,
          responseStatus: entry.responseStatus, timeOrigin: frameWindow.performance.timeOrigin,
        })) : []
      } catch { diagnostics.frameNavigationError = 'Frame navigation timing is not accessible' }
      window.__abTrial = { ok: false, error: String(error && error.message || error), diagnostics }
    }
  })()
  return 'started'
})()`
}

// Exported for compile-only tests; the runner itself never evaluates these outside the tab.
export const browserSources = { info: INFO_SOURCE, ready: READY, readProbe: READ_PROBE, readTrial: READ_TRIAL, probe: probeSource, reset: resetSource, trial: trialSource }

// AppleEvents execution has different resource-timing visibility from page scripts.
// Run trusted harness code in the page and return only its result through the shared DOM.
export function pageBridge(source) {
  const attribute = 'data-fx0-ab-result'
  const pageScript = `try {
    const value = (0, eval)(${JSON.stringify(source)});
    document.documentElement.setAttribute('${attribute}', JSON.stringify({ ok: true, value }));
  } catch (error) {
    document.documentElement.setAttribute('${attribute}', JSON.stringify({ ok: false, error: String(error.message || error) }));
  }`
  return `(() => {
    document.documentElement.removeAttribute('${attribute}');
    const script = document.createElement('script');
    script.textContent = ${JSON.stringify(pageScript)};
    document.head.append(script);
    script.remove();
    const text = document.documentElement.getAttribute('${attribute}');
    if (text === null) throw new Error('Page script did not execute; check the page CSP');
    const result = JSON.parse(text);
    if (!result.ok) throw new Error(result.error);
    return result.value === undefined ? '' : String(result.value);
  })()`
}

async function runTab(ctx, source) {
  const file = join(ctx.dir, `payload-${ctx.count++}.js`)
  await writeFile(file, pageBridge(source))
  try {
    const { stdout } = await execFileAsync('osascript', [ctx.script, ctx.tab, file, ctx.window ?? ''], { timeout: TAB_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    return parseTabOutput(stdout, ctx.window)
  } finally { await rm(file, { force: true }) }
}

async function pollUntil(ctx, source, done, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  do {
    last = JSON.parse(await runTab(ctx, source))
    if (done(last)) return last
    await sleep(100)
  } while (Date.now() < deadline)
  throw new Error(`timed out: ${label}; last state ${JSON.stringify(last).slice(0, 300)}`)
}

async function probe(ctx, session) {
  await runTab(ctx, probeSource(session))
  return pollUntil(ctx, READ_PROBE, value => value !== null, 'the source probe')
}

function assertSource(current, expected) {
  if (current.sha256 !== expected.sha256 || current.sourceLength !== expected.sourceLength) throw new Error('the live source changed during the run')
}

async function preflight(ctx, session) {
  // Let Chrome process the owned window's bounds before freezing its viewport.
  await runTab(ctx, INFO_SOURCE)
  const info = JSON.parse(await runTab(ctx, INFO_SOURCE))
  checkOrigin(info)
  if (info.visibility !== 'visible') throw new Error('the owned tab is not visible')
  const first = checkProbe(await probe(ctx, session), session)
  return {
    origin: `https://${info.hostname}`, viewport: { width: info.width, height: info.height },
    source: { revision: first.revision, sha256: first.sha256, sourceLength: first.sourceLength, images: first.images },
  }
}

async function buildVariant(dir, session, experiment) {
  await mkdir(dir, { recursive: true })
  const { bundle, html } = await buildPaneFixture(dir, experiment, { sessionId: session, initialRevision: 0 })
  return { html: stripScripts(html), observer: `${OBSERVER}\n;'observer'`, bundle: `${bundle.toString('utf8')}\n;'bundle'` }
}

async function runSample(ctx, run, letter, meta) {
  const variant = run.variants[letter]
  const before = checkProbe(await probe(ctx, run.session), run.session, run.source.revision)
  assertSource(before, run.source)
  if ((await runTab(ctx, resetSource(variant.html))) !== 'reset') throw new Error('the fixture reset did not complete')
  await runTab(ctx, variant.observer)
  await runTab(ctx, variant.bundle)
  await pollUntil(ctx, READY, ready => ready.fixtureReady && ready.frames === 0 && ready.frameRequests === 0 && ready.errors === 0 && ready.api,
    'a fixture ready without frames or requests')
  await runTab(ctx, trialSource({ session: run.session, revision: run.source.revision, expectedRequests: letter === 'A' ? 2 : 1 }))
  const rawTrial = await pollUntil(ctx, READ_TRIAL, value => value !== null, 'the measured trial', 30_000)
  let trial
  try {
    trial = checkTrial(rawTrial, { variant: letter, session: run.session, revision: run.source.revision, viewport: run.preflight.viewport })
  } catch (error) {
    error.diagnostics ??= rawTrial
    throw error
  }
  const after = checkProbe(await probe(ctx, run.session), run.session, run.source.revision)
  assertSource(after, run.source)
  run.mountIds.add(trial.mountId)
  return {
    ...meta, variant: letter, readyMs: trial.readyMs, imageReadyMs: trial.imageReadyMs,
    paintUpdateReady: trial.paint.updateReady, truncated: trial.reply.truncated, frameTiming: trial.reply.timing,
    blobs: trial.reply.blobs.map(({ type, size, width, height }) => ({ type, size, width, height })),
    resources: trial.resources.map(({ format, startMs, durationMs, ttfbMs, transferSize, decodedBodySize, responseStatus, initiator }) => ({ format, startMs, durationMs, ttfbMs, transferSize, decodedBodySize, responseStatus, initiator })),
    source: { before: { revision: before.revision, sha256: before.sha256 }, after: { revision: after.revision, sha256: after.sha256 } },
  }
}

async function main(options) {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-live-ab-'))
  const ctx = { dir, tab: options.tab, window: options.window, count: 0, script: join(dir, 'tab.applescript') }
  await writeFile(ctx.script, TAB_SCRIPT)
  const plan = makeSchedule(options.pairs, options.seed)
  const result = { kind: 'fx0-preview-live-ab', startedAt: new Date().toISOString(), seed: options.seed, schedule: plan,
    windowBounds: [0, 24, 1440, 1000],
    variants: { A: 'reconstructed client flow: helper LEGACY_BASELINE removed, not the deployed old bundle', B: 'current unmodified PreviewPane' },
    limits: ['one owned tab, one revision, one network path', 'the reused Next page timers may keep running after document.open',
      'the HTTP cache is default and warm after warmups; cold is not claimed', 'imageReady excludes publication, LLM and upload work',
      'n=30 pairs is a small sample; the interval is a percentile bootstrap of the median'],
    samples: [], completed: false }
  try {
    result.preflight = await preflight(ctx, options.session)
    const run = { session: options.session, preflight: result.preflight, source: result.preflight.source, mountIds: new Set(),
      variants: { A: await buildVariant(join(dir, 'A'), options.session, LEGACY_BASELINE), B: await buildVariant(join(dir, 'B'), options.session, null) } }
    const orders = [...plan.warmups.map((order, index) => ({ order, pair: `warmup-${index + 1}`, warmup: true })),
      ...plan.measured.map((order, index) => ({ order, pair: index + 1, warmup: false }))]
    for (const { order, pair, warmup } of orders) {
      for (const letter of order) {
        result.samples.push(await runSample(ctx, run, letter, { index: result.samples.length + 1, pair, order, warmup }))
      }
      console.log(`${warmup ? 'Warmup' : 'Pair'} ${pair}: ${order} completed`)
    }
    if (run.mountIds.size !== result.samples.length) throw new Error('frame mount URLs were not unique per sample')
    result.summary = summarize(result.samples, options.seed)
    result.completed = true
  } catch (error) {
    result.error = error.message
    result.failure = error.diagnostics ?? null
    process.exitCode = 1
  } finally {
    result.finishedAt = new Date().toISOString()
    await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    await rm(dir, { recursive: true, force: true })
  }
  return result
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (existsSync(options.out)) throw new Error(`${options.out} already exists; choose a new --out`)
    const result = await main(options)
    console.log(JSON.stringify({ completed: result.completed, error: result.error ?? null, summary: result.summary ?? null }, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
