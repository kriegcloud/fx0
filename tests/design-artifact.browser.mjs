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
