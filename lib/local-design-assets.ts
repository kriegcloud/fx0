import { constants } from 'node:fs'
import { mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DesignAssetStore } from './design-assets'

const CHAT = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}'
const ASSET = new RegExp(`^chats/(${CHAT})/([A-Za-z0-9_-]{24})$`)
const PREFIX = new RegExp(`^chats/(${CHAT})/$`)
const HANDLE = /^[A-Za-z0-9_-]{24}$/
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

// The Redis manifest remains the access check and source of MIME metadata.
// Files are private, flat, and scoped by chat; no path supplied by a model is
// ever treated as a filesystem path. Nothing is exposed in Next's public dir.
export function localDesignAssetStore(): DesignAssetStore {
  const root = path.resolve(process.env.FX0_LOCAL_DATA_DIR || '.local', 'assets')
  const filename = (pathname: string) => {
    const match = ASSET.exec(pathname)
    if (!match) throw new Error('Invalid local image path')
    return path.join(root, `${match[1]}-${match[2]}`)
  }
  return {
    async put(pathname, body) {
      const file = filename(pathname)
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(file, body, { flag: 'wx', mode: 0o600 })
    },
    async get(pathname) {
      const file = filename(pathname)
      try {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const bytes = await handle.readFile()
          return { statusCode: 200, stream: new Blob([new Uint8Array(bytes)]).stream() }
        } finally { await handle.close() }
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },
    async del(pathnames) {
      // Validate the entire batch before deleting any file.
      const files = pathnames.map(filename)
      await Promise.all(files.map(async file => {
        try { await unlink(file) } catch (error) { if (!missing(error)) throw error }
      }))
    },
    async list({ prefix, cursor, limit }) {
      const match = PREFIX.exec(prefix)
      if (!match) throw new Error('Invalid local image prefix')
      const start = cursor === undefined ? 0 : Number(cursor)
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid local image page')
      let entries
      try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
        if (missing(error)) return { blobs: [], hasMore: false }
        throw error
      }
      const stem = `${match[1]}-`
      const names = entries.filter(entry => entry.isFile() && entry.name.startsWith(stem) && HANDLE.test(entry.name.slice(stem.length)))
        .map(entry => `${prefix}${entry.name.slice(stem.length)}`).sort()
      const end = start + limit
      return { blobs: names.slice(start, end).map(pathname => ({ pathname })), hasMore: end < names.length, cursor: String(end) }
    },
  }
}
