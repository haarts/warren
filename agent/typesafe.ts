import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TypeSafeClient } from '@typesafe-ai/sdk'

/**
 * The TypeSafe side of the tool: one client, one model, one place a key comes from.
 *
 * The key is read from the environment first, so a machine or CI can keep it out of the tree.
 * A key written to `typesafe.key` beside the repository is the convenience for a person; that
 * file must never be committed.
 */

const here = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = resolve(here, '..', 'typesafe.key')

export function apiKey(): string {
  const fromEnv = process.env.TYPESAFE_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  if (existsSync(KEY_FILE)) {
    const fromFile = readFileSync(KEY_FILE, 'utf8').trim()
    if (fromFile) return fromFile
  }
  throw new Error(
    'no TypeSafe API key: set TYPESAFE_API_KEY, or put one in typesafe.key',
  )
}

/** `jev-latest` tracks the newest System One model; the SDK default is the same thing. */
export const MODEL = process.env.TYPESAFE_MODEL?.trim() || 'jev-latest'

export function typesafe(): TypeSafeClient {
  return new TypeSafeClient({ apiKey: apiKey(), defaultModel: MODEL })
}

export type { TypeSafeClient }
