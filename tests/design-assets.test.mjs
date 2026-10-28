import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localDesignAssetStore } from '../lib/local-design-assets.ts'

// design-assets keeps its manifest in the chat journal; here that is an in-memory map,
// and the Blob store is a fake passed in, so no network or Redis is involved.
const manifests = new Map()
const jobs = new Map()
const completed = new Set()
const calls = []
const journal = { manifests, jobs, completed, calls }
globalThis.__assetJournal = journal
test.beforeEach(() => {
  manifests.clear(); jobs.clear(); completed.clear(); calls.length = 0
  journal.reserve = async (...args) => { calls.push(['reserve', ...args]); return 'ok' }
  journal.record = async (id, assets) => {
    const map = manifests.get(id) ?? new Map()
    for (const a of assets) map.set(a.handle, { mimeType: a.mimeType, bytes: a.bytes })
    manifests.set(id, map)
  }
  journal.queue = async (job) => { if (!completed.has(JSON.stringify(job))) jobs.set(JSON.stringify(job), job) }
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './journal' && context.parentURL?.endsWith('/lib/design-assets.ts')) {
      return { url: `data:text/javascript,${encodeURIComponent(`
        const j = globalThis.__assetJournal
        export const recordDesignAssets = (...args) => j.record(...args)
        export async function readDesignAssets(id, handles) { const map = j.manifests.get(id) ?? new Map(); return new Map([...map].filter(([h]) => !handles || handles.includes(h))) }
        export const MAX_CHAT_ASSETS = 50
        export const MAX_DAILY_ASSETS = 100
        export const reserveDesignAssets = (...args) => j.reserve(...args)
        export async function releaseDesignAssets(...args) { j.calls.push(['release', ...args]) }
        export const queueDesignAssetCleanup = (...args) => j.queue(...args)
        export async function pendingDesignAssetCleanups() { return [...j.jobs.values()] }
        export async function forgetDesignAssets(id, handles) { for (const h of handles) j.manifests.get(id)?.delete(h) }
        export async function finishDesignAssetCleanup(job) {
          if (j.completed.has(JSON.stringify(job))) return
          j.completed.add(JSON.stringify(job))
          j.jobs.delete(JSON.stringify(job))
          await forgetDesignAssets(job.sessionId, job.handles)
          await releaseDesignAssets(job.sessionId, job.userId, job.handles.length, job.reservedAt)
        }
      `)}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

process.env.SESSION_SECRET ??= 'deterministic-design-assets-test-secret-32+'
const { storeDesignAssets, readDesignAsset, deleteDesignAssets, retryDesignAssetCleanup, DesignAssetLimitError } = await import('../lib/design-assets.ts')
const { validateDesignArtifactHtml, rewriteRemoteImages, BLANK_IMAGE } = await import('../lib/design-artifact.ts')
const { markRemoteImages } = await import('../lib/remote-image.ts')
const { artifactImageSrc, verifyArtifactImage } = await import('../lib/artifact-image.ts')

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const CHAT = '11111111-1111-4111-8111-111111111111'
const USER = 'user_a'
const HANDLE = 'AbCdEfGhIjKlMnOpQrStUvWx'
const doc = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

test('local mode stores and reloads private attachments without Blob credentials and deletes only the selected chat', async () => {
  const previous = { ...process.env }
  const dir = await mkdtemp(join(tmpdir(), 'fx0-local-assets-'))
  try {
    process.env.FX0_LOCAL = '1'
    process.env.APP_URL = 'http://127.0.0.1:3000'
    process.env.FX0_LOCAL_DATA_DIR = dir
    delete process.env.VERCEL
    delete process.env.BLOB_READ_WRITE_TOKEN
    const image = { type: 'image', data: PNG, mimeType: 'image/png' }
    const handles = await storeDesignAssets(CHAT, USER, [image, image])
    const otherChat = '22222222-2222-4222-8222-222222222222'
    const [other] = await storeDesignAssets(otherChat, USER, [image])
    assert.equal((await stat(join(dir, 'assets'))).mode & 0o777, 0o700)
    for (const handle of handles) {
      assert.equal((await stat(join(dir, 'assets', `${CHAT}-${handle}`))).mode & 0o777, 0o600)
      // A new store instance proves bytes survive beyond the uploading instance.
      const saved = await readDesignAsset(CHAT, handle, localDesignAssetStore())
      assert.equal(saved.bytes.toString('base64'), PNG)
      assert.equal(saved.mimeType, 'image/png')
      assert.equal(await readDesignAsset(otherChat, handle), null)
    }
    const store = localDesignAssetStore()
    const first = await store.list({ prefix: `chats/${CHAT}/`, limit: 1 })
    const second = await store.list({ prefix: `chats/${CHAT}/`, cursor: first.cursor, limit: 1 })
    assert.equal(first.hasMore, true)
    assert.equal(second.hasMore, false)
    assert.equal(new Set([...first.blobs, ...second.blobs].map(blob => blob.pathname)).size, 2)
    await deleteDesignAssets(CHAT)
    assert.deepEqual(await readdir(join(dir, 'assets')), [`${otherChat}-${other}`])
    assert.equal((await readDesignAsset(otherChat, other)).bytes.toString('base64'), PNG)
    await deleteDesignAssets(CHAT) // Idempotent cleanup of already-removed files.
  } finally {
    process.env = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('local image paths cannot traverse directories or read symbolic links', async () => {
  const previous = process.env.FX0_LOCAL_DATA_DIR
  const dir = await mkdtemp(join(tmpdir(), 'fx0-local-assets-paths-'))
  try {
    process.env.FX0_LOCAL_DATA_DIR = dir
    const store = localDesignAssetStore()
    const options = { access: 'private', contentType: 'image/png', addRandomSuffix: false }
    const pathname = `chats/${CHAT}/${HANDLE}`
    await store.put(pathname, Buffer.from(PNG, 'base64'), options)
    for (const invalid of ['../outside', `chats/${CHAT}/../outside`, `${pathname}/extra`, '/tmp/outside']) {
      await assert.rejects(store.put(invalid, Buffer.from('no'), options), /Invalid local image path/)
      await assert.rejects(store.get(invalid, { access: 'private' }), /Invalid local image path/)
      await assert.rejects(store.del([pathname, invalid]), /Invalid local image path/)
    }
    assert.ok(await store.get(pathname, { access: 'private' }), 'invalid deletion batch must not delete valid files')
    await assert.rejects(store.list({ prefix: '../', limit: 1000 }), /Invalid local image prefix/)
    await store.del([pathname])
    await writeFile(join(dir, 'outside'), 'private')
    await symlink(join(dir, 'outside'), join(dir, 'assets', `${CHAT}-${HANDLE}`))
    await assert.rejects(store.get(pathname, { access: 'private' }), { code: 'ELOOP' })
    await store.del([pathname])
    assert.equal(await store.get(pathname, { access: 'private' }), null)
  } finally {
    if (previous === undefined) delete process.env.FX0_LOCAL_DATA_DIR
    else process.env.FX0_LOCAL_DATA_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

function fakeStore({ failOn = -1 } = {}) {
  const files = new Map()
  let puts = 0
  return {
    files,
    async put(pathname, body, options) {
      if (puts++ === failOn) throw new Error('blob down')
      assert.equal(options.access, 'private')
      assert.equal(options.addRandomSuffix, false)
      files.set(pathname, { body: Buffer.from(body), contentType: options.contentType })
      return { pathname }
    },
    async get(pathname) {
      const file = files.get(pathname)
      return file ? { statusCode: 200, stream: new Blob([file.body]).stream() } : null
    },
    async del(pathnames) { for (const pathname of [pathnames].flat()) files.delete(pathname) },
    async list({ prefix, cursor }) {
      const all = [...files.keys()].filter((pathname) => pathname.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const blobs = all.slice(start, start + 2).map((pathname) => ({ pathname }))
      return { blobs, hasMore: start + 2 < all.length, cursor: String(start + 2) }
    },
  }
}

test('a message\'s images are stored privately and recorded for the chat, all or none', async () => {
  manifests.clear()
  const store = fakeStore()
  const images = [{ type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'image', data: PNG, mimeType: 'image/png' }]
  const handles = await storeDesignAssets(CHAT, USER, images, store)
  assert.equal(handles.length, 2)
  for (const handle of handles) {
    assert.match(handle, /^[A-Za-z0-9_-]{24}$/)
    assert.equal(store.files.get(`chats/${CHAT}/${handle}`).contentType, 'image/png')
  }
  assert.deepEqual([...manifests.get(CHAT).keys()].sort(), [...handles].sort())

  manifests.clear()
  const failing = fakeStore({ failOn: 1 })
  await assert.rejects(storeDesignAssets(CHAT, USER, images, failing), /Unable to store/)
  assert.equal(failing.files.size, 0, 'the image that was stored is removed again')
  assert.equal(manifests.size, 0, 'nothing is recorded')
})

test('the chat and daily caps are taken before anything is stored, and given back if storing fails', async () => {
  manifests.clear()
  const image = { type: 'image', data: PNG, mimeType: 'image/png' }
  for (const [limit, message] of [['chat', /already has its 50 attached images/], ['daily', /up to 100 images a day/]]) {
    const store = fakeStore()
    calls.length = 0
    journal.reserve = async (...args) => { calls.push(['reserve', ...args]); return limit }
    await assert.rejects(storeDesignAssets(CHAT, USER, [image, image], store), (error) => error instanceof DesignAssetLimitError && message.test(error.message))
    assert.equal(store.files.size, 0, 'nothing stored past a cap')
    assert.deepEqual(calls.map((call) => call.slice(0, 4)), [['reserve', CHAT, USER, 2]])
  }
  calls.length = 0
  journal.reserve = async (...args) => { calls.push(['reserve', ...args]); return 'ok' }
  await assert.rejects(storeDesignAssets(CHAT, USER, [image, image], fakeStore({ failOn: 0 })), /Unable to store/)
  assert.deepEqual(calls.map((call) => call.slice(0, 4)), [['reserve', CHAT, USER, 2], ['release', CHAT, USER, 2]])
  assert.equal(calls[0][4], calls[1][4], 'the refund uses the reservation day')
})

test('an image is read only for the chat that received it', async () => {
  manifests.clear()
  const store = fakeStore()
  const [handle] = await storeDesignAssets(CHAT, USER, [{ type: 'image', data: PNG, mimeType: 'image/png' }], store)
  const image = await readDesignAsset(CHAT, handle, store)
  assert.deepEqual({ mimeType: image.mimeType, bytes: image.bytes.toString('base64') }, { mimeType: 'image/png', bytes: PNG })
  assert.equal(await readDesignAsset('22222222-2222-4222-8222-222222222222', handle, store), null)
  assert.equal(await readDesignAsset(CHAT, HANDLE, store), null)
})

test('deleting a chat removes all its files, page by page, and no other chat\'s', async () => {
  manifests.clear()
  const store = fakeStore()
  const image = { type: 'image', data: PNG, mimeType: 'image/png' }
  await storeDesignAssets(CHAT, USER, [image, image, image, image, image], store)
  const [other] = await storeDesignAssets('33333333-3333-4333-8333-333333333333', USER, [image], store)
  await deleteDesignAssets(CHAT, store)
  assert.deepEqual([...store.files.keys()], [`chats/33333333-3333-4333-8333-333333333333/${other}`])
})

test('a failed manifest write rolls back every attempted file and refunds only after removal', async () => {
  const store = fakeStore()
  const record = journal.record
  journal.record = async (...args) => { await record(...args); throw new Error('manifest response lost') }
  const image = { type: 'image', data: PNG, mimeType: 'image/png' }
  await assert.rejects(storeDesignAssets(CHAT, USER, [image, image], store), /manifest response lost/)
  assert.equal(store.files.size, 0)
  assert.equal(manifests.get(CHAT).size, 0, 'an ambiguously committed manifest is removed too')
  assert.equal(jobs.size, 0)
  assert.equal(calls.filter(([name]) => name === 'release').length, 1)
})

test('a put with a lost response is removed along with its successful siblings', async () => {
  const store = fakeStore()
  const put = store.put
  store.put = async (...args) => { await put(...args); throw new Error('put response lost') }
  const image = { type: 'image', data: PNG, mimeType: 'image/png' }
  await assert.rejects(storeDesignAssets(CHAT, USER, [image, image], store), /Unable to store/)
  assert.equal(store.files.size, 0)
  assert.equal(jobs.size, 0)
})

test('a refused late manifest commit removes uploads that completed after chat deletion', async () => {
  const store = fakeStore()
  let finishUpload
  const wait = new Promise((resolve) => { finishUpload = resolve })
  let uploadStarted
  const started = new Promise((resolve) => { uploadStarted = resolve })
  const put = store.put
  store.put = async (...args) => { uploadStarted(); await wait; return put(...args) }
  let deleted = false
  journal.record = async () => { assert.equal(deleted, true); throw new Error('chat deleted') }
  const pending = storeDesignAssets(CHAT, USER, [{ type: 'image', data: PNG, mimeType: 'image/png' }], store)
  const refused = assert.rejects(pending, /chat deleted/)
  await started
  deleted = true
  await deleteDesignAssets(CHAT, store)
  finishUpload()
  await refused
  assert.equal(store.files.size, 0)
  assert.equal(manifests.size, 0)
})

test('failed physical rollback keeps a durable retry and its quota until cleanup succeeds once', async (t) => {
  t.mock.method(console, 'error', () => {})
  const store = fakeStore()
  journal.record = async () => { throw new Error('manifest unavailable') }
  const del = store.del
  store.del = async () => { throw new Error('blob deletion unavailable') }
  const image = { type: 'image', data: PNG, mimeType: 'image/png' }
  await assert.rejects(storeDesignAssets(CHAT, USER, [image], store), /manifest unavailable/)
  assert.equal(store.files.size, 1)
  assert.equal(jobs.size, 1)
  assert.equal(calls.some(([name]) => name === 'release'), false)
  await retryDesignAssetCleanup(store)
  assert.equal(jobs.size, 1, 'an unsuccessful retry does not lose its durable record')
  store.del = del
  await Promise.all([retryDesignAssetCleanup(store), retryDesignAssetCleanup(store)])
  assert.equal(store.files.size, 0)
  assert.equal(jobs.size, 0)
  assert.equal(calls.filter(([name]) => name === 'release').length, 1)
})

test('a Redis outage cannot prevent immediate removal of files after a failed manifest write', async (t) => {
  t.mock.method(console, 'error', () => {})
  const store = fakeStore()
  journal.record = async () => { throw new Error('Redis unavailable') }
  journal.queue = async () => { throw new Error('Redis unavailable') }
  await assert.rejects(storeDesignAssets(CHAT, USER, [{ type: 'image', data: PNG, mimeType: 'image/png' }], store), /Redis unavailable/)
  assert.equal(store.files.size, 0)
  assert.equal(calls.filter(([name]) => name === 'release').length, 1)
})

test('a lost cleanup enqueue response cannot refund a rollback twice', async (t) => {
  t.mock.method(console, 'error', () => {})
  const store = fakeStore()
  journal.record = async () => { throw new Error('manifest unavailable') }
  const queue = journal.queue
  journal.queue = async (job) => { await queue(job); throw new Error('enqueue response lost') }
  await assert.rejects(storeDesignAssets(CHAT, USER, [{ type: 'image', data: PNG, mimeType: 'image/png' }], store), /manifest unavailable/)
  journal.queue = queue
  await retryDesignAssetCleanup(store)
  assert.equal(store.files.size, 0)
  assert.equal(jobs.size, 0)
  assert.equal(calls.filter(([name]) => name === 'release').length, 1)
})

test('a design may name an attached image wherever it may name an image, even with remote images off', () => {
  for (const body of [
    `<img src="fx0-asset:${HANDLE}" alt="">`,
    `<img srcset="fx0-asset:${HANDLE} 2x" alt="">`,
    `<video poster="fx0-asset:${HANDLE}"></video>`,
    `<svg><image href="fx0-asset:${HANDLE}"/></svg>`,
  ]) {
    assert.equal(validateDesignArtifactHtml(doc(body), { remoteImages: false }).ok, true, body)
  }
  assert.equal(validateDesignArtifactHtml(doc('<img src="fx0-asset:short" alt="">')).ok, false)
  assert.equal(validateDesignArtifactHtml(doc(`<script src="fx0-asset:${HANDLE}"></script>`)).ok, false)
})

test('preparation marks attached images like remote ones; with remote images off only attached ones remain', () => {
  const html = doc(`<img src="fx0-asset:${HANDLE}"><img src="https://example.com/a.png">`, `<style>.a{background:url(fx0-asset:${HANDLE})}</style>`)
  const nonce = '0123456789abcdef0123456789abcdef'
  const marked = markRemoteImages(html, nonce)
  assert.deepEqual(marked.images.map(({ url }) => url), [`fx0-asset:${HANDLE}`, 'https://example.com/a.png'])
  assert.equal(marked.html.split(`fx0-image-${nonce}-0`).length - 1, 2)
  const local = markRemoteImages(html, nonce, { remote: false })
  assert.deepEqual(local.images.map(({ url }) => url), [`fx0-asset:${HANDLE}`])
  assert.ok(local.html.includes(`<img src="${BLANK_IMAGE}">`), 'the remote one is blank')
})

test('returning null leaves a reference as written, so an export can embed only attached images', () => {
  const html = doc(`<img src="fx0-asset:${HANDLE}"><img src="https://example.com/a.png">`)
  const data = `data:image/png;base64,${PNG}`
  const out = rewriteRemoteImages(html, (reference) => reference.startsWith('fx0-asset:') ? data : null)
  assert.ok(out.includes(`<img src="${data}">`))
  assert.ok(out.includes('<img src="https://example.com/a.png">'))
})

test('the image route signs attached-image references per chat', () => {
  const reference = `fx0-asset:${HANDLE}`
  const sig = new URL(artifactImageSrc(CHAT, reference), 'https://fx0.example').searchParams.get('sig')
  assert.equal(verifyArtifactImage(CHAT, reference, sig), reference)
  assert.equal(verifyArtifactImage('22222222-2222-4222-8222-222222222222', reference, sig), null)
  assert.equal(verifyArtifactImage(CHAT, 'fx0-asset:short', sig), null)
})
