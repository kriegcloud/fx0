import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { configuredReferenceRoots, referenceRoots, listReferenceFiles, readReferenceFile, searchReferenceFiles } from '../lib/reference-files.ts'
import { referenceTools } from '../lib/reference-tools.ts'

const previous = { ...process.env }
let directory, root, outside
test.before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'fx0-references-'))
  root = path.join(directory, 'references')
  outside = path.join(directory, 'references-private')
  for (const dir of [root, outside, path.join(root, 'brand'), path.join(root, '.git'), path.join(root, 'node_modules')]) await mkdir(dir)
  await writeFile(path.join(root, 'brand/tokens.css'), ':root {\n  --brand-primary: #654321;\n  --font-body: sans-serif;\n}\n')
  await writeFile(path.join(outside, 'private.md'), 'outside-private-marker')
  await writeFile(path.join(root, '.env'), 'secret-marker')
  await writeFile(path.join(root, '.git/config'), 'hidden-marker')
  await writeFile(path.join(root, 'credentials.json'), 'credential-marker')
  await writeFile(path.join(root, 'node_modules/hidden.ts'), 'dependency-marker')
  await symlink(path.join(outside, 'private.md'), path.join(root, 'escape.md'))
  await symlink(path.join(root, '.env'), path.join(root, 'alias.md'))
  await symlink(outside, path.join(root, 'linked-directory'))
  process.env.FX0_LOCAL = '1'
  process.env.APP_URL = 'http://127.0.0.1:3000'
  process.env.FX0_REFERENCE_ROOTS = JSON.stringify([root])
  delete process.env.VERCEL
})
test.after(async () => { process.env = previous; await rm(directory, { recursive: true, force: true }) })

test('reference access is opt-in and unavailable outside local mode', async () => {
  assert.deepEqual((await referenceRoots()).roots, [root])
  process.env.FX0_LOCAL = '0'
  try {
    assert.deepEqual(configuredReferenceRoots(), [])
    assert.deepEqual(referenceTools({}), [])
    await assert.rejects(() => readReferenceFile(path.join(root, 'brand/tokens.css')))
  } finally { process.env.FX0_LOCAL = '1' }
  assert.equal((await referenceRoots()).access, 'read-only')
})

test('lists directories and reads numbered source lines with usable pagination', async () => {
  const listing = await listReferenceFiles()
  assert.deepEqual(listing.entries.map(entry => entry.name), ['brand'])
  const first = await readReferenceFile('brand/tokens.css', 1, 2)
  assert.equal(first.content, '1: :root {\n2:   --brand-primary: #654321;')
  assert.equal(first.nextLine, 3)
  assert.equal(first.truncated, true)
  const rest = await readReferenceFile('brand/tokens.css', first.nextLine)
  assert.match(rest.content, /3:   --font-body: sans-serif;/)
  assert.equal(rest.truncated, false)
  assert.equal((await readReferenceFile('brand/tokens.css', 1000)).nextLine, null)
})

test('blocks traversal, prefix siblings, escaped symlinks, and credential aliases', async () => {
  for (const file of [
    '../references-private/private.md', path.join(outside, 'private.md'),
    'escape.md', 'alias.md', 'linked-directory/private.md', '.env', '.git/config', 'credentials.json', 'node_modules/hidden.ts',
  ]) await assert.rejects(() => readReferenceFile(file), file)
  await assert.rejects(() => listReferenceFiles('linked-directory'))
  await assert.rejects(() => searchReferenceFiles('private-marker', outside))
})

test('literal search returns source evidence without hidden or escaped content', async () => {
  const result = await searchReferenceFiles('BRAND-primary')
  assert.deepEqual(result.matches, [{ file: path.join(root, 'brand/tokens.css'), line: 2, text: '  --brand-primary: #654321;' }])
  assert.equal(result.truncated, false)
  for (const query of ['outside-private-marker', 'secret-marker', 'hidden-marker', 'credential-marker', 'dependency-marker', '.*']) {
    assert.deepEqual((await searchReferenceFiles(query)).matches, [], query)
  }
})

test('rejects binaries, special files, invalid paging, oversized files and lines', async () => {
  await writeFile(path.join(root, 'binary.png'), 'fake image')
  await writeFile(path.join(root, 'binary.ts'), Buffer.from([1, 0, 2]))
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([255, 254]))
  await writeFile(path.join(root, 'large.txt'), 'a'.repeat(1024 * 1024 + 1))
  await writeFile(path.join(root, 'long-line.txt'), 'a'.repeat(25 * 1024))
  for (const name of ['binary.png', 'binary.ts', 'invalid.txt', 'large.txt', 'long-line.txt']) await assert.rejects(() => readReferenceFile(name))
  await assert.rejects(() => readReferenceFile('brand'))
  await assert.rejects(() => readReferenceFile('brand/tokens.css', -1))
  await assert.rejects(() => readReferenceFile('brand/tokens.css', 1, 401))
  await assert.rejects(() => listReferenceFiles('.', NaN))
  await assert.rejects(() => searchReferenceFiles(''))
  if (process.platform === 'linux') {
    await promisify(execFile)('mkfifo', [path.join(root, 'fifo.txt')])
    await assert.rejects(() => readReferenceFile('fifo.txt'), /regular file/)
  }
})

test('search and directory enumeration report bounds instead of claiming completeness', async () => {
  await mkdir(path.join(root, 'many'))
  await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(path.join(root, 'many', `${index}.css`), '--token: blue;')))
  const first = await listReferenceFiles('many')
  assert.equal(first.entries.length, 200)
  assert.equal(first.nextOffset, 200)
  const second = await listReferenceFiles('many', first.nextOffset)
  assert.equal(second.entries.length, 5)
  assert.equal(second.truncated, false)
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size, 205)
  const results = await searchReferenceFiles('--token', 'many')
  assert.equal(results.matches.length, 80)
  assert.equal(results.truncated, true)
})

test('registered tools are read-only, store evidence, handle denial and honor cancellation', async () => {
  const records = []
  const tools = referenceTools({ reportInvocation: name => { records.push(name); return 1 }, storeResult: (_id, text) => records.push(JSON.parse(text)) })
  assert.deepEqual(tools.map(tool => tool.name), ['list_reference_roots', 'list_reference_files', 'read_reference_file', 'search_reference_files'])
  assert.ok(tools.every(tool => tool.idempotent && tool.writes === false))
  const read = tools.find(tool => tool.name === 'read_reference_file')
  const ctx = { signal: new AbortController().signal }
  const before = await readFile(path.join(root, 'brand/tokens.css'), 'utf8')
  assert.match((await read.execute({ path: 'brand/tokens.css' }, ctx)).content, /#654321/)
  assert.equal(await readFile(path.join(root, 'brand/tokens.css'), 'utf8'), before)
  assert.equal(records[0], 'read_reference_file')
  assert.match((await read.execute({ path: '../references-private/private.md' }, ctx)).error, /Reference unavailable/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => read.execute({ path: 'brand/tokens.css' }, { signal: controller.signal }), { name: 'AbortError' })
})
