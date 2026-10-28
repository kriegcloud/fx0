import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {
  bootstrapMedianCI, browserSources, checkOrigin, checkProbe, checkResources, checkTrial, makeSchedule,
  median, pageBridge, parseArgs, parseTabOutput, stripScripts, summarize,
} from './preview-live-ab.mjs'

const SESSION = '11111111-1111-4111-8111-111111111111'
const ARGS = ['--tab', '1267394049', '--session', SESSION, '--out', '/tmp/x.json']
const VIEWPORT = { width: 1440, height: 900 }
const SHA = 'a'.repeat(64)

function trial(overrides = {}) {
  return {
    ok: true, readyMs: 40, imageReadyMs: 120, errors: 0, mountId: 'm-1',
    paint: { sessionId: SESSION, revision: 2, protocol: 1, updateReady: false },
    frame: { width: 1000, height: 720 },
    reply: { error: null, truncated: false, timing: null, blobs: [{ type: 'image/webp', size: 1000, width: 1000, height: 720 }] },
    resources: [{ format: 'html', session: SESSION }],
    viewport: { before: { ...VIEWPORT, visibility: 'visible' }, after: { ...VIEWPORT, visibility: 'visible' } },
    ...overrides,
  }
}

function sample(pair, variant, order, imageReadyMs, warmup = false) {
  return { pair, variant, order, warmup, readyMs: imageReadyMs / 2, imageReadyMs }
}

test('parseArgs accepts the documented CLI and rejects bad inputs before any AppleEvents', () => {
  const options = parseArgs([...ARGS, '--pairs', '30', '--window', '1267393606', '--seed', '7'])
  assert.deepEqual(options, { tab: '1267394049', window: '1267393606', session: SESSION, pairs: 30, seed: 7, out: '/tmp/x.json' })
  assert.equal(Number.isInteger(parseArgs(ARGS).seed), true)
  assert.throws(() => parseArgs([...ARGS, '--pairs', '29']), /even integer/)
  assert.throws(() => parseArgs([...ARGS, '--pairs', '0']), /even integer/)
  assert.throws(() => parseArgs([...ARGS, '--pairs', '202']), /even integer/)
  assert.throws(() => parseArgs(['--tab', '12a', '--session', SESSION, '--out', '/tmp/x']), /numeric tab id/)
  assert.throws(() => parseArgs(['--tab', '1', '--session', 'not-a-uuid', '--out', '/tmp/x']), /session UUID/)
  assert.throws(() => parseArgs(['--tab', '1', '--session', SESSION]), /--out is required/)
  assert.throws(() => parseArgs([...ARGS, '--bogus', '1']), /unknown option/)
  assert.throws(() => parseArgs(['--tab']), /missing value/)
  assert.throws(() => parseArgs([...ARGS, '--seed', '-1']), /uint32/)
})

test('makeSchedule is seeded, balanced 15 AB and 15 BA, and fixes two warmup pairs outside the measured set', () => {
  const schedule = makeSchedule(30, 7)
  assert.deepEqual(schedule.warmups, ['AB', 'BA'])
  assert.equal(schedule.measured.length, 30)
  assert.equal(schedule.measured.filter(order => order === 'AB').length, 15)
  assert.equal(schedule.measured.filter(order => order === 'BA').length, 15)
  assert.deepEqual(makeSchedule(30, 7).measured, schedule.measured)
  assert.notDeepEqual(makeSchedule(30, 8).measured, schedule.measured)
})

test('median and bootstrap are deterministic and bracket the median', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.throws(() => median([]), /no values/)
  const deltas = [-5, -3, -2, 1, 2, 4, 6, 7, -1, 0]
  const [low, high] = bootstrapMedianCI(deltas, 99)
  assert.deepEqual(bootstrapMedianCI(deltas, 99), [low, high])
  assert.ok(low <= median(deltas) && median(deltas) <= high)
})

test('summarize excludes warmups, pairs B - A, and refuses incomplete or missing pairs', () => {
  const samples = [
    sample(1, 'A', 'AB', 9999, true), sample(1, 'B', 'AB', 1, true),
    sample(2, 'A', 'AB', 100), sample(2, 'B', 'AB', 80),
    sample(3, 'B', 'BA', 70), sample(3, 'A', 'BA', 100),
    sample(4, 'A', 'AB', 120), sample(4, 'B', 'AB', 90),
  ]
  const summary = summarize(samples, 5)
  assert.equal(summary.n, 3)
  assert.deepEqual(summary.pairs.map(pair => pair.deltaMs), [-20, -30, -30])
  assert.equal(summary.A.n, 3)
  assert.equal(summary.A.medianImageReadyMs, 100)
  assert.equal(summary.B.medianImageReadyMs, 80)
  assert.equal(summary.pairedDeltaMs.median, -30)
  assert.equal(summary.byOrder.AB, -25)
  assert.equal(summary.byOrder.BA, -30)
  assert.ok(summary.pairedDeltaMs.ci95[0] <= -30 && -30 <= summary.pairedDeltaMs.ci95[1])
  assert.throws(() => summarize([sample(1, 'A', 'AB', 1), sample(2, 'A', 'AB', 2), sample(2, 'B', 'AB', 2)], 1), /pair 1 is incomplete/)
  assert.throws(() => summarize([sample(1, 'A', 'AB', 1), sample(1, 'B', 'AB', 2)], 1), /at least two measured pairs/)
})

test('parseTabOutput maps NOTFOUND, AppleEvents errors and window mismatches to failures', () => {
  assert.throws(() => parseTabOutput('NOTFOUND\n'), /not found/)
  assert.throws(() => parseTabOutput('ERROR:-2700:Turned off\n'), /AppleEvents error/)
  assert.throws(() => parseTabOutput('WINDOW:111|"ok"\n', '222'), /expected 222/)
  assert.throws(() => parseTabOutput('whatever'), /unexpected/)
  assert.equal(parseTabOutput('WINDOW:111|{"a":"x|y"}\n', '111'), '{"a":"x|y"}')
})

test('checkOrigin accepts only https fx0 preview hosts under labs.vercel.dev', () => {
  checkOrigin({ protocol: 'https:', hostname: 'fx0-git-esteban-fx0-preview-first-load.labs.vercel.dev' })
  for (const origin of [
    { protocol: 'http:', hostname: 'fx0-a.labs.vercel.dev' },
    { protocol: 'https:', hostname: 'evil.labs.vercel.dev' },
    { protocol: 'https:', hostname: 'fx0-a.example.com' },
  ]) assert.throws(() => checkOrigin(origin), /not an fx0 preview origin/)
})

test('checkProbe requires an unredirected 200 JSON protocol-1 probe for the session with images 0', () => {
  const good = { ok: true, status: 200, type: 'basic', redirected: false, contentType: 'application/json; charset=utf-8', protocol: 1, sessionId: SESSION, revision: 2, sourceLength: 1506, images: 0, sha256: SHA }
  assert.equal(checkProbe(good, SESSION, 2), good)
  assert.throws(() => checkProbe({ ...good, status: 401 }, SESSION), /answered 401/)
  assert.throws(() => checkProbe({ ...good, redirected: true }, SESSION), /answered 200/)
  assert.throws(() => checkProbe({ ...good, contentType: 'text/html' }, SESSION), /not JSON/)
  assert.throws(() => checkProbe({ ...good, sessionId: 'other' }, SESSION), /protocol or session/)
  assert.throws(() => checkProbe({ ...good, revision: 3 }, SESSION, 2), /revision changed/)
  assert.throws(() => checkProbe({ ...good, revision: 0 }, SESSION), /revision changed/)
  assert.throws(() => checkProbe({ ...good, images: 1 }, SESSION), /requires none/)
  assert.throws(() => checkProbe({ ok: false, error: 'network' }, SESSION), /probe failed/)
})

test('checkResources enforces the JSON-first order for A and the direct HTML load for B', () => {
  checkResources([{ format: 'json', session: SESSION }, { format: 'html', session: SESSION }], 'A', SESSION)
  checkResources([{ format: 'html', session: SESSION }], 'B', SESSION)
  assert.throws(() => checkResources([{ format: 'html', session: SESSION }], 'A', SESSION), /requests were html/)
  assert.throws(() => checkResources([{ format: 'json', session: SESSION }, { format: 'html', session: SESSION }], 'B', SESSION), /requests were json,html/)
  assert.throws(() => checkResources([{ format: 'html', session: 'x' }], 'B', SESSION), /wrong session/)
})

test('checkTrial accepts a clean trial and rejects each broken invariant', () => {
  const options = { variant: 'B', session: SESSION, revision: 2, viewport: VIEWPORT }
  assert.equal(checkTrial(trial(), options).imageReadyMs, 120)
  assert.throws(() => checkTrial(trial({ ok: false, error: 'boom' }), options), /failed: boom/)
  assert.throws(() => checkTrial(trial({ errors: 1 }), options), /hydration or runtime errors/)
  assert.throws(() => checkTrial(trial({ paint: { sessionId: SESSION, revision: 1, protocol: 1, updateReady: false } }), options), /wrong revision/)
  assert.throws(() => checkTrial(trial({ viewport: { before: { ...VIEWPORT, visibility: 'hidden' }, after: { ...VIEWPORT, visibility: 'visible' } } }), options), /hidden/)
  assert.throws(() => checkTrial(trial({ viewport: { before: { width: 800, height: 900, visibility: 'visible' }, after: { width: 800, height: 900, visibility: 'visible' } } }), options), /viewport changed/)
  assert.throws(() => checkTrial(trial({ reply: { error: 'too-large', truncated: false, blobs: [] } }), options), /capture failed/)
  assert.throws(() => checkTrial(trial({ reply: { error: null, truncated: false, blobs: [] } }), options), /0 images/)
  assert.throws(() => checkTrial(trial({ reply: { error: null, truncated: false, blobs: Array(9).fill({ type: 'image/png', size: 1, width: 1000, height: 720 }) } }), options), /9 images/)
  assert.throws(() => checkTrial(trial({ reply: { error: null, truncated: false, blobs: [{ type: 'text/html', size: 10, width: 1000, height: 720 }] } }), options), /text\/html/)
  assert.throws(() => checkTrial(trial({ reply: { error: null, truncated: false, blobs: [{ type: 'image/png', size: 601 * 1024, width: 1000, height: 720 }] } }), options), /bytes/)
  assert.throws(() => checkTrial(trial({ reply: { error: null, truncated: false, blobs: [{ type: 'image/png', size: 1, width: 1280, height: 800 }] } }), options), /not 1000x720/)
  assert.throws(() => checkTrial(trial({ readyMs: 130 }), options), /inconsistent timings/)
  assert.throws(() => checkTrial(trial({ resources: [] }), { ...options, variant: 'A' }), /requests were none/)
})

test('stripScripts removes every script tag and keeps the markup the fixture needs', () => {
  const html = '<div id="app"><p>x</p></div><script>window.observed={}</script><script defer src="/bundle.js"></script><style>p{}</style>'
  assert.equal(stripScripts(html), '<div id="app"><p>x</p></div><style>p{}</style>')
})

test('a missing parent resource entry preserves the image, partial clocks and frame navigation diagnosis', async () => {
  let now = 10
  const mountUrl = `/api/artifact-frame?session=${SESSION}&v=2&mount=test`
  const location = { origin: 'https://fx0-test.labs.vercel.dev' }
  const navigation = { name: location.origin + mountUrl, startTime: 0, duration: 80, responseStatus: 200 }
  const front = { getAttribute: () => mountUrl,
    contentWindow: { performance: { timeOrigin: 1000, getEntriesByType: () => [navigation] } } }
  const observed = { paints: [], errors: [] }
  const window = {
    setRevision: () => observed.paints.push({ observedAt: now, sessionId: SESSION, revision: 2, protocol: 1, updateReady: true, mountUrl }),
    captureFrame: async () => ({ blobs: [{ type: 'image/png', size: 30 }], timing: { fontsMs: 0, libraryMs: 2, encodeMs: 1 } }),
  }
  vm.runInNewContext(browserSources.trial({ session: SESSION, revision: 2, expectedRequests: 2 }), {
    window, observed, location, URL, innerWidth: 1440, innerHeight: 900,
    document: { visibilityState: 'visible', querySelector: () => front },
    crypto: { randomUUID: () => 'capture-test' },
    performance: { now: () => now++, clearResourceTimings() {}, getEntriesByType: () => [{
      name: location.origin + `/api/artifact-frame?session=${SESSION}&format=json`, initiatorType: 'fetch', duration: 50, startTime: 1,
    }] },
    createImageBitmap: async () => ({ width: 1000, height: 720, close() {} }),
    requestAnimationFrame: callback => { now += 20_000; callback() }, setTimeout() {},
  })
  await new Promise(resolve => setImmediate(resolve))
  const failed = window.__abTrial
  assert.equal(failed.ok, false)
  assert.match(failed.error, /frame request entries/)
  assert.equal(failed.diagnostics.phase, 'collecting request timings')
  assert.ok(failed.diagnostics.imageReadyMs >= failed.diagnostics.readyMs)
  assert.equal(failed.diagnostics.images[0].size, 30)
  assert.equal(failed.diagnostics.resources.length, 1)
  assert.equal(failed.diagnostics.resources[0].format, 'json')
  assert.equal(failed.diagnostics.frameNavigation[0].responseStatus, 200)
  assert.throws(() => checkTrial(failed, { variant: 'A' }), error => error.diagnostics === failed)
})

test('the DOM bridge executes in the page realm rather than the AppleEvents realm', () => {
  const attributes = new Map()
  const document = {
    documentElement: { setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name) },
    createElement: () => ({ textContent: '', remove() {} }), head: {},
  }
  const page = vm.createContext({ window: {}, document })
  document.head.append = script => vm.runInContext(script.textContent, page)
  const automation = { window: {}, document }
  assert.equal(vm.runInNewContext(pageBridge('window.marker = "page"; "done"'), automation), 'done')
  assert.equal(page.window.marker, 'page')
  assert.equal(automation.window.marker, undefined)
  assert.throws(() => vm.runInNewContext(pageBridge('throw new Error("page failure")'), automation), /page failure/)
  document.head.append = () => {}
  assert.throws(() => vm.runInNewContext(pageBridge('"blocked"'), automation), /Page script did not execute/)
})

test('browser payloads compile as JavaScript without running', () => {
  const sources = {
    info: browserSources.info, ready: browserSources.ready, readProbe: browserSources.readProbe, readTrial: browserSources.readTrial,
    probe: browserSources.probe(SESSION), reset: browserSources.reset('<div id="app"></div>'),
    trial: browserSources.trial({ session: SESSION, revision: 2, expectedRequests: 2 }),
  }
  for (const [name, source] of Object.entries(sources)) new vm.Script(source, { filename: name })
  assert.match(sources.probe, /format=json/)
  assert.match(sources.trial, /revision = 2,/)
  assert.match(sources.trial, /window\.setRevision\(revision\)/)
})
