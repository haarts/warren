/** The one IndexedDB database this app uses, shared by the autosave and the asset cache. */

export const DB_NAME = 'warren'
/** Databases from earlier names of this app. Read for recovery, never written to. */
export const LEGACY_DB_NAMES = ['ductwork']
const DB_VERSION = 1
export const META = 'meta'
export const ASSETS = 'assets'

let dbPromise: Promise<IDBDatabase> | null = null

export function open(): Promise<IDBDatabase> {
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
export function openExisting(name: string): Promise<IDBDatabase | null> {
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

export function run<T>(
  db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => run(db, store, mode, fn))
}
