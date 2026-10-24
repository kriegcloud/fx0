import { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// One database per Next process, including across development hot reloads.
const globalDatabase = globalThis as unknown as { __fx0LocalDatabase?: Promise<PGlite> }
export function localDatabase(): Promise<PGlite> {
  return globalDatabase.__fx0LocalDatabase ??= (async () => {
    const db = new PGlite(path.resolve(process.env.FX0_LOCAL_DATA_DIR || '.local', 'postgres'))
    const directory = path.resolve('migrations')
    for (const file of (await readdir(directory)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()) {
      await db.exec(await readFile(path.join(directory, file), 'utf8'))
    }
    return db
  })()
}
