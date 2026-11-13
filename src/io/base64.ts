// The engine's own `Uint8Array.prototype.toBase64`/`fromBase64` (Baseline since 2024) do this in
// native code; TypeScript's lib types do not know them yet, so they are declared here rather
// than left as an `any`. Falling back to the manual chunked encode keeps this working on an
// engine without it - but on one with it, the manual path was the single biggest main-thread
// stall in a profile of loading this project's plan: ~750ms to encode a 19 MB PDF, done with a
// spread into `String.fromCharCode` and `+=` string concatenation, one 32 KB chunk at a time.
declare global {
  interface Uint8Array {
    toBase64?(options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }): string
  }
  interface Uint8ArrayConstructor {
    fromBase64?(base64: string, options?: { alphabet?: 'base64' | 'base64url' }): Uint8Array
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.toBase64) return bytes.toBase64()
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64)
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
