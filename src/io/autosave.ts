import type { Project } from '../model/types.ts'
import { parseProject } from './projectFile.ts'

/**
 * Crash net only. The real save is a file on disk - IndexedDB is a bet you should not make
 * for work that has to survive a two-year build. Assets live in their own store so the
 * 30-second write stays small even with a 6 MB PDF in the project.
 */

const DB_NAME = 'warren'
/** Databases from earlier names of this app. Read for recovery, never written to. */
const LEGACY_DB_NAMES = ['ductwork']
const DB_VERSION = 1
const META = 'meta'
const ASSETS = 'assets'
const KEY = 'current'

interface MetaRecord {
  savedAt: number
  fileName: string | null
  /** Project JSON with `assets` emptied out. */
  body: string
  assetIds: string[]
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
        if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

/**
 * Opens a database only if it already exists, so probing an old name cannot conjure an empty
 * one into being. If the open triggers an upgrade, the database was not there.
 */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let existed = true
    const req = indexedDB.open(name)
    req.onupgradeneeded = () => { existed = false }
    req.onsuccess = () => {
      const db = req.result
      if (!existed || !db.objectStoreNames.contains(META)) {
        db.close()
        indexedDB.deleteDatabase(name)
        resolve(null)
        return
      }
      resolve(db)
    }
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

function run<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => run(db, store, mode, fn))
}

export async function writeAutosave(project: Project, fileName: string | null): Promise<void> {
  const assetIds = Object.keys(project.assets)
  const body = JSON.stringify({ ...project, assets: {} })
  const known = new Set(await listAssetIds())
  for (const id of assetIds) {
    if (!known.has(id)) await tx(ASSETS, 'readwrite', (s) => s.put(project.assets[id], id))
  }
  const record: MetaRecord = { savedAt: Date.now(), fileName, body, assetIds }
  await tx(META, 'readwrite', (s) => s.put(record, KEY))
}

async function listAssetIds(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>(ASSETS, 'readonly', (s) => s.getAllKeys())
  return keys.map(String)
}

async function readFrom(db: IDBDatabase): Promise<{ project: Project; fileName: string | null; savedAt: number } | null> {
  const record = await run<MetaRecord | undefined>(db, META, 'readonly', (s) => s.get(KEY))
  if (!record) return null
  const project = parseProject(record.body)
  const hasAssets = db.objectStoreNames.contains(ASSETS)
  for (const id of record.assetIds) {
    if (!hasAssets) break
    const data = await run<string | undefined>(db, ASSETS, 'readonly', (s) => s.get(id))
    if (typeof data === 'string') project.assets[id] = data
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
