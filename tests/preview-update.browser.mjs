import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { markRemoteImages } from '../lib/remote-image.ts'
import { CAPTURE_TIMING_HEADER } from '../lib/capture-protocol.ts'
import { DESIGN_CAPTURE_RELAY, designCaptureScript } from '../lib/design-capture.ts'
import { BLANK_IMAGE, DESIGN_ARTIFACT_EMBEDDED_CSP, MAX_EMBEDDED_IMAGE_BYTES, designFrameCsp, designFrameHtml, prepareDesignArtifactHtml, validateDesignArtifactHtml } from '../lib/design-artifact.ts'
import { LEGACY_BASELINE, OBSERVER, buildPaneFixture } from './helpers/preview-pane-fixture.mjs'

// Opt-in, like design-artifact.browser.mjs. Node 24 supplies WebSocket and TS stripping.
// One Chrome and sequential cases keep this suite from spawning a browser per assertion.
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const SESSION = 'preview-browser-session'
const TOKEN = 'preview-browser-ready'
// Opt-in experiment only (FX0_PREVIEW_PERF=1): it replaces the regular cases with a perf comparison.
const PERF = process.env.FX0_PREVIEW_PERF === '1'
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), middle = sorted.length >> 1
  return sorted.length === 0 ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function design({ color = 'rgb(10, 20, 30)', title = 'Original title', padding = 4, image = '', photo = false, program = 'original', structure = '', beforeLoad = '', sheetId = true } = {}) {
  return `<!doctype html><html><head><title>Interactive presentation</title>
<style${sheetId ? ' id="theme"' : ''}>body{margin:0;min-height:2600px}#title{color:${color}}#swatch{width:80px;height:80px;background-image:${image ? `url(https://fixture.invalid/${image})` : 'none'}}</style>
</head><body class="slide-1"><h1 id="title">${title}</h1>
<p id="inline" style="padding:${padding}px">Inline target</p><p id="runtime-label">Authored label</p>
<input id="input" value="authored"><button id="next">Next slide</button><div id="swatch"></div>
${photo ? '<img id="photo" alt="Local fixture" src="https://fixture.invalid/pixel.png">' : ''}${structure}
<script>
const instance = crypto.randomUUID(), program = ${JSON.stringify(program)}
const find = id => id === 'theme' ? document.querySelector('style') : document.getElementById(id)
const refs = Object.fromEntries(['title', 'inline', 'input', 'next', 'theme'].map(id => [id, find(id)]))
let clicks = 0
refs.next.addEventListener('click', () => { clicks++; document.body.className = 'slide-' + (4 + clicks) })
document.body.className = 'slide-4'
refs.input.value = 'typed at runtime'
document.getElementById('runtime-label').textContent = 'Runtime label'
const generated = document.createElement('p'); generated.id = 'generated'; generated.textContent = 'Generated at runtime'; document.body.append(generated)
${beforeLoad}
const send = data => top.postMessage({ fixture: 'preview-update', instance, program, ...data }, '*')
send({ kind: 'boot' })
addEventListener('error', event => send({ kind: 'error', error: event.message }))
addEventListener('unhandledrejection', event => send({ kind: 'error', error: String(event.reason) }))
const report = () => {
  const title = document.getElementById('title'), input = document.getElementById('input'), sheet = find('theme').sheet
  send({ kind: 'state', title: title.textContent, color: getComputedStyle(title).color,
    padding: getComputedStyle(document.getElementById('inline')).paddingTop, background: getComputedStyle(document.getElementById('swatch')).backgroundImage,
    className: document.body.className, input: input.value, focused: document.activeElement === input,
    selection: [input.selectionStart, input.selectionEnd], scroll: Math.round(scrollY), clicks,
    sameNodes: Object.entries(refs).every(([id, node]) => find(id) === node),
    runtimeLabel: document.getElementById('runtime-label').textContent, generated: !!document.getElementById('generated'),
    cssText: find('theme').textContent, rules: sheet.cssRules.length, disabled: sheet.disabled,
    photo: document.getElementById('photo')?.getAttribute('src') ?? null,
    photoDecoded: !!document.getElementById('photo')?.naturalWidth, added: !!document.getElementById('added'),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content })
}
addEventListener('load', report, { once: true })
setInterval(report, 60)
</script></body></html>`
}

function payload(revision, html, imageName) {
  const validated = validateDesignArtifactHtml(` \n${html}\n `, { remoteImages: true })
  assert.equal(validated.ok, true, validated.error)
  const marked = markRemoteImages(validated.html, randomBytes(16).toString('hex'), { remote: true })
  return {
    protocol: 1, sessionId: SESSION, revision, sourceHtml: validated.html, renderHtml: marked.html,
    images: marked.images.map(({ marker, url }) => ({ marker, src: `/api/artifact-image?name=${encodeURIComponent(imageName ?? new URL(url).pathname.slice(1))}&nonce=${randomBytes(8).toString('hex')}` })),
  }
}

const PARENT = `<!doctype html><html><head><title>Preview update browser test</title>
<style>html,body{margin:0}iframe{width:1000px;height:720px;border:0}</style></head><body><script>${OBSERVER}
window.mount = url => {
  document.getElementById('active')?.remove()
  observed.reports = []
  const frame = document.createElement('iframe'); frame.id = 'active'; frame.src = url; document.body.append(frame)
}
</script></body></html>`

async function until(read, label, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds
  let last
  do {
    last = await read()
    if (last) return last
    await sleep(40)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}; last observation: ${JSON.stringify(last)}`)
}

// Only the CDP primitives this file needs; no automation package or copied updater.
async function connectCdp(url, errors) {
  const socket = new WebSocket(url), pending = new Map(), contexts = new Map()
  let sequence = 0, iframeSession
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
    if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'iframe') {
      iframeSession = message.params.sessionId
      call('Runtime.enable', {}, iframeSession).catch(error => errors.push(error.message))
    }
    if (message.method === 'Target.detachedFromTarget' && iframeSession === message.params.sessionId) iframeSession = undefined
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params.context
      if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, { id: context.id, sessionId: message.sessionId })
    }
    if (message.method === 'Runtime.executionContextDestroyed' || message.method === 'Runtime.executionContextsCleared' || message.method === 'Target.detachedFromTarget') {
      for (const [frame, context] of contexts) {
        if (context.sessionId === (message.params?.sessionId ?? message.sessionId) &&
          (message.method !== 'Runtime.executionContextDestroyed' || context.id === message.params.executionContextId)) contexts.delete(frame)
      }
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Chrome CDP closed')) }
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome CDP connection timeout')) }, 8000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('Chrome CDP connection failed')) }, { once: true })
  })
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 12_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const evaluate = async (expression, depth = 0) => {
    let context
    if (depth === 2 && iframeSession) {
      context = await until(() => [...contexts.values()].find(c => c.sessionId === iframeSession), 'opaque iframe execution context')
    } else if (depth) {
      let { frameTree } = await call('Page.getFrameTree')
      for (let index = 0; index < depth; index++) frameTree = frameTree?.childFrames?.[0]
      assert.ok(frameTree, `Missing frame at depth ${depth}`)
      context = contexts.get(frameTree.frame.id)
      assert.ok(context, `Missing default execution context at depth ${depth}`)
    }
    const result = await call('Runtime.evaluate', { expression, ...(context ? { contextId: context.id } : {}), returnByValue: true, awaitPromise: true }, context?.sessionId)
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await call('Runtime.enable'); await call('Page.enable')
  await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  return { call, evaluate, close: async () => { socket.close(); await Promise.race([closed, sleep(1000, undefined, { ref: false })]) } }
}

test('in Chrome, the production preview wrapper and React PreviewPane preserve state, reload safely and recover', { timeout: PERF ? 200_000 : 180_000 }, async t => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const dir = await mkdtemp(join(tmpdir(), 'fx0-preview-update-'))
  const frames = new Map(), hits = new Map(), held = [], errors = []
  // Chrome decodes the valid PNG prefix; trailing bytes exercise embedding size,
  // not expensive pixel allocation. Three occurrences stay below the real budget.
  const largeImage = Buffer.alloc(Math.floor(1.1 * 1024 * 1024), 0x41)
  PIXEL.copy(largeImage)
  const paneArtifacts = new Map(), paneLatest = new Map(), paneModes = new Map(), paneRequests = [], paneHeld = [], paneHtmlHeld = [], bundleHeld = [], paneCaptures = []
  let paneFixture, holdBundle = true, artifactDelayMs = 0
  let origin, chrome, cdp, chromeError = '', frameNumber = 0, requestNumber = 0, offRouteHits = 0
  const sendFrame = (response, preview) => {
    const prepared = prepareDesignArtifactHtml(preview.renderHtml, DESIGN_ARTIFACT_EMBEDDED_CSP, TOKEN)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': designFrameCsp(`${origin}/api/artifact-image`) })
    response.end(designFrameHtml(prepared, TOKEN, preview.images, preview, { relay: DESIGN_CAPTURE_RELAY, script: designCaptureScript }))
  }
  // Model the frame-error response contract; the real route and its script are covered
  // independently in route-security.test.mjs, including the nonce and status handshake.
  const sendFrameError = (response, status) => {
    const nonce = randomBytes(16).toString('hex')
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'` })
    response.end(`<!doctype html><script nonce="${nonce}">const report=()=>parent.postMessage({type:'fx0-preview-error',protocol:1,status:${status}},location.origin);addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data?.type==='fx0-preview-status'&&event.data.protocol===1)report()});report()</script>`)
  }
  const route = (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/pane' && paneFixture) return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(paneFixture.html)
    if (url.pathname === '/bundle.js' && paneFixture) {
      if (holdBundle) return void bundleHeld.push(response)
      return response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(paneFixture.bundle)
    }
    if (url.pathname === '/api/capture') {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', async () => {
        const form = request.headers['content-type']?.startsWith('multipart/form-data')
          ? await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type'] } }).formData() : null
        paneCaptures.push({ cid: url.searchParams.get('cid'), failed: url.searchParams.get('failed'),
          images: form?.getAll('image').map(image => ({ type: image.type, size: image.size })) ?? [],
          timing: JSON.parse(request.headers[CAPTURE_TIMING_HEADER] ?? '{}') })
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
      return
    }
    if (url.pathname === '/api/artifact-frame') {
      const session = url.searchParams.get('session'), wanted = Number(url.searchParams.get('revision') ?? url.searchParams.get('v'))
      const revision = url.searchParams.has('revision') ? wanted : paneLatest.get(session)
      const preview = paneArtifacts.get(`${session}:${revision}`), json = url.searchParams.get('format') === 'json'
      paneRequests.push({ session, wanted, revision, json })
      const mode = paneModes.get(`${session}:${wanted}`)
      const staleFrame = !json && !url.searchParams.has('revision') && Number.isSafeInteger(wanted) && wanted > 0 && revision < wanted
      const failure = typeof mode === 'number' ? mode : mode === 'error' ? 503 : !preview || staleFrame ? 404 : null
      if (failure) {
        if (!json) return sendFrameError(response, failure)
        return response.writeHead(failure, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }).end('{"error":"Local failure"}')
      }
      if (!json) {
        if (mode === 'hold-html') return void paneHtmlHeld.push({ response, preview })
        return sendFrame(response, preview)
      }
      // Only the external snapshot/data source is simulated. JSON never mounts or
      // executes a candidate; the real React effect decides what to do with it.
      const text = JSON.stringify(preview)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store' })
      if (mode === 'hang') {
        response.flushHeaders(); response.write(text.slice(0, 32))
        const entry = { response, rest: text.slice(32), closed: false }; paneHeld.push(entry)
        response.on('close', () => { entry.closed = !response.writableEnded })
        return
      }
      return response.end(text)
    }
    if (url.pathname === '/api/artifact-image') {
      const name = url.searchParams.get('name')
      hits.set(name, (hits.get(name) ?? 0) + 1)
      if (name === 'missing.png') return response.writeHead(404).end()
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      if (name?.startsWith('large-')) return response.end(largeImage)
      if (name === 'hang.png') {
        response.flushHeaders(); response.write(PIXEL.subarray(0, 8))
        const entry = { response, closed: false }; held.push(entry)
        response.on('close', () => { entry.closed = true })
        return
      }
      return response.end(PIXEL)
    }
    if (frames.has(url.pathname)) return sendFrame(response, frames.get(url.pathname))
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(PARENT)
    if (url.pathname === '/not-an-image') { offRouteHits++; return response.end('must not be fetched') }
    response.writeHead(204).end()
  }
  // Perf-only synthetic latency: the artifact frame's HTML and JSON are delayed; every other route is immediate.
  const server = http.createServer((request, response) => {
    if (artifactDelayMs && new URL(request.url, 'http://fixture').pathname === '/api/artifact-frame') setTimeout(route, artifactDelayMs, request, response)
    else route(request, response)
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    origin = `http://127.0.0.1:${server.address().port}`
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let spawnError
    chrome.on('error', error => { spawnError = error })
    chrome.stderr.on('data', data => { chromeError = (chromeError + data).slice(-16_384) })
    const port = await until(async () => {
      if (spawnError) throw spawnError
      assert.equal(chrome.exitCode, null, chromeError)
      try { return (await readFile(join(dir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0] }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }, 'Chrome debugging port')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json()
    cdp = await connectCdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl, errors)
    await cdp.call('Page.bringToFront')
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.call('Page.navigate', { url: origin })
    await until(() => cdp.evaluate('typeof mount === "function"'), 'fixture parent')
    const evaluate = cdp.evaluate
    const observed = () => evaluate('observed')
    const state = () => evaluate('observed.reports.at(-1) ?? null')
    const waitState = predicate => until(async () => { const current = await state(); return current && predicate(current) && current }, 'design state report')
    const post = message => evaluate(`document.getElementById('active').contentWindow.postMessage(${JSON.stringify(message)}, location.origin)`)
    const interact = () => evaluate("{ const input = document.getElementById('input'); input.focus({ preventScroll: true }); input.setSelectionRange(2, 7); scrollTo(0, 900) }", 2)
    const mounted = async preview => {
      const path = `/frame-${++frameNumber}`; frames.set(path, preview)
      const count = (await observed()).paints.length
      await evaluate(`mount(${JSON.stringify(path)})`)
      await waitState(s => s.sameNodes && s.input === 'typed at runtime')
      await interact()
      await waitState(s => s.scroll === 900 && s.focused)
      assert.equal(await evaluate("document.querySelector('iframe').contentDocument.querySelector('iframe').contentDocument === null"), true, 'design keeps its opaque sandbox')
      return until(async () => (await observed()).paints.slice(count).find(p => p.protocol === 1 && p.sessionId === SESSION && p.revision === preview.revision && typeof p.documentId === 'string' && p.updateReady === true), `production paint + updater ready for revision ${preview.revision}`)
    }
    const start = async (paint, baseRevision, candidate) => {
      const requestId = `browser-request-${++requestNumber}`
      await post({ type: 'fx0-preview-update', protocol: 1, requestId, documentId: paint.documentId, baseRevision, payload: candidate })
      return requestId
    }
    const terminal = (requestId, milliseconds = 8000) => until(async () => (await observed()).results.find(result => result.requestId === requestId), `terminal result for ${requestId}`, milliseconds)
    const update = async (paint, baseRevision, candidate, expected = 'applied') => {
      const requestId = await start(paint, baseRevision, candidate), result = await terminal(requestId)
      assert.deepEqual({ type: result.type, protocol: result.protocol, requestId: result.requestId, documentId: result.documentId, sessionId: result.sessionId, revision: result.revision, status: result.status }, {
        type: 'fx0-preview-result', protocol: 1, requestId, documentId: paint.documentId, sessionId: SESSION, revision: candidate.revision, status: expected,
      }, JSON.stringify(result))
      if (expected !== 'applied') assert.equal(typeof result.reason, 'string')
      return result
    }
    const preserved = (before, after) => {
      for (const key of ['instance', 'program', 'input', 'focused', 'selection', 'scroll', 'className', 'clicks', 'runtimeLabel', 'generated', 'sameNodes']) assert.deepEqual(after[key], before[key], key)
      assert.equal(after.sameNodes, true)
    }
    const noErrors = async () => { assert.deepEqual(errors, []); assert.deepEqual((await observed()).errors, []) }

    // Perf-only (FX0_PREVIEW_PERF=1): first publish and one compatible hot update in the real
    // PreviewPane, for the baseline compile and the experimental candidate. Every duration is
    // read from this page's performance.now (or Date.now) clock; the host only waits, never times.
    // Mock excludes auth, Redis, model providers and generation; the delay is synthetic.
    if (PERF) {
      const J = JSON.stringify, fixtures = {}
      for (const [name, experiment] of [['baseline', LEGACY_BASELINE], ['candidate', null]]) {
        await mkdir(join(dir, name))
        fixtures[name] = await buildPaneFixture(join(dir, name), experiment)
      }
      holdBundle = false
      // Fetch the page, bundle and frames on every sample rather than from Chrome's HTTP cache.
      await cdp.call('Network.enable'); await cdp.call('Network.setCacheDisabled', { cacheDisabled: true })
      const frontSelector = '#preview-pane iframe[title="Design artifact preview"]:not([aria-hidden="true"])'
      const frontCount = () => evaluate("document.querySelectorAll('#preview-pane iframe').length")
      const paneState = () => evaluate(`(() => { const frame = document.querySelector(${J(frontSelector)}); return frame ? observed.reports.filter(s => s.mountUrl === frame.getAttribute('src')).at(-1) ?? null : null })()`)
      const waitPane = predicate => until(async () => { const current = await paneState(); return current && predicate(current) && current }, 'perf PreviewPane state')
      const publish = (session, revision, options) => {
        paneArtifacts.set(`${session}:${revision}`, { ...payload(revision, design(options)), sessionId: session })
        paneLatest.set(session, revision)
      }
      // The seeded session bootstraps real SSR and hydration; each sample then starts a new chat.
      publish(SESSION, 101, { title: 'Seed design' })
      const METRICS = ['publishToReadyMs', 'readyToCaptureDoneMs', 'publishToCaptureDoneMs', 'uploadLagMs', 'previewWaitMs', 'libraryMs', 'encodeMs', 'jsonDurationMs', 'htmlDurationMs', 'jsonRequests', 'htmlRequests']
      // One publish: the prop change, the screenshot request in the same turn, then ready and capture-done times.
      const phase = async (session, revision, options) => {
        const cid = `${session}-${revision}`, mark = paneRequests.length
        publish(session, revision, options)
        await evaluate(`{ window.frontBefore = document.querySelector(${J(frontSelector)}); window.captureUploads = []; performance.clearResourceTimings(); window.publishAt = performance.now(); setRevision(${revision}); setCapture({ cid: ${J(cid)}, revision: ${revision}, sessionId: ${J(session)}, receivedAt: Date.now() }) }`)
        // The first paint (no confirmed document) or the applied acknowledgement (hot update), whichever arrives.
        const ready = await until(() => evaluate(`[...observed.paints, ...observed.results].find(e => e.sessionId === ${J(session)} && e.revision === ${revision} && (e.type === 'fx0-preview-result' ? e.status === 'applied' : e.updateReady === true)) ?? null`), `${cid} ready`, 20_000)
        const captured = await until(() => evaluate(`captureResults.find(r => r.cid === ${J(cid)}) ?? null`), `${cid} capture done`, 20_000)
        const page = await evaluate(`({ publishAt: window.publishAt, sameFront: window.frontBefore != null && window.frontBefore === document.querySelector(${J(frontSelector)}), uploads: window.captureUploads.slice(),
          resources: performance.getEntriesByType('resource').filter(e => e.name.includes('/api/artifact-frame')).map(e => ({ kind: new URL(e.name).searchParams.has('format') ? 'json' : 'html', initiatorType: e.initiatorType, durationMs: e.duration, waitMs: e.responseStart - e.requestStart, transferMs: e.responseEnd - e.responseStart })) })`)
        const shot = paneCaptures.find(capture => capture.cid === cid)
        assert.ok(shot, `${cid} reached /api/capture`)
        assert.equal(shot.failed, null, `${cid} uploaded a photo`)
        assert.equal(shot.images.length, 1)
        assert.equal(captured.answered, true)
        const requests = paneRequests.slice(mark).filter(request => request.session === session), upload = page.uploads.at(-1)
        const resource = kind => page.resources.find(entry => entry.kind === kind)
        return {
          readyEvent: ready.type === 'fx0-preview-result' ? 'applied' : 'paint', documentId: ready.documentId ?? null, sameFront: page.sameFront,
          publishToReadyMs: ready.observedAt - page.publishAt, readyToCaptureDoneMs: captured.observedAt - ready.observedAt,
          publishToCaptureDoneMs: captured.observedAt - page.publishAt, uploadLagMs: upload ? upload.headersAt - upload.start : null,
          previewWaitMs: shot.timing.previewWaitMs, libraryMs: shot.timing.frame?.libraryMs ?? null, encodeMs: shot.timing.frame?.encodeMs ?? null,
          jsonDurationMs: resource('json')?.durationMs ?? null, htmlDurationMs: resource('html')?.durationMs ?? null,
          jsonRequests: requests.filter(request => request.json).length, htmlRequests: requests.filter(request => !request.json).length,
          requestOrder: requests.map(request => (request.json ? 'json' : 'html')), resources: page.resources,
        }
      }
      const sample = async (variant, delay, index) => {
        const session = `perf-${variant}-${delay}-${index}-${randomBytes(4).toString('hex')}`
        artifactDelayMs = delay
        paneFixture = fixtures[variant]
        await cdp.call('Page.navigate', { url: `${origin}/pane` })
        await until(() => evaluate('window.fixtureReady === true'), 'perf hydration', 20_000)
        await until(() => evaluate(`observed.paints.some(p => p.sessionId === ${J(SESSION)} && p.revision === 101 && p.updateReady === true)`), 'perf seeded SSR paint', 20_000)
        // Shadow the production fetch only to timestamp the capture upload's response headers.
        await evaluate(`{ window.captureUploads = []; const send = window.fetch; window.fetch = (input, init) => { const url = String(input?.url ?? input); if (!url.includes('/api/capture')) return send(input, init); const start = performance.now(); return send(input, init).then(response => { window.captureUploads.push({ start, headersAt: performance.now() }); return response }) } }`)
        // A new chat: no frame until its first publish, then a patch that keeps the same confirmed document.
        await evaluate(`setSession(${J(session)}); setRevision(0)`)
        await until(async () => await frontCount() === 0, 'perf new chat has no preview frame')
        const initial = await phase(session, 1, { title: 'Perf first design' })
        assert.deepEqual(initial.requestOrder, variant === 'baseline' ? ['json', 'html'] : ['html'], `${variant} initial artifact requests`)
        await interact()
        const before = await waitPane(s => s.scroll === 900 && s.focused), boots = (await observed()).boots.length
        const update = await phase(session, 2, { color: 'rgb(90, 80, 70)', title: 'Perf edited title', padding: 12 })
        preserved(before, await waitPane(s => s.title === 'Perf edited title' && s.color === 'rgb(90, 80, 70)' && s.padding === '12px'))
        assert.deepEqual(update.requestOrder, ['json'], `${variant} hot update requests JSON only`)
        assert.equal(update.documentId, initial.documentId, 'the hot update keeps the first document')
        assert.equal(update.sameFront, true, 'the front frame node is not replaced')
        assert.equal(await frontCount(), 1)
        assert.equal((await observed()).boots.length, boots, 'no document reload or script restart')
        return { variant, artifactDelayMs: delay, index, session, initial, update }
      }
      const samples = []
      for (const delay of [0, 150]) {
        for (let index = 0; index < 5; index++) {
          // Alternate the order so drift affects both variants alike.
          for (const variant of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) samples.push(await sample(variant, delay, index))
        }
      }
      artifactDelayMs = 0
      await noErrors()
      const cells = {}
      for (const sample of samples) {
        const cell = cells[`${sample.variant}@${sample.artifactDelayMs}ms`] ??= { n: 0, initial: {}, update: {} }
        cell.n++
        for (const phaseName of ['initial', 'update']) for (const metric of METRICS) (cell[phaseName][metric] ??= []).push(sample[phaseName][metric])
      }
      for (const cell of Object.values(cells)) for (const phaseName of ['initial', 'update']) for (const metric of METRICS) cell[phaseName][metric] = median(cell[phaseName][metric])
      const report = {
        kind: 'fx0-preview-perf', candidate: { id: 'first-load-html-only', status: 'current production source, local verification', baselineRemoves: LEGACY_BASELINE.from },
        chrome: (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(8000) })).json()).Browser, node: process.version,
        synthetic: { artifactFrameDelayMs: [0, 150], delayed: 'HTML and JSON of /api/artifact-frame', notMeasured: ['production auth', 'Redis', 'model provider', 'generation', 'real network'], uploadEndpoint: 'local mock /api/capture without storage' },
        clocks: 'Browser performance.now for ready and capture boundaries; Date.now for previewWait (same browser clock); upload lag from the browser fetch promise',
        samples, cells,
      }
      if (process.env.FX0_PREVIEW_PERF_OUT) await writeFile(process.env.FX0_PREVIEW_PERF_OUT, JSON.stringify(report, null, 2))
      console.log(`FX0_PREVIEW_PERF_RESULT ${JSON.stringify(report)}`)
      return
    }

    // Fail once, rather than running every case against a legacy three-argument wrapper.
    let paint = await mounted(payload(1, design({ photo: true })))

    await t.test('first patch uses the real initial baseline; CSS, inline style and text preserve interactive state', async () => {
      const before = await state(), boots = (await observed()).boots.length
      assert.equal(before.photo, `data:image/png;base64,${PIXEL.toString('base64')}`)
      assert.equal(before.photoDecoded, true)
      await update(paint, 1, payload(2, design({ photo: true, color: 'rgb(90, 80, 70)' })))
      preserved(before, await waitState(s => s.color === 'rgb(90, 80, 70)'))
      await update(paint, 2, payload(3, design({ photo: true, color: 'rgb(90, 80, 70)', title: 'Edited title', padding: 12 })))
      preserved(before, await waitState(s => s.title === 'Edited title' && s.padding === '12px'))
      // Fresh marker/descriptor nonces must not turn unchanged embedded images into a conflict.
      await update(paint, 3, payload(4, design({ photo: true, color: 'rgb(90, 80, 70)', title: 'Edited title', padding: 12 })))
      preserved(before, await state())
      await evaluate("document.getElementById('next').click()", 2)
      assert.equal((await waitState(s => s.clicks === 1)).className, 'slide-5', 'the original listener still fires exactly once')
      assert.equal((await observed()).boots.length, boots, 'no speculative candidate or script restart')
      await noErrors()
    })

    await t.test('script and structure edits request reload without executing a candidate; a real remount accepts its first patch', async () => {
      const boots = (await observed()).boots.length
      const candidate = payload(5, design({ photo: true, color: 'rgb(90, 80, 70)', title: 'Edited title', padding: 12, program: 'replacement' }))
      await update(paint, 4, candidate, 'reload')
      await sleep(150)
      assert.equal((await observed()).boots.length, boots)
      assert.equal((await state()).program, 'original')
      paint = await mounted(candidate)
      assert.equal((await state()).program, 'replacement')
      assert.equal((await observed()).boots.length, boots + 1)
      await update(paint, 5, payload(6, design({ photo: true, color: 'rgb(1, 2, 3)', title: 'After real reload', padding: 12, program: 'replacement' })))
      await waitState(s => s.title === 'After real reload' && s.color === 'rgb(1, 2, 3)')
      await update(paint, 6, payload(7, design({ photo: true, color: 'rgb(1, 2, 3)', title: 'After real reload', padding: 12, program: 'replacement', structure: '<aside id="added">New structure</aside>' })), 'reload')
      assert.equal((await state()).added, false)
      assert.equal((await observed()).boots.length, boots + 1)
      await noErrors()
    })

    await t.test('CSS updates preserve cached stylesheet references and unchanged neighboring rules, including id-less styles', async () => {
      for (const sheetId of [true, false]) {
        const options = { sheetId, beforeLoad: 'window.cachedSheet = refs.theme.sheet; window.cachedFirstRule = cachedSheet.cssRules[0]' }
        const current = await mounted(payload(200, design(options))), before = await state(), boots = (await observed()).boots.length
        await update(current, 200, payload(201, design({ ...options, color: 'rgb(90, 80, 70)' })))
        preserved(before, await waitState(s => s.color === 'rgb(90, 80, 70)'))
        assert.equal(await evaluate('cachedSheet === refs.theme.sheet', 2), true, 'authored code keeps its CSSStyleSheet reference')
        assert.equal(await evaluate('cachedFirstRule === cachedSheet.cssRules[0]', 2), true, 'an unchanged neighboring rule is not replaced')
        await update(current, 201, payload(202, design({ ...options, color: 'rgb(21, 32, 43)' })))
        preserved(before, await waitState(s => s.color === 'rgb(21, 32, 43)'))
        assert.equal(await evaluate('cachedSheet === refs.theme.sheet', 2), true, 'a second update keeps the same stylesheet')
        await evaluate('window.currentRules = [...cachedSheet.cssRules]', 2)
        const formatted = design({ ...options, color: 'rgb(21, 32, 43)' }).replace('body{margin:0;', '/* formatting only */body{margin:0;')
        await update(current, 202, payload(203, formatted))
        assert.equal(await evaluate('currentRules.every((rule, index) => cachedSheet.cssRules[index] === rule)', 2), true, 'canonical no-ops do not replace rule objects')
        await evaluate("cachedSheet.insertRule('#title { color: rgb(4, 5, 6) }', cachedSheet.cssRules.length)", 2)
        preserved(before, await waitState(s => s.color === 'rgb(4, 5, 6)'))
        const result = await update(current, 203, payload(204, design({ ...options, color: 'rgb(99, 88, 77)', title: 'Must not overwrite runtime CSS' })), 'reload')
        assert.match(result.reason, /stylesheet.*conflict/)
        assert.equal((await state()).title, before.title, 'a CSSOM conflict prevents unrelated text writes')
        assert.equal((await observed()).boots.length, boots)
      }
      await noErrors()
    })

    await t.test('disjoint CSS edits, insertions and deletions retain the untouched rule and its live declaration', async () => {
      for (const sheetId of [true, false]) {
        const options = { sheetId, beforeLoad: 'window.cachedSheet = refs.theme.sheet; window.cachedRule = [...cachedSheet.cssRules].find(rule => rule.selectorText === "#title"); refs.next.addEventListener("click", () => { cachedRule.style.opacity = "0.4" })' }
        const original = design(options)
        const changed = value => original.replace('min-height:2600px}', `min-height:2600px;background:rgb(${value},2,3)}`).replace('width:80px;', `width:${80 + value}px;`)
        const current = await mounted(payload(250, original)), before = await state(), boots = (await observed()).boots.length
        await update(current, 250, payload(251, changed(1)))
        assert.equal(await evaluate('[...cachedSheet.cssRules].includes(cachedRule)', 2), true, 'an untouched rule between two edited rules keeps its identity')
        await update(current, 251, payload(252, changed(2)))
        const inserted = changed(2).replace('#title{', '.unused-before{color:red}#title{').replace('#swatch{', '.unused-after{color:blue}#swatch{')
        await update(current, 252, payload(253, inserted))
        await update(current, 253, payload(254, changed(2)))
        assert.equal(await evaluate('cachedSheet === refs.theme.sheet && [...cachedSheet.cssRules].includes(cachedRule)', 2), true, 'separate insertions and deletions retain the cached sheet and rule')
        preserved(before, await state())
        await evaluate("document.getElementById('next').click()", 2)
        await waitState(s => s.clicks === 1)
        assert.equal(await evaluate('getComputedStyle(refs.title).opacity', 2), '0.4', 'the original handler still changes displayed CSS through its cached declaration')
        assert.equal((await observed()).boots.length, boots)
      }
      await noErrors()
    })

    await t.test('reordered or ambiguous shared rules reload before unrelated CSS, inline style or text is written', async () => {
      const original = design(), css = original.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1], rules = css.match(/[^}]+}/g)
      for (const [previous, next] of [
        [rules, [rules[1], rules[0], rules[2]]],
        [[rules[0], rules[1], rules[1], rules[2]], [rules[0].replace('margin:0', 'margin:1px'), rules[1], rules[1], rules[2].replace('width:80px', 'width:81px')]],
      ]) {
        const current = await mounted(payload(260, original.replace(css, previous.join('')))), before = await state()
        const candidate = original.replace(css, next.join('')).replace('>Original title</h1>', '>Must not write</h1>').replace('padding:4px', 'padding:12px')
        await update(current, 260, payload(261, candidate), 'reload')
        const after = await state()
        assert.equal(after.cssText, before.cssText)
        assert.equal(after.title, before.title)
        assert.equal(after.padding, before.padding)
        preserved(before, after)
      }
      await noErrors()
    })

    await t.test('changed grouping rules reload without detaching cached unchanged descendants', async () => {
      const options = { beforeLoad: 'window.cachedGroup = refs.theme.sheet.cssRules[0]; window.cachedRule = cachedGroup.cssRules[1]; refs.next.addEventListener("click", () => { cachedRule.style.opacity = "0.4" })' }
      const original = design(options).replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/, '$1@media (min-width:0px){$2}$3')
      const current = await mounted(payload(270, original)), before = await state(), boots = (await observed()).boots.length
      const formatted = original.replace('body{margin:0;', '/* formatting only */body{margin:0;')
      await update(current, 270, payload(271, formatted))
      assert.equal(await evaluate('cachedGroup === refs.theme.sheet.cssRules[0] && cachedRule === cachedGroup.cssRules[1]', 2), true, 'grouped canonical no-ops keep the entire rule tree')
      const candidate = formatted.replace('min-height:2600px}', 'min-height:2600px;background:red}').replace('width:80px;', 'width:81px;').replace('>Original title</h1>', '>Must not write</h1>').replace('padding:4px', 'padding:12px')
      await update(current, 271, payload(272, candidate), 'reload')
      const after = await state()
      assert.equal(after.cssText, before.cssText)
      assert.equal(after.title, before.title)
      assert.equal(after.padding, before.padding)
      preserved(before, after)
      await evaluate("document.getElementById('next').click()", 2)
      await waitState(s => s.clicks === 1)
      assert.equal(await evaluate('getComputedStyle(refs.title).opacity', 2), '0.4', 'a rejected group replacement leaves the original cached declaration live')
      assert.equal((await observed()).boots.length, boots)
      await noErrors()
    })

    await t.test('id-less stylesheet lookup distinguishes logical duplicates from stale physical text after an update', async () => {
      for (const duplicate of ['logical', 'physical']) {
        const options = { sheetId: false }, original = design(options), changed = design({ ...options, color: 'rgb(90, 80, 70)' })
        const current = await mounted(payload(210, original)), before = await state()
        await update(current, 210, payload(211, changed))
        await waitState(s => s.color === 'rgb(90, 80, 70)')
        const css = (duplicate === 'logical' ? changed : original).match(/<style>([\s\S]*?)<\/style>/)[1]
        await evaluate(`{ const extra = document.createElement('style'); extra.textContent = ${JSON.stringify(css)}; document.head.append(extra) }`, 2)
        const result = await update(current, 211, payload(212, design({ ...options, color: 'rgb(21, 32, 43)', title: 'Unambiguous update' })), duplicate === 'logical' ? 'reload' : 'applied')
        if (duplicate === 'logical') {
          assert.match(result.reason, /target/)
          assert.equal((await state()).title, before.title)
        } else {
          preserved(before, await waitState(s => s.title === 'Unambiguous update'))
          assert.equal(await evaluate("[...refs.theme.sheet.cssRules].some(rule => rule.cssText.includes('rgb(21, 32, 43)'))", 2), true)
        }
      }
      await noErrors()
    })

    await t.test('CSS preflight rejects imports and invalid namespace splices before any stylesheet or text write', async () => {
      const cases = [
        { before: '#other { color: red }', after: '@import "data:text/css,body{}"; #other { color: red }' },
        { before: '@namespace test "urn:old"; test|p { color: red }', after: '@namespace test "urn:new"; test|p { color: red }' },
      ]
      for (const { before: first, after: next } of cases) {
        const original = design({ structure: `<style id="secondary">${first}</style>` })
        const current = await mounted(payload(220, original)), before = await state()
        const candidate = design({ color: 'rgb(99, 88, 77)', title: 'Must not write', structure: `<style id="secondary">${next}</style>` })
        await update(current, 220, payload(221, candidate), 'reload')
        const after = await state()
        assert.equal(after.title, before.title)
        assert.equal(after.color, before.color)
        assert.equal(after.cssText, before.cssText)
        preserved(before, after)
      }
      await noErrors()
    })

    await t.test('runtime stylesheet changes before load and after a hot update remain conflicts', async () => {
      for (const mutation of ["refs.theme.sheet.insertRule('body { outline: 3px solid red }', refs.theme.sheet.cssRules.length)", "refs.theme.textContent += '\\n'"]) {
        const options = { beforeLoad: mutation }, current = await mounted(payload(230, design(options))), before = await state()
        await update(current, 230, payload(231, design({ ...options, color: 'rgb(99, 88, 77)', title: 'Must not write' })), 'reload')
        assert.equal((await state()).title, before.title)
        assert.equal((await state()).cssText, before.cssText)
      }
      const current = await mounted(payload(240, design()))
      await update(current, 240, payload(241, design({ color: 'rgb(90, 80, 70)' })))
      const before = await waitState(s => s.color === 'rgb(90, 80, 70)')
      await evaluate("refs.theme.textContent += '\\n'", 2)
      await update(current, 241, payload(242, design({ color: 'rgb(99, 88, 77)', title: 'Must not write' })), 'reload')
      assert.equal((await state()).title, before.title)
      await noErrors()
    })

    await t.test('a real hot update retains a fully embedded render past 2 MiB within the image budget', async largeTest => {
      const names = ['large-a.png', 'large-b.png', 'large-c.png']
      const options = {
        structure: names.map((name, index) => `<img id="large-${index}" alt="Large local image ${index}" src="https://fixture.invalid/${name}">`).join(''),
        beforeLoad: 'for (const image of document.images) refs[image.id] = image',
      }
      const initial = payload(8, design(options))
      assert.equal(initial.images.length, 3)
      assert.ok(Buffer.byteLength(initial.sourceHtml) < 16 * 1024, 'canonical HTML stays small; the wrapper must embed the large render')
      assert.ok(Buffer.byteLength(initial.renderHtml) < 16 * 1024)
      const expectedBytes = names.length * largeImage.length
      assert.ok(expectedBytes > 3 * 1024 * 1024 && expectedBytes <= MAX_EMBEDDED_IMAGE_BYTES)
      const expectedHash = createHash('sha256').update(`data:image/png;base64,${largeImage.toString('base64')}`).digest('hex')
      // Return only lengths, digests and decode state. Even failures must never dump
      // the multi-megabyte data URLs into TAP or the continuously polled reports.
      const resources = () => evaluate(`(async () => ({
        documentUrl: document.URL,
        bodyBytes: new TextEncoder().encode(document.body.outerHTML).length,
        images: await Promise.all([...document.images].map(async image => {
          const source = image.getAttribute('src'), data = source.slice(source.indexOf(',') + 1)
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))
          return { id: image.id, png: source.startsWith('data:image/png;base64,'),
            bytes: data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
            hash: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
            decoded: image.complete && image.naturalWidth === 1 && image.naturalHeight === 1 }
        }))
      }))()`, 2)
      const boots = (await observed()).boots.length
      const current = await mounted(initial)
      const before = await state(), embedded = await resources()
      assert.match(embedded.documentUrl, /^blob:/)
      assert.ok(embedded.bodyBytes > 2 * 1024 * 1024, 'the live embedded body, not just its bootstrap or raw source, exceeds 2 MiB')
      assert.deepEqual(embedded.images, names.map((_, index) => ({ id: `large-${index}`, png: true, bytes: largeImage.length, hash: expectedHash, decoded: true })))
      const embeddedBytes = embedded.images.reduce((total, image) => total + image.bytes, 0)
      assert.equal(embeddedBytes, expectedBytes)
      assert.ok(embeddedBytes <= MAX_EMBEDDED_IMAGE_BYTES)
      assert.equal((await observed()).boots.length, boots + 1)
      const mountUrl = await evaluate("document.getElementById('active').src")
      const candidate = payload(9, design({ ...options, color: 'rgb(71, 82, 93)', title: 'Large render hot update' }))
      assert.equal(candidate.images.length, 3)
      await update(current, 8, candidate)
      preserved(before, await waitState(s => s.title === 'Large render hot update' && s.color === 'rgb(71, 82, 93)'))
      const after = await resources()
      assert.equal(after.documentUrl, embedded.documentUrl)
      assert.ok(after.bodyBytes > 2 * 1024 * 1024)
      assert.deepEqual(after.images, embedded.images, 'all three decoded images and their complete embedded bytes are retained')
      assert.equal((await observed()).boots.length, boots + 1, 'the large candidate does not execute another iframe program')
      assert.equal(await evaluate("document.getElementById('active').src"), mountUrl)
      assert.equal(await evaluate("document.querySelectorAll('iframe').length"), 1)
      for (const name of names) assert.equal(hits.get(name), 2, `${name}: initial preparation and hot preparation both use the real image route`)
      largeTest.diagnostic(`embedded image bytes=${embeddedBytes}/${MAX_EMBEDDED_IMAGE_BYTES}; live body bytes=${after.bodyBytes}`)
      await noErrors()
    })

    await t.test('CSSOM rules and disabled sheets conflict before any patch writes', async () => {
      for (const mutation of ["sheet.insertRule('body { outline: 3px solid red }', sheet.cssRules.length)", 'sheet.disabled = true']) {
        const current = await mounted(payload(10, design()))
        await evaluate(`{ const sheet = document.getElementById('theme').sheet; ${mutation} }`, 2)
        const before = await waitState(s => mutation.includes('disabled') ? s.disabled : s.rules === 4)
        const result = await update(current, 10, payload(11, design({ color: 'rgb(99, 88, 77)', title: 'Must not write' })), 'reload')
        assert.match(result.reason, /stylesheet.*conflict/)
        await sleep(100)
        const after = await state()
        assert.equal(after.title, before.title, 'all operations are preflighted before writing')
        assert.equal(after.cssText, before.cssText)
        assert.equal(after.rules, before.rules)
        assert.equal(after.disabled, before.disabled, 'hot update must not re-enable a disabled sheet')
        preserved(before, after)
      }
      await noErrors()
    })

    await t.test('a target changed before load is not adopted as the authored baseline', async () => {
      const options = { beforeLoad: "refs.title.textContent = 'Changed before load'" }
      const current = await mounted(payload(20, design(options))), before = await state()
      assert.equal(before.title, 'Changed before load')
      const result = await update(current, 20, payload(21, design({ ...options, title: 'Candidate title', color: 'rgb(99, 88, 77)' })), 'reload')
      assert.match(result.reason, /text.*conflict/)
      await sleep(100)
      const after = await state()
      assert.equal(after.title, before.title)
      assert.equal(after.cssText, before.cssText, 'a later text conflict prevents even an earlier CSS operation')
      preserved(before, after)
      await noErrors()
    })

    await t.test('incidental embedded image differences require reload even when authored images are unchanged', async () => {
      const current = await mounted(payload(30, design({ photo: true }))), before = await state()
      await update(current, 30, payload(31, design({ photo: true, color: 'rgb(99, 88, 77)' }), 'missing.png'), 'reload')
      await sleep(100)
      const after = await state()
      assert.equal(after.photo, before.photo)
      assert.equal(after.cssText, before.cssText)
      preserved(before, after)
      await noErrors()
    })

    await t.test('an initially image-free wrapper embeds a later CSS image using only its permitted endpoint', async () => {
      const current = await mounted(payload(40, design())), before = await state(), requests = hits.get('pixel.png') ?? 0
      await update(current, 40, payload(41, design({ image: 'pixel.png' })))
      const after = await waitState(s => s.background.includes('data:image/png;base64,'))
      preserved(before, after)
      assert.equal(hits.get('pixel.png'), requests + 1)
      assert.match(after.csp, /connect-src 'none'/)
      assert.match(after.csp, /img-src data:/)
      assert.equal(await evaluate("fetch('/not-an-image').then(() => false, () => true)", 1), true, 'wrapper connect-src is path-only, not the whole origin')
      assert.equal(offRouteHits, 0)
      assert.equal(await evaluate(`fetch(${JSON.stringify(`${origin}/api/artifact-image?name=forbidden.png`)}).then(() => false, () => true)`, 2), true, 'opaque child cannot fetch even the allowed wrapper endpoint')
      assert.equal(hits.get('forbidden.png') ?? 0, 0)
      await noErrors()
    })

    await t.test('wrong source, protocol, session and document messages are ignored, not used to fetch or mutate', async () => {
      const current = await mounted(payload(50, design())), before = await state(), results = (await observed()).results.length
      const candidate = payload(51, design({ image: 'forbidden.png' }))
      const message = { type: 'fx0-preview-update', protocol: 1, requestId: 'untrusted-source', documentId: current.documentId, baseRevision: 50, payload: candidate }
      await evaluate(`postMessage(${JSON.stringify(message)}, location.origin)`, 1)
      await evaluate(`parent.postMessage(${JSON.stringify(message)}, '*')`, 2)
      await post({ ...message, requestId: 'wrong-protocol', protocol: 2 })
      await post({ ...message, requestId: 'wrong-document', documentId: 'not-the-live-document' })
      await post({ ...message, requestId: 'wrong-session', payload: { ...candidate, sessionId: 'other-session' } })
      await post({ type: 'fx0-preview-result', protocol: 1, requestId: 'forged-ack', documentId: current.documentId, sessionId: SESSION, revision: 51, status: 'applied' })
      await sleep(350)
      assert.equal((await observed()).results.length, results)
      assert.equal(hits.get('forbidden.png') ?? 0, 0)
      preserved(before, await state())
      await update(current, 50, payload(52, design({ title: 'Authenticated patch' })))
      await waitState(s => s.title === 'Authenticated patch')
      await noErrors()
    })

    await t.test('a hung image body hits the ten-second preparation deadline; late completion cannot replace the newest patch', async () => {
      const current = await mounted(payload(60, design())), before = await state(), count = held.length
      const began = Date.now(), requestId = await start(current, 60, payload(61, design({ image: 'hang.png' })))
      await until(() => held.length === count + 1, 'hung body request received')
      const result = await terminal(requestId, 15_000)
      assert.equal(result.status, 'applied', JSON.stringify(result))
      assert.equal(result.revision, 61); assert.equal(result.protocol, 1)
      assert.equal(result.documentId, current.documentId); assert.equal(result.sessionId, SESSION)
      assert.ok(Date.now() - began >= 9000, 'deadline includes reading the response body, not just headers')
      const placeholder = await waitState(s => s.background.includes(BLANK_IMAGE))
      preserved(before, placeholder)
      await until(() => held[count].closed, 'timed-out image reader/request aborted')
      await update(current, 61, payload(62, design({ image: 'pixel.png', title: 'Newest after timeout' })))
      const newest = await waitState(s => s.title === 'Newest after timeout' && s.background.includes('data:image/png;base64,'))
      held[count].response.end(PIXEL.subarray(8))
      await sleep(250)
      const after = await state()
      assert.equal(after.title, newest.title); assert.equal(after.background, newest.background)
      preserved(before, after)
      assert.equal((await observed()).results.filter(r => r.requestId === requestId).length, 1)
      await noErrors()
    })

    await t.test('canceling preparation returns one terminal error; a newer revision wins over late image data', async () => {
      const current = await mounted(payload(70, design())), before = await state(), count = held.length
      const requestId = await start(current, 70, payload(71, design({ image: 'hang.png', title: 'Canceled candidate' })))
      await until(() => held.length === count + 1, 'cancelable hung image request')
      await post({ type: 'fx0-preview-cancel', protocol: 1, requestId, documentId: current.documentId })
      const result = await terminal(requestId)
      assert.equal(result.status, 'error', JSON.stringify(result)); assert.equal(result.revision, 71)
      assert.equal(result.protocol, 1); assert.equal(result.documentId, current.documentId); assert.equal(result.sessionId, SESSION)
      assert.match(result.reason, /cancel/i)
      await until(() => held[count].closed, 'canceled image reader/request aborted')
      await update(current, 70, payload(72, design({ title: 'Newest after cancel', color: 'rgb(3, 4, 5)' })))
      await waitState(s => s.title === 'Newest after cancel')
      held[count].response.end(PIXEL.subarray(8))
      await sleep(250)
      const after = await state()
      assert.equal(after.title, 'Newest after cancel'); assert.equal(after.background, 'none')
      preserved(before, after)
      assert.equal((await observed()).results.filter(r => r.requestId === requestId).length, 1)
      await noErrors()
    })

    await t.test('watchdog recovery uses the last confirmed snapshot and new document identity, then accepts its first patch', async () => {
      const current = await mounted(payload(80, design()))
      await update(current, 80, payload(81, design({ title: 'Confirmed recovery snapshot', color: 'rgb(8, 9, 10)' })))
      await waitState(s => s.title === 'Confirmed recovery snapshot')
      const before = await observed(), oldInstance = (await state()).instance
      // Real self-navigation loses the bootstrap/heartbeat. The wrapper, not the test,
      // must recreate the confirmed document and install its fresh seed internally.
      await evaluate("location.replace('about:blank')", 2)
      const recovered = await until(async () => (await observed()).paints.slice(before.paints.length).find(p => p.protocol === 1 && p.sessionId === SESSION && p.revision === 81 && p.documentId !== current.documentId && p.updateReady), 'watchdog recovery paint')
      await interact()
      const restored = await waitState(s => s.instance !== oldInstance && s.title === 'Confirmed recovery snapshot' && s.scroll === 900)
      assert.equal(restored.color, 'rgb(8, 9, 10)')
      assert.equal((await observed()).boots.length, before.boots.length + 1)
      const results = (await observed()).results.length
      await start(current, 81, payload(82, design({ image: 'forbidden.png' })))
      await post({ type: 'fx0-preview-cancel', protocol: 1, requestId: 'stale-cancel', documentId: current.documentId })
      await sleep(250)
      assert.equal((await observed()).results.length, results, 'the same WindowProxy cannot revive old document IDs')
      assert.equal(hits.get('forbidden.png') ?? 0, 0)
      await update(recovered, 81, payload(83, design({ title: 'First patch after recovery', color: 'rgb(11, 12, 13)' })))
      const after = await waitState(s => s.title === 'First patch after recovery' && s.color === 'rgb(11, 12, 13)')
      preserved(restored, after)
      assert.equal((await observed()).boots.length, before.boots.length + 1)
      await noErrors()
    })
    await noErrors()

    await t.test('the real React PreviewPane hydrates, hot-updates, reloads, times out, retries and clears private scopes', async () => {
      paneFixture = await buildPaneFixture(dir)
      const publish = (revision, options = {}, sessionId = SESSION) => {
        const candidate = { ...payload(revision, design(options)), sessionId }
        paneArtifacts.set(`${sessionId}:${revision}`, candidate); paneLatest.set(sessionId, revision)
      }
      const frontSelector = '#preview-pane iframe[title="Design artifact preview"]:not([aria-hidden="true"])'
      const paneState = () => evaluate(`(() => { const frame = document.querySelector(${JSON.stringify(frontSelector)}); return frame ? observed.reports.filter(s => s.mountUrl === frame.getAttribute('src')).at(-1) ?? null : null })()`)
      const waitPane = predicate => until(async () => { const current = await paneState(); return current && predicate(current) && current }, 'visible React PreviewPane state')
      const applied = revision => until(async () => (await observed()).results.find(r => r.status === 'applied' && r.protocol === 1 && r.revision === revision), `React-coordinated applied revision ${revision}`)
      const painted = revision => until(async () => (await observed()).paints.find(p => p.protocol === 1 && p.revision === revision && p.updateReady), `React-coordinated painted revision ${revision}`)
      const iframeCount = () => evaluate("document.querySelectorAll('#preview-pane iframe').length")
      const status = () => evaluate("document.querySelector('#preview-pane [role=status]')?.textContent ?? ''")
      const htmlCount = () => paneRequests.filter(r => !r.json).length
      const askCapture = (cid, revision, sessionId = SESSION) => evaluate(`setCapture({ cid: ${JSON.stringify(cid)}, revision: ${revision}, sessionId: ${JSON.stringify(sessionId)}, receivedAt: Date.now() })`)
      const captureResult = cid => until(() => evaluate(`captureResults.find(result => result.cid === ${JSON.stringify(cid)})`), `capture result ${cid}`)
      try {
        publish(101)
        await cdp.call('Page.navigate', { url: `${origin}/pane` })
        await painted(101)
        await waitPane(s => s.title === 'Original title')
        const ssr = await observed(), initialHtmlCount = htmlCount()
        assert.equal(ssr.boots.length, 1)
        assert.equal(initialHtmlCount, 1)
        assert.equal(await evaluate('typeof setRevision'), 'undefined', 'SSR iframe paints before the hydration bundle is released')
        await evaluate(`void (window.initialPaneFrame = document.querySelector(${JSON.stringify(frontSelector)}))`)
        holdBundle = false
        for (const response of bundleHeld.splice(0)) response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(paneFixture.bundle)
        await until(() => evaluate('window.fixtureReady === true'), 'real React hydration effects')
        await until(async () => (await observed()).paints.length > ssr.paints.length, 'status handshake replays an already-painted SSR document')
        assert.equal(htmlCount(), initialHtmlCount, 'hydration adopts the SSR load instead of starting another document')
        assert.equal((await observed()).boots.length, 1)
        await interact()
        const before = await waitPane(s => s.scroll === 900 && s.focused)
        const initialSrc = await evaluate('initialPaneFrame.getAttribute("src")')
        const initialPaint = (await painted(101)).documentId

        // The server can already be ahead of the journal event. The next patch must
        // use that actual applied revision, not the event's requested revision.
        publish(103, { color: 'rgb(30, 40, 50)', title: 'Server already at 103' })
        await evaluate("setDraft('<!doctype html><html><head></head><body><p>Unpublished draft</p></body></html>'); setRevision(102)")
        assert.equal((await applied(103)).documentId, initialPaint)
        preserved(before, await waitPane(s => s.title === 'Server already at 103' && s.color === 'rgb(30, 40, 50)'))
        // Delay the real renderer, not its pixels: a publish in this window must wait
        // until the screenshot is fixed, rather than relabeling revision 104 as 103.
        await evaluate(`{
          const library = FastHtmlToImage
          FastHtmlToImage = { ...library, captureRegion: async (...args) => {
            window.capturePaused = true
            await new Promise(resolve => { window.releasePhoto = resolve })
            FastHtmlToImage = library
            return library.captureRegion(...args)
          } }
        }`, 2)
        await askCapture('applied-103', 103)
        await until(() => evaluate('window.capturePaused === true', 2), 'real screenshot paused before rendering')
        publish(104, { color: 'rgb(60, 70, 80)', title: 'Next patch after actual revision', padding: 12 })
        await evaluate('setRevision(104)')
        await sleep(150)
        assert.equal((await paneState()).title, 'Server already at 103', 'hot application waits for the in-flight photo')
        assert.equal(paneRequests.some(request => request.wanted === 104), false, 'the new revision remains queued during capture')
        await evaluate('releasePhoto()', 2)
        assert.equal((await captureResult('applied-103')).answered, true)
        const photo = paneCaptures.find(capture => capture.cid === 'applied-103')
        assert.equal(photo?.failed, null, 'the applied revision is capturable even while its mount URL and requested revision are older')
        assert.equal(photo?.timing.path, 'preview')
        assert.equal(photo?.images.length, 1)
        assert.ok(photo.images[0].type.startsWith('image/') && photo.images[0].size > 0, 'the real capture handler uploads image bytes')
        preserved(before, await paneState())
        assert.equal((await applied(104)).documentId, initialPaint)
        preserved(before, await waitPane(s => s.title === 'Next patch after actual revision' && s.padding === '12px' && s.color === 'rgb(60, 70, 80)'))
        assert.equal(await evaluate('initialPaneFrame === document.querySelector(' + JSON.stringify(frontSelector) + ')'), true)
        assert.equal(await evaluate('initialPaneFrame.getAttribute("src")'), initialSrc)
        assert.equal(htmlCount(), initialHtmlCount, 'compatible effects never navigate src or execute a candidate frame')
        assert.equal((await observed()).boots.length, 1)
        assert.equal(await iframeCount(), 1, 'a draft cannot cover the published interactive design')
        await askCapture('stale-mount-101', 101)
        assert.equal((await captureResult('stale-mount-101')).answered, false, 'the original mount URL cannot label the patched document as the old revision')
        assert.equal(paneCaptures.some(capture => capture.cid === 'stale-mount-101'), false)
        const requestsBeforeOldEvent = paneRequests.length
        await evaluate('setDraft(null); setRevision(103)')
        await sleep(150)
        assert.equal(paneRequests.length, requestsBeforeOldEvent, 'an old journal event does not roll the preview back')
        await evaluate("document.getElementById('next').click()", 2)
        assert.equal((await waitPane(s => s.clicks === 1)).className, 'slide-5')

        // An incompatible program is executed only by the real second-slot HTML
        // load, once. Then a compatible patch must use that new document's baseline.
        publish(105, { program: 'react replacement', title: 'Reloaded through React' })
        await evaluate('setRevision(105)')
        const reloadedPaint = await painted(105)
        await waitPane(s => s.program === 'react replacement' && s.title === 'Reloaded through React')
        await until(async () => await iframeCount() === 1, 'old double-buffer slot removed')
        assert.notEqual(reloadedPaint.documentId, initialPaint)
        assert.equal((await observed()).results.filter(r => r.revision === 105 && r.status === 'reload').length, 1)
        assert.equal(htmlCount(), initialHtmlCount + 1)
        assert.equal((await observed()).boots.length, 2, 'no speculative candidate execution or duplicate reload')
        assert.equal(await evaluate('initialPaneFrame.isConnected'), false)
        await evaluate(`void (window.reloadedPaneFrame = document.querySelector(${JSON.stringify(frontSelector)}))`)
        await interact()
        const reloaded = await waitPane(s => s.scroll === 900 && s.focused)
        publish(106, { program: 'react replacement', title: 'First patch after React reload', padding: 8 })
        await evaluate('setRevision(106)')
        assert.equal((await applied(106)).documentId, reloadedPaint.documentId)
        preserved(reloaded, await waitPane(s => s.title === 'First patch after React reload' && s.padding === '8px'))
        assert.equal((await observed()).boots.length, 2)

        const confirmed = await paneState(), htmlBeforeStall = htmlCount(), heldCount = paneHeld.length
        publish(107, { program: 'react replacement', title: 'Must not apply a partial JSON body' })
        paneModes.set(`${SESSION}:107`, 'hang')
        const began = Date.now()
        await evaluate('setRevision(107)')
        await until(() => paneHeld.length === heldCount + 1, 'React JSON acquisition reaches the stalled body')
        await until(async () => (await status()).includes('timed out'), 'React ten-second body deadline', 15_000)
        assert.ok(Date.now() - began >= 9000, 'acquisition deadline covers the body, not just response headers')
        await until(() => paneHeld[heldCount].closed, 'React aborts the stalled response reader')
        preserved(confirmed, await paneState())
        assert.equal((await paneState()).title, confirmed.title)
        assert.equal(htmlCount(), htmlBeforeStall, 'acquisition timeout retains the confirmed document without an automatic reload')
        assert.equal((await observed()).boots.length, 2)
        assert.equal(paneRequests.filter(r => r.wanted === 107).length, 1, 'no automatic request loop')
        publish(108, { program: 'react replacement', title: 'Retry gets the actual latest revision', padding: 10 })
        paneModes.delete(`${SESSION}:107`)
        await evaluate("[...document.querySelectorAll('#preview-pane button')].find(button => button.textContent === 'Retry preview').click()")
        assert.equal((await applied(108)).documentId, reloadedPaint.documentId)
        const newest = await waitPane(s => s.title === 'Retry gets the actual latest revision' && s.padding === '10px')
        assert.equal(await status(), '')
        assert.equal(await evaluate('reloadedPaneFrame === document.querySelector(' + JSON.stringify(frontSelector) + ')'), true)
        paneHeld[heldCount].response.end(paneHeld[heldCount].rest)
        await sleep(200)
        assert.equal((await paneState()).title, newest.title, 'late partial-body completion cannot roll back the retry')
        assert.equal((await observed()).results.some(r => r.revision === 107), false)

        // A real history/scope change must cancel acquisition. Returning to latest
        // is an explicit document load, not an attempt to patch the historical one.
        publish(110, { program: 'never execute canceled JSON', title: 'Canceled navigation candidate' })
        paneModes.set(`${SESSION}:110`, 'hang')
        const navigationHeld = paneHeld.length
        await evaluate('setRevision(110)')
        await until(() => paneHeld.length === navigationHeld + 1, 'navigation races a JSON acquisition')
        await evaluate('setViewing(101)')
        await painted(101)
        await waitPane(s => s.program === 'original' && s.title === 'Original title' && s.instance !== before.instance)
        await until(() => paneHeld[navigationHeld].closed, 'history navigation aborts the old acquisition')
        paneModes.delete(`${SESSION}:110`)
        await until(async () => await iframeCount() === 1, 'history owns one confirmed slot')
        assert.equal(await evaluate(`new URL(document.querySelector(${JSON.stringify(frontSelector)}).src).searchParams.get('revision')`), '101')
        assert.ok(paneRequests.some(r => !r.json && r.wanted === 101 && r.revision === 101))
        publish(111, { program: 'latest after history', title: 'Returned to latest' })
        await evaluate('setViewing(null)')
        await painted(111)
        await waitPane(s => s.program === 'latest after history' && s.title === 'Returned to latest')
        paneHeld[navigationHeld].response.end(paneHeld[navigationHeld].rest)
        await sleep(200)
        assert.equal((await observed()).boots.some(b => b.program === 'never execute canceled JSON'), false)
        assert.equal((await paneState()).title, 'Returned to latest')

        const otherSession = 'other-preview-browser-session'
        publish(1, { program: 'other private session', title: 'Other private design' }, otherSession)
        await evaluate(`setSession(${JSON.stringify(otherSession)}); setRevision(1)`)
        await waitPane(s => s.program === 'other private session' && s.title === 'Other private design')
        await until(async () => await iframeCount() === 1, 'new session replaces the old scope')
        assert.deepEqual(paneRequests.filter(r => r.session === otherSession && r.wanted === 1).map(r => r.json ? 'json' : 'html'), ['html'], 'a first load goes straight to HTML')
        assert.equal(await evaluate(`new URL(document.querySelector(${JSON.stringify(frontSelector)}).src).searchParams.get('session')`), otherSession)
        // Revocation must remove *all* private layers, not reveal a draft that had
        // been correctly hidden behind the published design or retain its link dialog.
        await evaluate("setDraft('<!doctype html><html><head></head><body><p>Private retained draft</p></body></html>')")
        assert.equal(await iframeCount(), 1)
        await evaluate("parent.postMessage({type:'fx0-artifact-open',url:'https://example.com/private-design-link'},location.origin)", 1)
        await until(() => evaluate("!!document.querySelector('[role=dialog]')"), 'private design link confirmation')
        const requestsBeforeZero = paneRequests.length
        await evaluate("window.dispatchEvent(new CustomEvent('fx0:auth-required',{detail:401}))")
        await until(async () => await iframeCount() === 0, 'revocation removes both published and draft iframes')
        await until(() => evaluate("!document.querySelector('[role=dialog]')"), 'revocation closes the private design link')
        await sleep(200)
        assert.equal(paneRequests.length, requestsBeforeZero)
        assert.equal(await status(), '')
        assert.equal(await iframeCount(), 0, 'a retained draft or late result cannot revive the private scope')
        await askCapture('revoked-scope', 1, otherSession)
        assert.equal((await captureResult('revoked-scope')).answered, false, 'revoked access never photographs a retained private frame')
        assert.equal(paneCaptures.some(capture => capture.cid === 'revoked-scope'), false)
        // Revision zero still supports a legitimate authorized first-generation draft.
        await evaluate("setAccessAllowed(true);setDraft('<!doctype html><html><head></head><body><p>Authorized first draft</p></body></html>')")
        await until(() => evaluate("!!document.querySelector('iframe[title=\"Design preview while generating\"]')"), 'authorized first-generation draft remains supported')
        await evaluate('setDraft(null)')

        // With no confirmed document, an initial HTML failure is recoverable via
        // the component's own Retry button, without a JSON preflight.
        publish(2, { program: 'initial retry', title: 'Initial failure recovered' }, otherSession)
        paneModes.set(`${otherSession}:2`, 'error')
        const htmlBeforeInitialError = htmlCount(), bootsBeforeInitialError = (await observed()).boots.length
        await evaluate('setRevision(2)')
        await until(async () => (await status()).includes('could not be loaded'), 'initial acquisition error')
        assert.equal(await iframeCount(), 0)
        assert.equal(htmlCount(), htmlBeforeInitialError + 1)
        paneModes.delete(`${otherSession}:2`)
        await evaluate("[...document.querySelectorAll('#preview-pane button')].find(button => button.textContent === 'Retry preview').click()")
        await waitPane(s => s.program === 'initial retry' && s.title === 'Initial failure recovered')
        assert.equal(htmlCount(), htmlBeforeInitialError + 2)
        assert.equal((await observed()).boots.length, bootsBeforeInitialError + 1)
        assert.equal(paneRequests.filter(r => r.session === otherSession && r.wanted === 2 && r.json).length, 0)
        assert.equal(await status(), '')
        await noErrors()
      } catch (error) {
        t.diagnostic(`React fixture failure: ${error.stack}; browser errors: ${JSON.stringify(errors)}`)
        t.diagnostic(`React fixture requests: ${JSON.stringify(paneRequests)}`)
        t.diagnostic(`React fixture observation: ${JSON.stringify(await evaluate('({ ...observed, reports: observed.reports.slice(-1) })'))}`)
        throw error
      } finally {
        holdBundle = false
        for (const response of bundleHeld.splice(0)) response.destroy()
        for (const { response } of paneHeld) response.destroy()
      }
    })

    for (const firstLoad of ['client', 'pre-hydration SSR']) {
      for (const code of [401, 403, 404, 422, 503]) {
        await t.test(`${firstLoad} HTML ${code} reports errors without a JSON preflight`, async () => {
          paneFixture ??= await buildPaneFixture(dir)
          const session = firstLoad === 'client' ? `first-load-${code}` : SESSION
          const revision = firstLoad === 'client' ? 1 : 101
          const key = `${session}:${revision}`
          paneArtifacts.set(`${SESSION}:101`, payload(101, design({ program: 'error baseline' })))
          paneLatest.set(SESSION, 101)
          paneArtifacts.set(key, payload(revision, design({ program: `recovered ${code}` }), session))
          paneLatest.set(session, revision)
          if (firstLoad !== 'client') paneModes.set(key, code)
          const start = paneRequests.length
          const countFrames = () => evaluate("document.querySelectorAll('#preview-pane iframe').length")
          const status = () => evaluate("document.querySelector('#preview-pane [role=status]')?.textContent ?? ''")
          try {
            holdBundle = firstLoad !== 'client'
            await cdp.call('Page.navigate', { url: `${origin}/pane` })
            if (holdBundle) {
              await until(async () => (await observed()).frameErrors.some(error => error.status === code), 'SSR error arrived before hydration')
              assert.equal(await evaluate('window.fixtureReady === true'), false)
              holdBundle = false
              for (const response of bundleHeld.splice(0)) response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(paneFixture.bundle)
            }
            await until(() => evaluate('window.fixtureReady === true'), 'error fixture hydration')
            if (firstLoad === 'client') {
              await until(async () => (await observed()).paints.some(paint => paint.revision === 101), 'healthy bootstrap before a new scope')
              paneModes.set(key, code)
              await evaluate(`setSession(${JSON.stringify(session)}); setRevision(${revision})`)
            }
            if (code === 401 || code === 403) {
              await until(() => evaluate(`window.authErrors.includes(${code})`), 'frame error closes the shared auth gate')
              assert.deepEqual(await evaluate('window.authErrors'), [code], 'status replies cannot dispatch duplicate auth errors')
            } else {
              await until(async () => (await status()).includes(code === 404 ? 'not available' : 'could not be loaded'), 'frame error is immediately retryable')
            }
            await until(async () => await countFrames() === 0, 'failed and revoked private frames are removed')
            const requests = () => paneRequests.slice(start).filter(request => request.session === session && request.wanted === revision)
            assert.deepEqual(requests().map(request => request.json ? 'json' : 'html'), ['html'])
            if (code === 401 || code === 403) {
              await sleep(50)
              assert.equal(await countFrames(), 0, 'late frame replies do not revive revoked access')
              assert.equal(requests().length, 1)
            } else {
              paneModes.delete(key)
              await evaluate("[...document.querySelectorAll('#preview-pane button')].find(button => button.textContent === 'Retry preview').click()")
              await until(async () => (await observed()).boots.some(boot => boot.program === `recovered ${code}`), 'Retry loads the corrected response')
              await until(async () => await countFrames() === 1 && await status() === '', 'Retry confirms one healthy frame')
              assert.deepEqual(requests().map(request => request.json ? 'json' : 'html'), ['html', 'html'])
            }
            await noErrors()
          } finally {
            paneModes.delete(key)
            holdBundle = false
            for (const response of bundleHeld.splice(0)) response.destroy()
          }
        })
      }
    }

    await t.test('a closed client auth gate blocks the first HTML request even when access props are stale', async () => {
      paneFixture ??= await buildPaneFixture(dir)
      paneArtifacts.set(`${SESSION}:101`, payload(101, design({ program: 'auth gate baseline' })))
      paneLatest.set(SESSION, 101)
      const session = 'auth-gate-must-not-load'
      paneArtifacts.set(`${session}:1`, payload(1, design({ program: 'must not bypass client auth gate' }), session))
      paneLatest.set(session, 1) // The external backend would return 200 if incorrectly requested.
      await cdp.call('Page.navigate', { url: `${origin}/pane` })
      await until(() => evaluate('window.fixtureReady === true'), 'closed-gate fixture hydration')
      await until(async () => (await observed()).paints.some(paint => paint.revision === 101), 'closed-gate fixture bootstrap')
      await evaluate('closeAuthGate(401)')
      await until(() => evaluate("document.querySelectorAll('#preview-pane iframe').length === 0"), 'auth revocation clears the old frame')
      const start = paneRequests.length
      await evaluate(`setSession(${JSON.stringify(session)}); setRevision(1); setAccessAllowed(true)`)
      await until(() => evaluate("document.querySelector('#preview-pane [role=status]')?.textContent.includes('session has expired')"), 'the independent auth gate still blocks navigation')
      assert.equal(paneRequests.length, start, 'neither HTML nor JSON can leave the closed gate')
      assert.equal(await evaluate("document.querySelectorAll('#preview-pane iframe').length"), 0)
      assert.deepEqual(await evaluate('window.authErrors'), [401])
      assert.equal((await observed()).boots.some(boot => boot.program === 'must not bypass client auth gate'), false)
      await noErrors()
    })

    await t.test('a stale first HTML load never runs the old design and Retry fetches the requested version', async () => {
      paneFixture ??= await buildPaneFixture(dir)
      const session = 'stale-first-load'
      paneArtifacts.set(`${SESSION}:101`, payload(101, design({ program: 'stale test baseline' })))
      paneLatest.set(SESSION, 101)
      paneArtifacts.set(`${session}:1`, payload(1, design({ program: 'must never run stale design' }), session))
      paneLatest.set(session, 1)
      await cdp.call('Page.navigate', { url: `${origin}/pane` })
      await until(() => evaluate('window.fixtureReady === true'), 'stale fixture hydration')
      await until(async () => (await observed()).paints.some(paint => paint.revision === 101), 'stale fixture bootstrap')
      const start = paneRequests.length
      await evaluate(`setSession(${JSON.stringify(session)}); setRevision(2)`)
      const status = () => evaluate("document.querySelector('#preview-pane [role=status]')?.textContent ?? ''")
      await until(async () => (await status()).includes('not available'), 'a stale source fails without waiting for the paint deadline')
      assert.equal((await observed()).boots.some(boot => boot.program === 'must never run stale design'), false)
      assert.deepEqual(paneRequests.slice(start).map(request => request.json ? 'json' : 'html'), ['html'])
      paneArtifacts.set(`${session}:2`, payload(2, design({ program: 'requested fresh design' }), session))
      paneLatest.set(session, 2)
      await evaluate("[...document.querySelectorAll('#preview-pane button')].find(button => button.textContent === 'Retry preview').click()")
      await until(async () => (await observed()).paints.some(paint => paint.revision === 2), 'fresh revision paints after Retry')
      assert.equal((await observed()).boots.some(boot => boot.program === 'requested fresh design'), true)
      assert.deepEqual(paneRequests.slice(start).map(request => request.json ? 'json' : 'html'), ['html', 'html'])
      assert.equal(await status(), '')
      await noErrors()
    })

    await t.test('a loaded replacement survives background time while a genuinely visible load still has a deadline', async () => {
      paneFixture ??= await buildPaneFixture(dir)
      holdBundle = false
      const publish = (revision, program) => {
        paneArtifacts.set(`${SESSION}:${revision}`, payload(revision, design({ program })))
        paneLatest.set(SESSION, revision)
      }
      const painted = revision => until(async () => (await observed()).paints.find(p => p.revision === revision && p.updateReady), `background-safe paint ${revision}`)
      const status = () => evaluate("document.querySelector('#preview-pane [role=status]')?.textContent ?? ''")
      const frameCount = () => evaluate("document.querySelectorAll('#preview-pane iframe').length")
      let alternate
      try {
        publish(101, 'background initial')
        await cdp.call('Page.navigate', { url: `${origin}/pane` })
        await until(() => evaluate('window.fixtureReady === true'), 'background fixture hydration')
        await painted(101)
        publish(301, 'background replacement')
        paneModes.set(`${SESSION}:301`, 'hold-html')
        const heldCount = paneHtmlHeld.length
        await evaluate('setRevision(301)')
        await until(() => paneHtmlHeld.length === heldCount + 1, 'replacement HTML held before the tab becomes hidden')
        await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: false })
        const other = await cdp.call('Target.createTarget', { url: 'about:blank' })
        alternate = other.targetId
        await cdp.call('Target.activateTarget', { targetId: alternate })
        await until(() => evaluate('document.visibilityState === "hidden"'), 'the real parent tab is hidden')
        const pending = paneHtmlHeld[heldCount]
        sendFrame(pending.response, pending.preview)
        await until(async () => (await observed()).boots.some(boot => boot.program === 'background replacement'), 'the replacement program boots while hidden')
        // Hidden tabs pause the two animation frames used to confirm the first paint.
        // Exceed the old twenty-second wall-clock deadline without mocking this state.
        await sleep(21_000)
        assert.equal(await status(), '', 'hidden time is not a failed paint')
        assert.equal(await frameCount(), 2, 'the loaded replacement stays mounted until it can paint')
        await cdp.call('Page.bringToFront')
        await until(() => evaluate('document.visibilityState === "visible"'), 'parent tab resumes')
        await painted(301)
        await until(async () => await frameCount() === 1, 'replacement is revealed and the old front is removed')
        assert.equal(await status(), '')
        assert.equal((await observed()).boots.filter(boot => boot.program === 'background replacement').length, 1, 'resuming neither reloads nor restarts the replacement')

        publish(302, 'never-loaded replacement')
        paneModes.set(`${SESSION}:302`, 'hold-html')
        const stalledCount = paneHtmlHeld.length
        await evaluate('setRevision(302)')
        await until(() => paneHtmlHeld.length === stalledCount + 1, 'a genuinely stalled visible HTML load')
        // Advance native Chrome timers instead of adding a second wall-clock wait.
        await cdp.call('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 21_000 })
        await until(async () => (await status()).includes('did not finish loading'), 'the visible paint deadline still expires')
        assert.equal(await frameCount(), 1, 'a genuine visible failure retains the confirmed document')
        await noErrors()
      } finally {
        await cdp.call('Page.bringToFront')
        await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
        if (alternate) await cdp.call('Target.closeTarget', { targetId: alternate })
        paneModes.delete(`${SESSION}:301`)
        paneModes.delete(`${SESSION}:302`)
        for (const { response } of paneHtmlHeld) response.destroy()
      }
    })
    await noErrors()
  } catch (error) {
    t.diagnostic(`Browser failure: ${error.stack}; runtime errors: ${JSON.stringify(errors)}`)
    t.diagnostic(`Chrome stderr (tail): ${chromeError}`)
    if (cdp) {
      try { t.diagnostic(`Last browser observations: ${JSON.stringify(await cdp.evaluate('({ ...observed, reports: observed.reports.slice(-1) })'))}`) } catch {}
    }
    throw error
  } finally {
    // Owned resources only. Bound graceful shutdown, then force cleanup even after a
    // failed assertion/CDP connection so a hung image cannot strand Chrome or a port.
    if (cdp) await cdp.close()
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(resolve => chrome.once('exit', resolve))
      chrome.kill('SIGTERM')
      await Promise.race([exited, sleep(2000, undefined, { ref: false })])
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited }
    }
    chrome?.stderr.destroy()
    for (const { response } of [...held, ...paneHeld, ...paneHtmlHeld]) response.destroy()
    for (const response of bundleHeld) response.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// The real first-generation capture exposed the draft -> published handoff before
// the wrapper's load event: 8 black frames at 120 Hz. Hold the wrapper response open
// after its scripts run, so its real child paints before the wrapper finishes loading.
// No synthetic paint messages or replacement slot coordinator participate.
test('first publish waits for wrapper load after child paint', { timeout: 60_000 }, async t => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const dir = await mkdtemp(join(tmpdir(), 'fx0-first-publish-'))
  const errors = []
  const held = []
  let chrome, cdp, chromeError = ''
  const fixture = await buildPaneFixture(dir, null, { initialRevision: 0 })
  const house = await readFile(new URL('./fixtures/simple-house.html', import.meta.url), 'utf8')
  const candidate = payload(1, house)
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(fixture.html.replace('</style>', ':root{color-scheme:light dark}body,.bg-background{background:light-dark(white,black)}</style>'))
    if (url.pathname === '/bundle.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(fixture.bundle)
    if (url.pathname === '/api/artifact-frame') {
      if (url.searchParams.get('format') === 'json') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(candidate))
      const prepared = prepareDesignArtifactHtml(candidate.renderHtml, DESIGN_ARTIFACT_EMBEDDED_CSP, TOKEN)
      // Observe the real child's message without forwarding, delaying or replacing it.
      const html = designFrameHtml(prepared, TOKEN, [], candidate).replace('<script>', `<script>
window.childPainted = false;
addEventListener('message', event => {
  if (event.source === document.querySelector('#frame-root iframe')?.contentWindow && event.data?.type === 'painted') window.childPainted = true;
});`)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': designFrameCsp() })
      response.write(html)
      held.push(response)
      return
    }
    response.writeHead(404).end()
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let spawnError
    chrome.on('error', error => { spawnError = error })
    chrome.stderr.on('data', data => { chromeError = (chromeError + data).slice(-16_384) })
    const port = await until(async () => {
      if (spawnError) throw spawnError
      assert.equal(chrome.exitCode, null, chromeError)
      try { return (await readFile(join(dir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0] }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }, 'Chrome debugging port')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json()
    cdp = await connectCdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl, errors)
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 720, deviceScaleFactor: 1, mobile: false })
    const origin = `http://127.0.0.1:${server.address().port}`
    for (const scheme of ['light', 'dark']) await t.test(scheme, async () => {
      await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
      await cdp.call('Page.navigate', { url: `${origin}/?scheme=${scheme}` })
      await until(() => cdp.evaluate('window.fixtureReady === true'), 'first-generation fixture')
      try {
        await cdp.evaluate(`setDraft(${JSON.stringify(house)})`)
        await until(() => cdp.evaluate(`(() => {
          const frame = document.querySelector('iframe[title="Design preview while generating"]');
          return !!frame?.contentDocument?.getElementById('door') && getComputedStyle(frame).opacity === '1';
        })()`), 'the real house draft is visible')
        await cdp.evaluate(`window.originalDraft = document.querySelector('iframe[title="Design preview while generating"]'); setRevision(1); setDraft(null)`)
        await until(() => cdp.evaluate(`!!document.querySelector('iframe[src]')?.contentWindow?.childPainted`), 'the real child paints while its wrapper response is still open')
        // Let any erroneously forwarded paint reach React before checking its layers.
        await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const beforeLoad = await cdp.evaluate(`(() => {
          const wrapper = document.querySelector('iframe[src]');
          return { readyState: wrapper.contentDocument.readyState, paints: observed.paints.length,
            draftRetained: originalDraft.isConnected, draftOpacity: getComputedStyle(originalDraft).opacity,
            wrapperOpacity: getComputedStyle(wrapper).opacity, hidden: wrapper.getAttribute('aria-hidden') };
        })()`)
        t.diagnostic(`${scheme} before wrapper load: ${JSON.stringify(beforeLoad)}`)
        assert.notEqual(beforeLoad.readyState, 'complete', 'the HTTP fixture really delays wrapper load')
        assert.equal(beforeLoad.paints, 0, 'child paint cannot retire the draft before the wrapper loads')
        assert.equal(beforeLoad.draftRetained, true)
        assert.equal(beforeLoad.draftOpacity, '1')
        assert.equal(beforeLoad.wrapperOpacity, '0')
        assert.equal(beforeLoad.hidden, 'true')
        for (const response of held.splice(0)) response.end()
        await until(() => cdp.evaluate(`observed.paints.length > 0 && !originalDraft.isConnected`), 'wrapper load releases the retained child paint and retires the draft')
        assert.equal(await cdp.evaluate(`document.querySelector('iframe[title="Design artifact preview"]').contentDocument.readyState`), 'complete')
        assert.equal(await cdp.evaluate(`document.querySelectorAll('#preview-pane iframe').length`), 1, 'the handoff leaves only the interactive frame')
        assert.deepEqual(await cdp.evaluate('observed.errors'), [])
      } finally {
        for (const response of held.splice(0)) response.end()
      }
    })
    assert.deepEqual(errors, [], 'no browser execution errors')
  } finally {
    if (cdp) await cdp.close()
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(resolve => chrome.once('exit', resolve))
      chrome.kill('SIGTERM')
      await Promise.race([exited, sleep(2000, undefined, { ref: false })])
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited }
    }
    chrome?.stderr.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    for (const response of held) response.destroy()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
