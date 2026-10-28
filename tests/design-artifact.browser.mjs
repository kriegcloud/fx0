import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { markRemoteImages } from '../lib/remote-image.ts'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, DESIGN_FRAME_CSP, designFrameCsp, designFrameHtml, MAX_EMBEDDED_IMAGE_BYTES, prepareDesignArtifactHtml, validateDesignArtifactHtml } from '../lib/design-artifact.ts'
import { DESIGN_CAPTURE_RELAY, designCaptureScript } from '../lib/design-capture.ts'

// Opt-in: runs real Chrome headless on this machine. Set CHROME_PATH for another browser binary.
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Each design reports where its CSP <meta> landed and whether a script could open a
// nested data: frame, the escape the embedded CSP exists to block.
const PROBE = `<script>
addEventListener('DOMContentLoaded', () => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  const report = (frame) => parent.postMessage({ name: document.body.dataset.case, csp: meta ? meta.parentElement.tagName : 'none', frame }, '*')
  addEventListener('securitypolicyviolation', (event) => { if (event.violatedDirective === 'frame-src') report('blocked') })
  const nested = document.createElement('iframe')
  nested.onload = () => report('loaded')
  nested.src = 'data:text/html,<p>nested</p>'
  document.body.append(nested)
})
</script>`
const design = (name) => `<!doctype html><html><head><title>design</title></head><body data-case="${name}"><p>design</p>${PROBE}</body></html>`

// JavaScript trims these, but before a doctype the HTML parser treats them as text.
const NON_HTML_SPACES = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
  .filter((character) => /\s/.test(character) && !'\t\n\f\r '.includes(character))
const label = (character) => `U+${character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`

// Published now: validated, stored as the normalized document, then rendered.
function published(name, raw) {
  const validation = validateDesignArtifactHtml(raw)
  assert.equal(validation.ok, true, `${name}: ${validation.error}`)
  return prepareDesignArtifactHtml(validation.html, DESIGN_ARTIFACT_EMBEDDED_CSP, 'browser-test')
}

function cases() {
  const all = [
    // Control: a design without its CSP must show the nested frame loading, or this test proves nothing.
    ['control without CSP', prepareDesignArtifactHtml(design('control without CSP'), undefined, 'browser-test')],
    ['plain', published('plain', design('plain'))],
  ]
  for (const space of ['\t', '\n', '\f', '\r', ' ', ...NON_HTML_SPACES]) {
    const name = `${label(space)} before the doctype`
    all.push([name, published(name, space + design(name))])
  }
  // Stored before normalization existed: rendered straight from the raw value.
  for (const space of ['\u00a0', '\ufeff']) {
    const name = `stored with ${label(space)} first`
    all.push([name, prepareDesignArtifactHtml(space + design(name), DESIGN_ARTIFACT_EMBEDDED_CSP, 'browser-test')])
  }
  return all
}

const page = (all) => `<!doctype html><html><head><title>design CSP</title></head><body><pre id="out">{}</pre><script>
const results = {}
addEventListener('message', ({ data }) => {
  const seen = results[data.name]
  results[data.name] = { csp: data.csp, frame: seen?.frame === 'blocked' || data.frame === 'blocked' ? 'blocked' : data.frame }
  document.getElementById('out').textContent = JSON.stringify(results)
})
for (const url of ${JSON.stringify(all.map(([, html]) => `data:text/html;base64,${Buffer.from(html).toString('base64')}`))}) {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.src = url
  document.body.append(frame)
}
</script></body></html>`

test('in Chrome, every published or stored design keeps its CSP in <head> and cannot open nested frames', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const all = cases()
  const dir = await mkdtemp(join(tmpdir(), 'fx0-design-csp-'))
  try {
    const file = join(dir, 'page.html')
    await writeFile(file, page(all))
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    const results = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    for (const [name] of all) {
      const expected = name.startsWith('control') ? { csp: 'none', frame: 'loaded' } : { csp: 'HEAD', frame: 'blocked' }
      assert.deepEqual(results[name], expected, name)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The page artifact-frame serves, with its policy as a real response header, framing
// published designs the way production does: images marked by the server, loaded by the
// wrapper from the image route, embedded before the design runs. Designs report to the
// top page (the wrapper relays only its own messages).
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const reporting = (name, body) => `<!doctype html><html><head><title>design</title></head><body>${body}
<script>
const results = {}
const report = (key, value) => { results[key] = value; top.postMessage({ design: ${JSON.stringify(name)}, results }, '*') }
addEventListener('securitypolicyviolation', (event) => {
  if (event.blockedURI.startsWith('http:') && event.violatedDirective.startsWith('img-src')) report('remote', 'blocked')
  if (event.violatedDirective.startsWith('connect-src')) report('fetch', 'blocked')
})
const remote = new Image()
remote.onload = () => report('remote', 'loaded')
remote.src = 'http://127.0.0.1:9/pixel.png'
fetch(location.ancestorOrigins?.[0] ?? 'http://127.0.0.1:9', { mode: 'no-cors' }).then(() => report('fetch', 'reached'), () => {})
addEventListener('load', () => {
  report('embedded', [...document.images].filter((image) => image.src.startsWith('data:image/png')).length)
  const first = document.querySelector('img')
  report('decoded', first.complete && first.naturalWidth > 0)
})
</script></body></html>`

test('in Chrome, the real wrapper embeds marked images, keeps them across revisions, and frames designs past 2 MiB', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const pixel = Buffer.from(PIXEL, 'base64')
  const big = Buffer.alloc(Math.floor(1.1 * 1024 * 1024), 0x41)
  const repeated = Buffer.alloc(1024 * 1024, 0x41)
  const bodies = { pixel, big1: big, big2: big, big3: big, repeated }
  const hits = {}
  const design = (name, body, images) => {
    const stored = validateDesignArtifactHtml(reporting(name, body + images.map((image) => `<img alt="" src="https://example.com/${image}.png">`).join('')))
    assert.equal(stored.ok, true, name)
    const marked = markRemoteImages(stored.html, '0123456789abcdef0123456789abcdef')
    return {
      html: prepareDesignArtifactHtml(marked.html, DESIGN_ARTIFACT_EMBEDDED_CSP, 'browser-test'),
      images: marked.images.map(({ marker, url }) => ({ marker, src: `/api/artifact-image?u=${new URL(url).pathname.slice(1, -4)}` })),
    }
  }
  const designs = {
    small: design('small', '', ['pixel']),
    again: design('again', '', ['pixel']),
    large: design('large', '', ['pixel', 'big1', 'big2', 'big3']),
    repeat: design('repeat', '<img alt="" src="https://example.com/repeated.png">'.repeat(5), ['repeated']),
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://test')
    if (url.pathname === '/api/artifact-image') {
      const name = url.searchParams.get('u')
      hits[name] = (hits[name] ?? 0) + 1
      if (!bodies[name]) return response.writeHead(404).end()
      return response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' }).end(bodies[name])
    }
    if (url.pathname === '/frame' && designs[url.searchParams.get('design')]) {
      const { html, images } = designs[url.searchParams.get('design')]
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': designFrameCsp(`http://127.0.0.1:${server.address().port}/api/artifact-image`) })
      return response.end(designFrameHtml(html, 'browser-test', images))
    }
    if (url.pathname === '/hold') return setTimeout(() => response.writeHead(404).end(), 4000)
    if (url.pathname === '/') {
      return response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>app</title></head><body><pre id="out">{}</pre><script>
const out = {}
const open = (name) => { const frame = document.createElement('iframe'); frame.src = '/frame?design=' + name; document.body.append(frame) }
addEventListener('message', ({ data }) => {
  if (data?.design) out[data.design] = data.results
  // A later revision of the same design opens only once the first one has painted.
  if (data?.type === 'fx0-artifact-painted' && !out.reopened && out.small) { out.reopened = true; open('again') }
  document.getElementById('out').textContent = JSON.stringify(out)
})
for (const name of ['small', 'large', 'repeat']) open(name)
</script><img alt="" src="/hold"></body></html>`)
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'fx0-design-frame-'))
  try {
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/`,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    const out = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    assert.deepEqual(out.small, { remote: 'blocked', fetch: 'blocked', embedded: 1, decoded: true })
    assert.deepEqual(out.again, { remote: 'blocked', fetch: 'blocked', embedded: 1, decoded: true })
    assert.equal(hits.pixel, 1, 'the next revision embeds the image from the browser cache')
    assert.equal(out.large?.embedded, 4, 'a design past what a data: URL can carry still renders')
    assert.equal(out.repeat?.embedded, Math.floor(MAX_EMBEDDED_IMAGE_BYTES / repeated.length), 'the budget counts every place an image is written')
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// screenshot_design: the app mounts a preview the way DesignCapture does
// (fixed, invisible, under the page, in a phone-sized window) and asks it for photos once
// it has painted: the viewport, then the whole page. The viewport must come back as one
// 1280x800 WebP of the design, the page as viewport-high tiles from the top (even when
// html and body are only viewport-high and the content overflows them), and the remote
// url() the design names must never reach the network, capture included.
test('in Chrome, a hidden preview photographs its viewport and its whole page without any network', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const requests = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://test')
    requests.push(url.pathname)
    if (url.pathname === '/frame') {
      const stored = validateDesignArtifactHtml(`<!doctype html><html><head><style>html,body{margin:0;height:100%}
section{height:800px}.a{background:#ff0066}.b{background:#00cc66}.c{height:400px;background:#3366ff}
.leak{background:url(http://127.0.0.1:${server.address().port}/leak.png)}</style></head><body>
<section class="a"><h1 class="leak" style="color:#fff;margin:0;padding:40px">fx0</h1></section><section class="b"></section><section class="c"></section></body></html>`)
      assert.equal(stored.ok, true, stored.error)
      const token = 'browser-test'
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': DESIGN_FRAME_CSP })
      response.end(designFrameHtml(prepareDesignArtifactHtml(stored.html, DESIGN_ARTIFACT_EMBEDDED_CSP, token, designCaptureScript(token)), token, [], undefined, { relay: DESIGN_CAPTURE_RELAY }))
    } else if (url.pathname === '/hold') {
      setTimeout(() => response.writeHead(404).end(), 6000)
    } else if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>app</title></head><body style="margin:0">
<main style="position:fixed;inset:0;background:#fff"><pre id="out">{}</pre></main>
<div style="position:fixed;inset:0;z-index:-10;overflow:hidden;opacity:0;pointer-events:none"><iframe id="capture" src="/frame" style="width:1280px;height:800px;border:0"></iframe></div>
<script>
const frame = document.getElementById('capture')
const out = {}
const show = () => { document.getElementById('out').textContent = JSON.stringify(out) }
const describe = async (blob) => {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  return { type: blob.type, width: bitmap.width, height: bitmap.height, color: [...context.getImageData(1200, bitmap.height - 20, 1, 1).data.slice(0, 3)] }
}
addEventListener('message', async ({ data, source }) => {
  if (source !== frame.contentWindow) return
  if (data?.type === 'fx0-artifact-painted' && !out.asked) {
    out.asked = true
    frame.contentWindow.postMessage({ type: 'fx0-capture', cid: 'viewport' }, location.origin)
  }
  if (data?.type !== 'fx0-artifact-captured') return
  out[data.cid] = { height: data.height, truncated: data.truncated, timing: data.timing, images: await Promise.all(data.blobs.map(describe)) }
  if (data.cid === 'viewport') frame.contentWindow.postMessage({ type: 'fx0-capture', cid: 'page', full: true }, location.origin)
  show()
})
</script><img alt="" src="/hold"></body></html>`)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'fx0-design-capture-'))
  try {
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=390,844',
      `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/`,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    const out = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    const near = (rgb, target) => rgb.every((value, i) => Math.abs(value - target[i]) < 24)
    assert.equal(out.viewport.images.length, 1)
    assert.deepEqual(out.viewport.images.map(({ type, width, height }) => [type, width, height]), [['image/webp', 1280, 800]], 'Chrome sends WebP')
    assert.ok(near(out.viewport.images[0].color, [255, 0, 102]), `the viewport is the design's first section, got ${out.viewport.images[0].color}`)
    for (const part of ['fontsMs', 'libraryMs', 'encodeMs']) assert.ok(out.viewport.timing?.[part] >= 0, `the frame reports ${part}`)
    assert.equal(out.page.height, 2000)
    assert.equal(out.page.truncated, false)
    assert.deepEqual(out.page.images.map(({ width, height }) => [width, height]), [[1280, 800], [1280, 800], [1280, 400]])
    const colors = [[255, 0, 102], [0, 204, 102], [51, 102, 255]]
    out.page.images.forEach((image, i) => assert.ok(near(image.color, colors[i]), `tile ${i + 1} shows section ${i + 1}, got ${image.color}`))
    assert.ok(!requests.includes('/leak.png'), 'the url() the design names never reached the network')
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// screenshot_design on a live preview, driven as the app drives it: a compatible hot update is
// photographed in place; the design is then frozen so the frame restores it under a fresh token
// and it is photographed again; an update the frame refuses makes the app reload the frame, with
// a fresh token, and it is photographed once more. Each photo must show the design it came from,
// under the wrapper's production policy and the design's embedded CSP, with no network request.
test('in Chrome, a live preview photographs its design after a hot update, a restore and a reload', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const session = 'capture-session'
  const requests = []
  let origin = ''
  // Freezes the design's own thread on request, as a stalled design would be.
  const FREEZE = `<script>addEventListener('message',event=>{if(event.data==='fx0-test-freeze'){const end=Date.now()+4500;while(Date.now()<end);}});</script>`
  const page = (color, tag = 'section') => `<!doctype html><html><head><title>capture</title><style>html,body{margin:0;height:100%}
${tag}{height:800px}.a{background:${color};background-image:url(${origin}/leak.png)}</style></head><body><${tag} class="a"></${tag}>${FREEZE}</body></html>`
  const source = (revision) => revision === 1 ? page('#ff0066') : revision === 2 ? page('#0066ff') : page('#00cc66', 'main')
  // The same shape the route returns as JSON, and what it hands the wrapper.
  const payload = (revision) => {
    const validation = validateDesignArtifactHtml(source(revision))
    assert.equal(validation.ok, true, validation.error)
    return { protocol: 1, sessionId: session, revision, sourceHtml: validation.html, renderHtml: validation.html, images: [] }
  }
  // The app: a fixed, invisible preview in a phone-sized window. It waits for each paint, asks for
  // photos, and sends the updates the way PreviewPane does. The hold keeps the load (and the dump)
  // open until the flow is done.
  const harness = `<!doctype html><html><head><title>app</title></head><body><pre id="out">{}</pre>
<div style="position:fixed;inset:0;z-index:-10;overflow:hidden;opacity:0;pointer-events:none"><iframe id="capture" style="width:1280px;height:800px;border:0"></iframe></div>
<script>
const out = { shots: {} }
const frame = document.getElementById('capture')
const show = () => { document.getElementById('out').textContent = JSON.stringify(out) }
const waiting = []
const next = (test) => new Promise((resolve) => waiting.push({ test, resolve }))
addEventListener('message', ({ data, source }) => {
  if (source !== frame.contentWindow || !data) return
  const at = waiting.findIndex((waiter) => waiter.test(data))
  if (at >= 0) waiting.splice(at, 1)[0].resolve(data)
})
const describe = async (blob) => {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  return { type: blob.type, width: bitmap.width, height: bitmap.height, color: [...context.getImageData(1200, bitmap.height - 20, 1, 1).data.slice(0, 3)] }
}
const bounded = (promise, what) => Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error(what + ' did not answer in time')), 8000))])
const painted = () => next((data) => data.type === 'fx0-artifact-painted' && data.updateReady === true)
const open = (revision) => {
  const arrived = painted()
  frame.src = '/frame?rev=' + revision + '&n=' + crypto.randomUUID()
  return bounded(arrived, 'the preview painting')
}
const shot = async (name) => {
  const reply = next((data) => data.type === 'fx0-artifact-captured' && data.cid === name)
  frame.contentWindow.postMessage({ type: 'fx0-capture', cid: name, full: false }, location.origin)
  const data = await bounded(reply, 'the capture')
  out.shots[name] = { error: data.error ?? null, images: await Promise.all(data.blobs.map(describe)) }
  show()
}
const update = async (documentId, baseRevision, revision) => {
  const body = await (await fetch('/payload?rev=' + revision)).json()
  const requestId = crypto.randomUUID()
  const result = next((data) => data.type === 'fx0-preview-result' && data.requestId === requestId)
  frame.contentWindow.postMessage({ type: 'fx0-preview-update', protocol: 1, requestId, documentId, baseRevision, payload: body }, location.origin)
  const data = await bounded(result, 'the update')
  return { status: data.status, reason: data.reason ?? null }
}
const run = async () => {
  const first = await open(1)
  await shot('pink')
  out.compatible = await update(first.documentId, 1, 2)
  await shot('blue')
  const restored = Promise.race([painted(), new Promise((_, reject) => setTimeout(() => reject(new Error('the frame did not restore a stalled design')), 9000))])
  frame.contentDocument.querySelector('#frame-root iframe').contentWindow.postMessage('fx0-test-freeze', '*')
  const again = await restored
  out.restored = again.documentId !== first.documentId
  await shot('restored')
  out.refused = await update(again.documentId, 2, 3)
  const reopened = await open(3)
  out.reopened = reopened.documentId !== again.documentId
  await shot('reloaded')
}
run().then(() => { out.done = true }, (error) => { out.error = String(error && error.message || error) }).then(() => {
  show()
  return fetch('/done')
})
</script><img alt="" src="/hold"></body></html>`
  const holds = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://test')
    requests.push(url.pathname)
    if (url.pathname === '/frame') {
      const preview = payload(Number(url.searchParams.get('rev')))
      // Each response is a new wrapper with its own token, as the route issues.
      const token = crypto.randomUUID()
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': designFrameCsp(`${origin}/api/artifact-image`) })
      return response.end(designFrameHtml(prepareDesignArtifactHtml(preview.renderHtml, DESIGN_ARTIFACT_EMBEDDED_CSP, token), token, [], preview, { relay: DESIGN_CAPTURE_RELAY, script: designCaptureScript }))
    }
    if (url.pathname === '/payload') {
      return response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }).end(JSON.stringify(payload(Number(url.searchParams.get('rev')))))
    }
    if (url.pathname === '/hold') {
      holds.push(response)
      setTimeout(() => { if (!response.writableEnded) response.writeHead(404).end() }, 60_000).unref()
      return
    }
    if (url.pathname === '/done') {
      for (const held of holds.splice(0)) if (!held.writableEnded) held.writeHead(404).end()
      return response.writeHead(204).end()
    }
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(harness)
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const dir = await mkdtemp(join(tmpdir(), 'fx0-design-live-'))
  try {
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=390,844',
      `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `${origin}/`,
    ], { timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
    const out = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    assert.equal(out.error, undefined, out.error)
    assert.equal(out.done, true, 'the flow finished')
    assert.equal(out.compatible.status, 'applied', 'a compatible update applies in place')
    assert.equal(out.restored, true, 'a stalled design is restored under a new document token')
    assert.equal(out.refused.status, 'reload', 'an incompatible update is refused, not applied')
    assert.equal(out.reopened, true, 'the reloaded frame has a new document token')
    const near = (rgb, target) => rgb.every((value, i) => Math.abs(value - target[i]) < 24)
    const expected = { pink: [255, 0, 102], blue: [0, 102, 255], restored: [0, 102, 255], reloaded: [0, 204, 102] }
    for (const [name, color] of Object.entries(expected)) {
      const shot = out.shots[name]
      assert.equal(shot.error, null, `${name}: no capture failure`)
      assert.deepEqual(shot.images.map(({ type, width, height }) => [type, width, height]), [['image/webp', 1280, 800]], `${name}: one WebP viewport`)
      assert.ok(near(shot.images[0].color, color), `${name} shows ${color}, got ${shot.images[0].color}`)
    }
    assert.ok(!requests.includes('/leak.png'), 'the url() the design names never reached the network')
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// The draft has no network, so a remote image must show the soft placeholder, never
// the browser's broken-image icon. The draft cleaner runs in Chrome, types stripped.
test('in Chrome, a draft shows a placeholder for remote images instead of a broken icon', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const { stripTypeScriptTypes } = await import('node:module')
  const source = await (await import('node:fs/promises')).readFile(new URL('../lib/draft-preview.ts', import.meta.url), 'utf8')
  const cleaner = stripTypeScriptTypes(source).replace(/^export /gm, '')
  const draft = `<!doctype html><html><head></head><body>
<img id="remote" alt="Bistro dining room" src="https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1600">
<img id="srcset" alt="Kitchen" srcset="https://example.com/a.png 1x, https://example.com/b.png 2x">
<img id="embedded" alt="" src="data:image/png;base64,${PIXEL}">
</body></html>`
  const dir = await mkdtemp(join(tmpdir(), 'fx0-draft-'))
  try {
    const file = join(dir, 'page.html')
    await writeFile(file, `<!doctype html><html><head><title>draft</title></head><body><pre id="out">{}</pre><script>${cleaner}
const frame = document.createElement('iframe')
frame.srcdoc = draftDocument(${JSON.stringify(draft)})
frame.onload = () => setTimeout(() => {
  const out = {}
  for (const image of frame.contentDocument.images) out[image.id] = image.complete && image.naturalWidth > 0 ? (image.src.startsWith('data:image/svg+xml') ? 'placeholder' : 'image') : 'broken'
  document.getElementById('out').textContent = JSON.stringify(out)
}, 200)
document.body.append(frame)
</script></body></html>`)
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(file).href,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    assert.deepEqual(JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1]), { remote: 'placeholder', srcset: 'placeholder', embedded: 'image' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The headless harness supplies user activation and disables the browser popup
// blocker only for this test. Production requires a real user click.
test('in Chrome, a design can populate, interact with, and close an isolated popout', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const popupHtml = `<!doctype html><html><head><title>Detached panel</title></head><body>
  <button onclick="this.textContent=String(Number(this.textContent)+1)">0</button>
  <script>
  const out = {};
  const button = document.querySelector('button');
  button.click();
  out.interactive = button.textContent === '1';
  out.rtcBlocked = typeof RTCPeerConnection === 'undefined';
  try { void document.cookie; out.cookiesBlocked = false; } catch { out.cookiesBlocked = true; }
  try { void parent.document; out.appBlocked = false; } catch { out.appBlocked = true; }
  addEventListener('securitypolicyviolation', event => {
    if(event.violatedDirective === 'connect-src') { out.fetchBlocked = true; parent.postMessage({probe: out}, '*'); }
  });
  fetch('http://127.0.0.1:9/probe').catch(() => {});
  </script></body></html>`
  const raw = `<!doctype html><html><head><title>Popout test</title></head><body><script>
  beep.openPopout(${JSON.stringify(popupHtml).replaceAll('</script', '<\\/script')}, {title:'Detached panel'}).then(handle => {
    top.postMessage({opened: true}, '*');
    addEventListener('message', event => {if(event.data === 'close-test-popout') handle.close()});
  }, error => top.postMessage({error:String(error)}, '*'));
  </script></body></html>`
  const validation = validateDesignArtifactHtml(raw)
  assert.equal(validation.ok, true, validation.error)
  const prepared = prepareDesignArtifactHtml(validation.html, DESIGN_ARTIFACT_EMBEDDED_CSP, 'popout-test')
  const harness = `<script>
  Object.defineProperty(navigator, 'userActivation', {value:{isActive:true}});
  const nativeOpen=window.open;
  window.open=(...args)=>{
    const popup=nativeOpen(...args);
    if(popup) popup.addEventListener('message', event=>{
      if(!event.data?.probe)return;
      top.postMessage({probe:event.data.probe}, '*');
      document.querySelector('iframe').contentWindow.postMessage('close-test-popout','*');
      const timer=setInterval(()=>{if(popup.closed){clearInterval(timer);top.postMessage({closed:true},'*')}},25);
    });
    return popup;
  };
  </script>`
  const server = http.createServer((request, response) => {
    if (request.url === '/hold') return setTimeout(() => response.writeHead(404).end(), 1500)
    if (request.url === '/frame') {
      return response.writeHead(200, {'content-type': 'text/html', 'content-security-policy': DESIGN_FRAME_CSP})
        .end(designFrameHtml(prepared, 'popout-test').replace('<script>', harness + '<script>'))
    }
    response.writeHead(200, {'content-type': 'text/html'}).end(`<!doctype html><html><body><pre id="out">{}</pre><script>
    const out={};
    addEventListener('message', ({data}) => {
      if(data?.probe)Object.assign(out,data.probe);
      if(data?.opened)out.opened=true;
      if(data?.closed)out.closed=true;
      if(data?.error)out.error=data.error;
      document.querySelector('#out').textContent=JSON.stringify(out);
    });
    </script><iframe src="/frame"></iframe><img src="/hold"></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'fx0-popout-'))
  try {
    const {stdout} = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking',
      `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/`,
    ], {timeout: 60_000, maxBuffer: 1024 * 1024})
    const out = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    assert.deepEqual(out, {opened: true, interactive: true, rtcBlocked: true, cookiesBlocked: true, appBlocked: true, fetchBlocked: true, closed: true})
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, {recursive: true, force: true})
  }
})
