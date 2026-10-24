import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
// @ts-expect-error Node strip-types tests require the source extension.
import { localMode } from './local-mode.ts'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_OUTPUT_CHARS = 24 * 1024
const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.sass', '.less', '.json', '.yaml', '.yml', '.svg', '.html', '.htm'])
const IGNORED = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])

function expand(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function allowedParts(root: string, target: string): boolean {
  return path.relative(root, target).split(path.sep).every(part =>
    !part.startsWith('.') && !IGNORED.has(part) && !/^(?:secrets?|credentials?)(?:[.-]|$)/i.test(part))
}

function textFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) || ['LICENSE', 'NOTICE'].includes(path.basename(file))
}

export function configuredReferenceRoots(): string[] {
  if (!localMode()) return []
  const roots: unknown = JSON.parse(process.env.FX0_REFERENCE_ROOTS || '[]')
  if (!Array.isArray(roots) || roots.length > 16 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(expand(root)))) {
    throw new Error('FX0_REFERENCE_ROOTS must be a JSON array of at most 16 absolute directory paths')
  }
  return [...new Set((roots as string[]).map(root => path.resolve(expand(root))))]
}

async function roots(): Promise<string[]> {
  const configured = configuredReferenceRoots()
  return Promise.all(configured.map(async root => {
    const canonical = await realpath(root)
    if (!(await stat(canonical)).isDirectory()) throw new Error('Reference roots must be directories')
    return canonical
  }))
}

// Validate both the requested path and the resolved path. Aliases cannot expose
// hidden files, ignored directories, or anything outside the configured roots.
async function resolveReference(requested?: string): Promise<{ target: string; roots: string[] }> {
  const permitted = await roots()
  if (!permitted.length) throw new Error('No reference directories are configured')
  if (requested !== undefined && (typeof requested !== 'string' || requested.length > 4096 || requested.includes('\0'))) throw new Error('Invalid reference path')
  const expanded = expand(requested || '.')
  if (!path.isAbsolute(expanded) && permitted.length !== 1) throw new Error('Use an absolute path when multiple reference roots are configured')
  const target = path.resolve(permitted[0], expanded)
  if (!permitted.some(root => inside(root, target) && allowedParts(root, target))) throw new Error('Path is outside readable reference directories')
  const canonical = await realpath(target)
  if (!permitted.some(root => inside(root, canonical) && allowedParts(root, canonical))) throw new Error('Path is outside readable reference directories')
  return { target: canonical, roots: permitted }
}

async function readText(requested: string, signal?: AbortSignal): Promise<{ file: string; text: string }> {
  signal?.throwIfAborted()
  const resolved = await resolveReference(requested)
  if (!textFile(resolved.target)) throw new Error('Only text source, documentation, style, and SVG files are readable')
  const handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    // On this Linux workstation check the actual open descriptor as well, so a
    // directory/symlink swap between realpath and open cannot escape the roots.
    if (process.platform === 'linux') {
      const actual = await realpath(`/proc/self/fd/${handle.fd}`)
      if (!resolved.roots.some(root => inside(root, actual) && allowedParts(root, actual)) || !textFile(actual)) {
        throw new Error('Opened file is outside readable reference directories')
      }
    }
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Reference path must be a regular file')
    if (info.size > MAX_FILE_BYTES) throw new Error('Reference files must be at most 1 MiB')
    // Bounded reads also cover a file growing after stat; never read a device.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > MAX_FILE_BYTES) throw new Error('Reference files must be at most 1 MiB')
    const data = buffer.subarray(0, size)
    if (data.includes(0)) throw new Error('Binary reference files are not readable')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw new Error('Reference file is not UTF-8 text') }
    return { file: resolved.target, text }
  } finally { await handle.close() }
}

function integer(value: unknown, fallback: number, max: number, min = 1): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Expected an integer from ${min} to ${max}`)
  return value as number
}

export async function referenceRoots() {
  return { roots: await roots(), access: 'read-only', formats: 'UTF-8 source, CSS, Markdown, JSON, YAML, HTML, SVG; no binary images', maxFileBytes: MAX_FILE_BYTES }
}

export async function listReferenceFiles(requested?: string, offset?: number, signal?: AbortSignal) {
  const { target, roots: permitted } = await resolveReference(requested)
  const start = integer(offset, 0, 100_000, 0)
  const entries: { name: string; path: string; type: string }[] = []
  let seen = 0
  let truncated = false
  const directory = await opendir(target)
  for await (const entry of directory) {
    signal?.throwIfAborted()
    const file = path.join(target, entry.name)
    if (entry.isSymbolicLink() || !permitted.some(root => inside(root, file) && allowedParts(root, file)) ||
        (!entry.isDirectory() && (!entry.isFile() || !textFile(file)))) continue
    if (seen++ < start) continue
    if (entries.length >= 200) { truncated = true; break }
    entries.push({ name: entry.name, path: file, type: entry.isDirectory() ? 'directory' : 'file' })
  }
  return { directory: target, entries, truncated, nextOffset: truncated ? start + entries.length : null }
}

export async function readReferenceFile(requested: string, startLine?: number, lineCount?: number, signal?: AbortSignal) {
  const start = integer(startLine, 1, 1_000_000)
  const count = integer(lineCount, 200, 400)
  const { file, text } = await readText(requested, signal)
  const lines = text.split(/\r?\n/)
  const selected: string[] = []
  let chars = 0
  for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index++) {
    if (lines[index].length > MAX_OUTPUT_CHARS) throw new Error('Reference line is too long; use a smaller source file')
    if (chars + lines[index].length > MAX_OUTPUT_CHARS) break
    selected.push(lines[index])
    chars += lines[index].length + 1
  }
  const next = start + selected.length
  return { file, startLine: start, totalLines: lines.length, content: selected.map((line, index) => `${start + index}: ${line}`).join('\n'),
    truncated: next <= lines.length, nextLine: next <= lines.length ? next : null }
}

export async function searchReferenceFiles(query: string, requested?: string, signal?: AbortSignal) {
  if (typeof query !== 'string' || !query.trim() || query.length > 256) throw new Error('Search needs 1–256 characters of literal text')
  const { target } = await resolveReference(requested)
  const pending = [target]
  const matches: { file: string; line: number; text: string }[] = []
  let visited = 0
  let skipped = 0
  let chars = 0
  const needle = query.toLowerCase()
  while (pending.length && visited < 2000 && matches.length < 80 && chars < MAX_OUTPUT_CHARS) {
    signal?.throwIfAborted()
    const current = pending.shift()!
    visited++
    try {
      const { target: canonical } = await resolveReference(current)
      if ((await stat(canonical)).isDirectory()) {
        for await (const entry of await opendir(canonical)) {
          signal?.throwIfAborted()
          if (pending.length + visited >= 2000) { skipped++; break }
          const file = path.join(canonical, entry.name)
          if (!entry.isSymbolicLink() && allowedParts(canonical, file) &&
              (entry.isDirectory() || (entry.isFile() && textFile(file)))) pending.push(file)
        }
      } else {
        const { text } = await readText(canonical, signal)
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (!line.toLowerCase().includes(needle)) continue
          const excerpt = line.slice(0, 500)
          if (matches.length >= 80 || chars + excerpt.length > MAX_OUTPUT_CHARS) return { matches, truncated: true, visited, skipped }
          matches.push({ file: canonical, line: index + 1, text: excerpt })
          chars += excerpt.length
        }
      }
    } catch { signal?.throwIfAborted(); skipped++ }
  }
  return { matches, truncated: pending.length > 0 || skipped > 0, visited, skipped }
}
