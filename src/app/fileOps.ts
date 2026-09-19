/**
 * Opening, saving and exporting the project file - new/open/save/save-as, the autosave crash
 * net, and the self-contained bundle a plain save deliberately leaves the plan PDF out of.
 */
import { clearAutosave, readAutosave, writeAutosave } from '../io/autosave.ts'
import { hydrateAssets } from '../io/assetCache.ts'
import {
  parseProject, pickOpenFile, pickSaveTarget, projectNameFromFileName,
  serialize, suggestedFileName, writeTo, type SaveTarget,
} from '../io/projectFile.ts'
import { emptyProject } from '../model/doc.ts'
import { confirmDialog, guarded } from '../ui/modal.ts'
import { ensurePlanPdfOnDisk, locateMissingAssets, refit } from './pdfOps.ts'
import type { App } from '../app.ts'

export async function newProject(app: App): Promise<void> {
  if (app.store.dirty && !(await confirmDialog('Discard changes?', 'The current project has unsaved changes.', 'Discard'))) return
  app.store.loadProject(emptyProject(), null)
  app.saveTarget = null
  await clearAutosave()
  refit(app)
}

export async function openProject(app: App): Promise<void> {
  if (app.store.dirty && !(await confirmDialog('Discard changes?', 'The current project has unsaved changes.', 'Discard'))) return
  await guarded('Could not open that file', async () => {
    const picked = await pickOpenFile()
    if (!picked) return
    const text = await picked.file.text()
    const project = parseProject(text)
    const missing = await hydrateAssets(project)
    app.store.loadProject(project, picked.file.name)
    // A bundled file carries its own bytes, so they are now cached and the next save is small.
    for (const id of Object.keys(project.assets)) {
      if (project.assets[id].data) app.exportedAssets.add(id)
    }
    if (missing.length) void locateMissingAssets(app, project, missing)
    app.saveTarget = picked.handle ? { handle: picked.handle, name: picked.file.name } : null
    await clearAutosave()
    refit(app)
  })
}

export async function save(app: App): Promise<void> {
  if (app.session) {
    await app.session.flush(app.store.project)
    app.store.dirty = false
    app.editor.flash('Saved')
    return
  }
  if (!app.saveTarget) return saveAs(app)
  await writeProject(app, app.saveTarget)
}

export async function saveAs(app: App): Promise<void> {
  const target = await pickSaveTarget(suggestedFileName(app.store.project.name))
  if (!target) return
  app.saveTarget = target
  // "Save as" is how most people expect to name an untitled document, so adopt the file name -
  // but never overwrite a title the user has deliberately set.
  if (app.store.project.name === 'Untitled') {
    const derived = projectNameFromFileName(target.name)
    if (derived !== 'Untitled') app.store.mutate(() => { app.store.project.name = derived })
  }
  await writeProject(app, target)
}

export function renameProject(app: App, name: string): void {
  const clean = name.trim()
  if (!clean || clean === app.store.project.name) {
    app.refresh()
    return
  }
  app.store.mutate(() => { app.store.project.name = clean })
}

/**
 * Writes the project without the PDF inside it. The plan is 99.8% of a bundled file's bytes and
 * none of its meaning, so keeping it out is what makes the file diffable, greppable and readable
 * by anything that is not this app.
 */
async function writeProject(app: App, target: SaveTarget): Promise<void> {
  await guarded('Save failed', async () => {
    await writeTo(target, serialize(app.store.project))
    await ensurePlanPdfOnDisk(app)
    app.store.dirty = false
    app.store.fileName = target.name
    await clearAutosave()
    app.editor.flash(target.handle
      ? `Saved ${target.name}`
      : `Downloaded ${target.name} — this browser cannot write over an existing file`)
    app.refresh()
  })
}

/** One self-contained file, PDF included - for mailing or archiving, not for everyday saving. */
export async function exportBundle(app: App): Promise<void> {
  const name = suggestedFileName(app.store.project.name).replace(/\.json$/, '.bundle.json')
  const target = await pickSaveTarget(name)
  if (!target) return
  await guarded('Export failed', async () => {
    await writeTo(target, serialize(app.store.project, { bundle: true }))
    app.editor.flash(`Wrote ${target.name} with the plan PDF inside it`)
  })
}

export async function autosave(app: App): Promise<void> {
  if (!app.store.dirty) return
  try {
    await writeAutosave(app.store.project, app.store.fileName)
  } catch (err) {
    console.warn('autosave failed', err)
  }
}

export async function offerRestore(app: App): Promise<void> {
  let found: Awaited<ReturnType<typeof readAutosave>> = null
  try {
    found = await readAutosave()
  } catch {
    return
  }
  if (!found) return
  const when = new Date(found.savedAt).toLocaleString()
  const restore = await confirmDialog(
    'Restore unsaved work?',
    `A recovery copy from ${when} was found${found.fileName ? ` (${found.fileName})` : ''}. ` +
    'This is the crash net, not your saved file — restore it, then save to disk straight away.',
    'Restore',
  )
  if (restore) {
    await hydrateAssets(found.project)
    app.store.loadProject(found.project, found.fileName)
    app.store.dirty = true
    app.editor.invalidateBackground()
  } else {
    await clearAutosave()
  }
}

export function attachUnloadGuard(app: App): void {
  window.addEventListener('beforeunload', (e) => {
    if (!app.store.dirty) return
    e.preventDefault()
    e.returnValue = ''
  })
}
