/**
 * Moving the plan PDF in and out of the project file. `split` keeps the file small and the git
 * history readable; `bundle` does the opposite, for mailing or archiving one self-contained file.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { base64ToBytes } from '../../src/io/base64.ts'
import { serialize } from '../../src/io/projectFile.ts'
import { assetData } from '../../src/model/assets.ts'
import { fail, type Args } from '../args.ts'
import { load, persist } from '../project.ts'

export async function cmdSplit(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project, path, missingAssets } = loaded
  if (missingAssets.length && !Object.values(project.assets).some((a) => a.data)) {
    fail('this file has no PDF inside it and none beside it, so there is nothing to split out')
  }
  const dir = dirname(resolve(path))
  const written: string[] = []
  for (const [id, ref] of Object.entries(project.assets)) {
    const data = ref.data ?? assetData(id)
    if (!data) continue
    const out = join(dir, ref.name)
    if (!existsSync(out)) {
      writeFileSync(out, base64ToBytes(data))
      written.push(ref.name)
    }
  }
  const before = readFileSync(path).length
  await persist(loaded)
  const after = readFileSync(path).length
  console.log(`${basename(path)}: ${(before / 1024 / 1024).toFixed(2)} MB → ${(after / 1024).toFixed(1)} KB`)
  for (const name of written) console.log(`wrote ${name}`)
  if (!written.length) console.log('plan PDF was already beside it')
}

export async function cmdBundle(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project, path, missingAssets } = loaded
  if (missingAssets.length) {
    fail(`cannot bundle: the plan PDF is not beside this file (${missingAssets.map((id) => project.assets[id]?.name).join(', ')})`)
  }
  const out = typeof args.flags.out === 'string'
    ? args.flags.out
    : join(dirname(resolve(path)), basename(path).replace(/\.warren\.json$/i, '') + '.bundle.warren.json')
  writeFileSync(out, serialize(project, { bundle: true }))
  console.log(`wrote ${basename(out)} (${(readFileSync(out).length / 1024 / 1024).toFixed(2)} MB, self-contained)`)
}
