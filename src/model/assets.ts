/**
 * Asset bytes live outside the project file. The project references a PDF by its sha-256 and
 * records enough to go and find it again; the bytes themselves sit in this registry, filled
 * either from a bundled file, from the browser's cache, or from a sidecar file by the CLI.
 *
 * The point is that the project file stays small. A drawing is a few dozen kilobytes of
 * meaning; embedding the plan made it 99.8% base64, which is unreadable to a diff, a grep,
 * a script or a person.
 */

export interface AssetRef {
  /** Original file name, so a missing asset can be described rather than just missed. */
  name: string
  bytes: number
  /** Base64 PDF bytes. Present only in a bundled (self-contained) project file. */
  data?: string
}

const memory = new Map<string, string>()

export function registerAsset(id: string, base64: string): void {
  memory.set(id, base64)
}

export function assetData(id: string): string | undefined {
  return memory.get(id)
}

export function hasAsset(id: string): boolean {
  return memory.has(id)
}

/** Ids referenced by the project whose bytes we do not have. */
export function missingAssetIds(assets: Record<string, AssetRef>): string[] {
  return Object.keys(assets).filter((id) => !memory.has(id))
}

export function describeAsset(assets: Record<string, AssetRef>, id: string): string {
  const ref = assets[id]
  if (!ref) return id.slice(0, 8)
  const mb = ref.bytes ? ` (${(ref.bytes / 1024 / 1024).toFixed(1)} MB)` : ''
  return `${ref.name}${mb}`
}
