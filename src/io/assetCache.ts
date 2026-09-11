import { hasAsset, registerAsset, type AssetRef } from '../model/assets.ts'
import type { Project } from '../model/types.ts'
import { ASSETS, tx } from './db.ts'

/**
 * Keeps PDF bytes in the browser, keyed by content hash, so the project file does not have to
 * carry them. Content-addressed means a cache hit is always the right file - there is no way
 * to be handed the wrong plan without noticing.
 */

export async function cacheAsset(id: string, base64: string): Promise<void> {
  registerAsset(id, base64)
  try {
    await tx(ASSETS, 'readwrite', (s) => s.put(base64, id))
  } catch (err) {
    console.warn('could not cache the plan PDF', err)
  }
}

export async function loadCachedAsset(id: string): Promise<string | undefined> {
  try {
    const data = await tx<string | undefined>(ASSETS, 'readonly', (s) => s.get(id))
    return typeof data === 'string' ? data : undefined
  } catch {
    return undefined
  }
}

/**
 * Fills the in-memory registry for a freshly loaded project, from the file itself if it was
 * bundled, otherwise from the cache. Returns the ids whose bytes are nowhere to be found.
 */
export async function hydrateAssets(project: Project): Promise<string[]> {
  const missing: string[] = []
  for (const [id, ref] of Object.entries(project.assets) as [string, AssetRef][]) {
    if (hasAsset(id)) continue
    if (ref.data) {
      // A bundled file seeds the cache, so the next save can be a small one.
      await cacheAsset(id, ref.data)
      continue
    }
    const cached = await loadCachedAsset(id)
    if (cached) registerAsset(id, cached)
    else missing.push(id)
  }
  return missing
}
