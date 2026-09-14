import { registerAsset } from '../model/assets.ts'
import { bytesToBase64 } from './base64.ts'
import { parseProject, serialize } from './projectFile.ts'
import type { Project } from '../model/types.ts'

/**
 * Talks to `warren serve`, which holds the project so that the person in this window and
 * whatever is at the command line are looking at the same drawing rather than two copies.
 *
 * When nothing is serving, none of this runs and the app behaves exactly as it always has:
 * open a file, save a file.
 */

export const isServed = (): boolean =>
  (window as unknown as { __warrenServed?: boolean }).__warrenServed === true

export interface SessionHandlers {
  /** The drawing changed underneath us and has to be taken again. */
  onChanged: (project: Project, rev: number) => void
  /** Somebody is pointing at something. Changes nothing. */
  onSelect: (ids: string[], zoom: boolean, say: string | null) => void
  onStatus: (text: string) => void
}

export class Session {
  rev = 0
  name = ''
  /** Identifies this window to the server, so it can tell our own changes from anyone else's. */
  private readonly id = `w${Math.random().toString(36).slice(2, 10)}`
  private saveTimer: number | null = null
  private saving = false
  private pending = false
  private latest: Project | null = null

  constructor(private handlers: SessionHandlers) {}

  async load(): Promise<{ project: Project; name: string }> {
    const res = await fetch('/api/project')
    if (!res.ok) throw new Error(`the server would not hand over the project (${res.status})`)
    const body = await res.json() as { rev: number; name: string; project: unknown }
    this.rev = body.rev
    this.name = body.name
    const project = parseProject(JSON.stringify(body.project))
    await this.fetchAssets(project)
    return { project, name: body.name }
  }

  /** The plan PDF comes from the server too, so this browser need never have seen it. */
  private async fetchAssets(project: Project): Promise<void> {
    for (const id of Object.keys(project.assets)) {
      if (project.assets[id].data) continue
      try {
        const res = await fetch(`/api/asset/${id}`)
        if (!res.ok) continue
        registerAsset(id, bytesToBase64(new Uint8Array(await res.arrayBuffer())))
      } catch {
        // The drawing opens without it; only the plan underneath is missing.
      }
    }
  }

  listen(): void {
    const source = new EventSource('/api/events')
    source.addEventListener('changed', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { rev: number; source: string; by: string | null }
      // Our own save comes back to us. Comparing revisions cannot tell the difference, because
      // the server broadcasts before our POST has returned - so it is told by name instead.
      // Reloading our own change would race with anything typed since, and lose it.
      if (data.by === this.id) {
        this.rev = Math.max(this.rev, data.rev)
        return
      }
      if (data.rev <= this.rev) return
      void this.reload(data.source)
    })
    source.addEventListener('select', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { ids: string[]; zoom: boolean; say: string | null }
      this.handlers.onSelect(data.ids, data.zoom, data.say)
    })
    source.addEventListener('error', () => {
      this.handlers.onStatus('Lost the connection to warren serve — changes are no longer shared')
    })
  }

  private async reload(from: string): Promise<void> {
    // Somebody else changed the drawing while this window has edits it has not sent. Send them
    // first: either they land, or the server refuses and this comes back round knowing it is a
    // real conflict. Replacing the project outright would throw the unsent work away.
    if (this.latest && (this.saveTimer !== null || this.saving || this.pending)) {
      if (this.saveTimer !== null) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      await this.flush(this.latest)
      return
    }
    try {
      const { project } = await this.load()
      this.handlers.onChanged(project, this.rev)
      this.handlers.onStatus(from === 'cli' ? 'Updated from the command line' : 'Updated')
    } catch (err) {
      this.handlers.onStatus(`Could not take the change: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * Saving is continuous here rather than a thing you remember to do: the server owns the
   * file, so there is no such thing as unsaved work to lose.
   */
  save(project: Project): void {
    this.latest = project
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.flush(project)
    }, 700)
  }

  async flush(project: Project): Promise<void> {
    this.latest = project
    if (this.saving) {
      this.pending = true
      return
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saving = true
    try {
      const res = await fetch('/api/project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev: this.rev, by: this.id, project: JSON.parse(serialize(project)) }),
      })
      if (res.status === 409) {
        // A genuine collision: somebody else changed it while this window had unsent edits.
        // Theirs is the truth, because merging two drawings is not something to guess at - but
        // say so plainly rather than let work vanish quietly.
        this.saving = false
        this.pending = false
        this.latest = null
        this.handlers.onStatus('The drawing changed elsewhere while you were editing — taking theirs')
        await this.reload('other')
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      this.rev = (await res.json() as { rev: number }).rev
      this.latest = null
    } catch (err) {
      this.handlers.onStatus(`Could not save: ${err instanceof Error ? err.message : err}`)
    } finally {
      this.saving = false
      if (this.pending) {
        this.pending = false
        // Whatever the store holds now, not the snapshot this call was given.
        this.save(this.latest ?? project)
      }
    }
  }
}
