import type { Project } from '../model/types.ts'
import { ASSETS, LEGACY_DB_NAMES, META, open, openExisting, run, tx } from './db.ts'
import { parseProject } from './projectFile.ts'

const KEY = 'current'

interface MetaRecord {
  savedAt: number
  fileName: string | null
  /** Project JSON. Asset bytes are never in here - they live in the asset cache. */
  body: string
  assetIds: string[]
}

/**
 * Crash net only. The real save is a file on disk - IndexedDB is a bet you should not make
 * for work that has to survive a two-year build. Assets live in their own store so the
 * 30-second write stays small even with a 6 MB PDF in the project.
 */

export async function writeAutosave(project: Project, fileName: string | null): Promise<void> {
  // Asset references are tiny, and the bytes are already in the asset cache, so a 30-second
  // autosave writes kilobytes rather than megabytes.
  const assets = Object.fromEntries(
    Object.entries(project.assets).map(([id, ref]) => [id, { name: ref.name, bytes: ref.bytes }]),
  )
  const body = JSON.stringify({ ...project, assets })
  const record: MetaRecord = { savedAt: Date.now(), fileName, body, assetIds: Object.keys(assets) }
  await tx(META, 'readwrite', (s) => s.put(record, KEY))
}

async function readFrom(db: IDBDatabase): Promise<{ project: Project; fileName: string | null; savedAt: number } | null> {
  const record = await run<MetaRecord | undefined>(db, META, 'readonly', (s) => s.get(KEY))
  if (!record) return null
  const project = parseProject(record.body)
  // Older recovery copies kept the bytes in the assets store; hydrateAssets finds them there
  // either way, since that is the same store the asset cache uses.
  if (db.objectStoreNames.contains(ASSETS)) {
    for (const id of record.assetIds) {
      if (project.assets[id]?.data) continue
      const data = await run<string | undefined>(db, ASSETS, 'readonly', (s) => s.get(id))
      if (typeof data === 'string') project.assets[id] = { ...project.assets[id], data }
    }
  }
  return { project, fileName: record.fileName, savedAt: record.savedAt }
}

export async function readAutosave(): Promise<{ project: Project; fileName: string | null; savedAt: number } | null> {
  try {
    const current = await readFrom(await open())
    if (current) return current
  } catch {
    /* fall through to the legacy databases */
  }
  // A recovery copy written before the app was renamed is still your work.
  for (const name of LEGACY_DB_NAMES) {
    const db = await openExisting(name)
    if (!db) continue
    try {
      const legacy = await readFrom(db)
      if (legacy) return legacy
    } catch {
      /* unreadable old copy; nothing to recover */
    } finally {
      db.close()
    }
  }
  return null
}

export async function clearAutosave(): Promise<void> {
  try {
    await tx(META, 'readwrite', (s) => s.delete(KEY))
  } catch {
    /* nothing to clear */
  }
  for (const name of LEGACY_DB_NAMES) {
    try {
      indexedDB.deleteDatabase(name)
    } catch {
      /* best effort */
    }
  }
}
