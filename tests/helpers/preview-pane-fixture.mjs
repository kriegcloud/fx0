import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Shared by preview-update.browser.mjs and the live browser runner. This module registers no tests.

// Restore the old JSON-first behavior only in a temporary baseline compile. The candidate
// runs the current production component unchanged; no benchmark switch enters production.
export const LEGACY_BASELINE = {
  marker: 'fx0-perf-baseline-json-first',
  from: 'if (!shown) {\n                loadFull(desired);\n                return;\n            }',
  to: '/* fx0-perf-baseline-json-first */',
}

// Observe real window messages without intercepting any production listener or send.
export const OBSERVER = `
window.observed = { paints: [], results: [], boots: [], reports: [], errors: [], frameErrors: [] }
addEventListener('message', event => {
  const frames = [...document.querySelectorAll('#active, #preview-pane iframe')], data = event.data
  if (!data || typeof data !== 'object') return
  const wrapper = frames.find(frame => event.source === frame.contentWindow)
  if (wrapper && event.origin === location.origin) {
    const entry = { ...data, mountUrl: wrapper.getAttribute('src'), observedAt: performance.now() }
    if (data.type === 'fx0-artifact-painted') observed.paints.push(entry)
    if (data.type === 'fx0-preview-result') observed.results.push(entry)
    if (data.type === 'fx0-preview-error') observed.frameErrors.push(entry)
  }
  const frame = frames.find(frame => event.source === frame.contentWindow.frames[0])
  if (frame && data.fixture === 'preview-update') {
    const entry = { ...data, mountUrl: frame.getAttribute('src') }
    if (data.kind === 'boot') observed.boots.push(entry)
    if (data.kind === 'state') { observed.reports.push(entry); if (observed.reports.length > 30) observed.reports.shift() }
    if (data.kind === 'error') observed.errors.push(data.error)
  }
})`

export async function buildPaneFixture(directory, experiment = null, { sessionId = 'preview-browser-session', initialRevision = 101 } = {}) {
  assert.ok(Number.isSafeInteger(initialRevision) && initialRevision >= 0, 'initialRevision is a non-negative integer')
  const output = await realpath(directory), root = fileURLToPath(new URL('../../', import.meta.url))
  // Same narrow compile as html-ui.test.mjs, using this test's Node 24 executable.
  await promisify(execFile)(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig', '--outDir', join(output, 'compiled'), '--strict', '--types', 'node',
    '--jsx', 'react-jsx', '--target', 'esnext', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop', 'components/preview-pane.tsx',
  ], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  if (experiment) {
    // Perf-only: remove the direct-load guard in the temporary legacy baseline, never in production.
    const file = join(output, 'compiled/components/preview-pane.js'), source = await readFile(file, 'utf8')
    assert.equal(source.split(experiment.from).length - 1, 1, 'the baseline matches exactly one compiled guard')
    await writeFile(file, source.replace(experiment.from, experiment.to))
    assert.equal((await readFile(file, 'utf8')).split(experiment.marker).length - 1, 1, 'the baseline marker is unique')
  }
  await writeFile(join(output, 'package.json'), '{"type":"module"}')
  // These controls change only the real component's props. No replacement hooks,
  // updater, transport or slot coordinator is bundled into the fixture.
  await writeFile(join(output, 'pane-fixture.js'), `
import { createElement, useEffect, useState } from 'react'
import PreviewPane from './compiled/components/preview-pane.js'
import { signalAuthRequired } from './compiled/components/auth-ui.js'
import { captureFrame } from './compiled/components/design-capture.js'
export function Fixture() {
  const [revision, setRevision] = useState(${JSON.stringify(initialRevision)}), [viewing, setViewing] = useState(null)
  const [sessionId, setSession] = useState(${JSON.stringify(sessionId)}), [draft, setDraft] = useState(null)
  const [accessAllowed, setAccessAllowed] = useState(true), [capture, setCapture] = useState(null)
  useEffect(() => {
    window.captureResults = []
    window.authErrors = []
    Object.assign(window, { setRevision, setViewing, setSession, setDraft, setAccessAllowed, setCapture, captureFrame, closeAuthGate: signalAuthRequired, fixtureReady: true })
    const revoke = event => { window.authErrors.push(event.detail); setAccessAllowed(false); setRevision(0) }
    window.addEventListener('fx0:auth-required', revoke)
    return () => window.removeEventListener('fx0:auth-required', revoke)
  }, [])
  return createElement(PreviewPane, { source: { kind: 'design', sessionId, revision }, viewing, draft, accessAllowed, intro: false, onClose: () => setRevision(0),
    capture, onCaptureDone: (cid, answered) => { window.captureResults.push({ cid, answered, observedAt: performance.now() }); setCapture(current => current?.cid === cid ? null : current) },
  })
}`)
  await writeFile(join(output, 'pane-entry.js'), `
import { createElement } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { Fixture } from './pane-fixture.js'
const root = hydrateRoot(document.getElementById('app'), createElement(Fixture), { onRecoverableError: error => observed.errors.push(error.message) })
window.unmountFixture = () => root.unmount()
`)
  const { default: bundledWebpack } = await import('../../node_modules/next/dist/compiled/webpack/webpack.js')
  const compiler = bundledWebpack.webpack({
    // Next's packaged webpack references a terser entry absent in this install.
    // Production React is still selected; minification is not under test here.
    mode: 'production', optimization: { minimize: false }, target: 'web', entry: join(output, 'pane-entry.js'),
    output: { path: join(output, 'browser'), filename: 'bundle.js' },
    module: { rules: [{ test: /\.js$/, resolve: { fullySpecified: false } }] },
    resolve: { modules: [join(root, 'node_modules')], extensions: ['.js'], extensionAlias: { '.ts': ['.js'] } },
  })
  try {
    const stats = await promisify(compiler.run.bind(compiler))()
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }))
  } finally { await promisify(compiler.close.bind(compiler))() }

  const outputUrl = pathToFileURL(`${output}/`).href, projectUrl = new URL('../../package.json', import.meta.url).href
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(outputUrl)) return nextResolve(specifier, context)
    if (specifier.startsWith('.')) return nextResolve(/\.js$/.test(specifier) ? specifier : `${specifier.replace(/\.ts$/, '')}.js`, context)
    return nextResolve(specifier, { ...context, parentURL: projectUrl })
  } })
  let markup
  try {
    const [{ Fixture }, { createElement }, { renderToString }] = await Promise.all([
      import(pathToFileURL(join(output, 'pane-fixture.js')).href), import('react'), import('react-dom/server'),
    ])
    markup = renderToString(createElement(Fixture))
  } finally { hooks.deregister() }
  return {
    bundle: await readFile(join(output, 'browser/bundle.js')),
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Real PreviewPane</title><style>
html,body,#app{margin:0;height:100%}#preview-pane{height:100%;display:flex;flex-direction:column}
#preview-pane>div:last-of-type{position:relative;flex:1;min-height:720px}
#preview-pane iframe{position:absolute;inset:0;width:1000px;height:720px;border:0}
#preview-pane iframe[aria-hidden=true]{z-index:0;pointer-events:none}#preview-pane iframe:not([aria-hidden=true]){z-index:1}
.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.flex{display:flex}.flex-1{flex:1}.min-h-0{min-height:0}.z-20{z-index:20}.opacity-0{opacity:0}.bg-background{background:white}
</style></head><body><script>${OBSERVER}</script><div id="app">${markup}</div><script defer src="/bundle.js"></script></body></html>`,
  }
}
