import snjs from '@standardnotes/snjs'
import type { HeadlessApp } from './bootstrap.js'

const { ContentType } = snjs as unknown as Record<string, any>

export interface NoteSummary {
  uuid: string
  title: string
  updatedAt: string
}
export interface NoteSearchHit {
  uuid: string
  title: string
  snippet: string
}
export interface FullNote {
  uuid: string
  title: string
  body: string
  tags: string[]
  createdAt: string
  updatedAt: string
}
export interface TagSummary {
  uuid: string
  title: string
}

function iso(d: unknown): string {
  if (d instanceof Date) {
    return d.toISOString()
  }
  if (typeof d === 'string' || typeof d === 'number') {
    return new Date(d).toISOString()
  }
  return new Date().toISOString()
}

// A just-created item that hasn't round-tripped a server-assigned update stamp
// reports `updated_at` as epoch 0; fall back to `created_at` so callers get a
// meaningful timestamp.
function updatedAtIso(note: { updated_at?: unknown; created_at?: unknown }): string {
  const u = note.updated_at
  if (u instanceof Date && u.getTime() > 0) {
    return u.toISOString()
  }
  if ((typeof u === 'string' || typeof u === 'number') && new Date(u).getTime() > 0) {
    return new Date(u).toISOString()
  }
  return iso(note.created_at)
}

/**
 * Backs the MCP tool handlers with a real, decrypted snjs account. Mirrors the
 * method surface the handlers previously expected from the HTTP ServerClient,
 * but operates on locally-decrypted items and persists via E2E-encrypted sync.
 */
export class SnjsBackedClient {
  readonly allowWrites: boolean
  readonly baseUrl: string

  constructor(
    private readonly headless: HeadlessApp,
    opts: { allowWrites: boolean; baseUrl: string },
  ) {
    this.allowWrites = opts.allowWrites
    this.baseUrl = opts.baseUrl
  }

  private get app(): any {
    return this.headless.app
  }

  private notes(): any[] {
    return this.app.items.getDisplayableNotes()
  }

  private noteByUuid(uuid: string): any {
    const note = this.notes().find((n) => n.uuid === uuid)
    if (!note) {
      throw new Error(`note not found: ${uuid}`)
    }
    return note
  }

  private tagsForNote(note: any): string[] {
    return (this.app.items.getSortedTagsForItem(note) ?? []).map((t: any) => t.title)
  }

  private requireWrites(tool: string): void {
    if (!this.allowWrites) {
      throw new Error(`Writes are disabled. Set STANDARD_RED_NOTES_ALLOW_WRITES=1 to enable ${tool}.`)
    }
  }

  async listNotes(limit: number, _cursor?: string): Promise<{ notes: NoteSummary[]; cursor?: string }> {
    await this.headless.sync()
    const notes = this.notes()
      .slice()
      .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
      .slice(0, limit)
      .map((n) => ({ uuid: n.uuid, title: n.title ?? '', updatedAt: updatedAtIso(n) }))
    return { notes }
  }

  async searchNotes(query: string, limit: number): Promise<{ hits: NoteSearchHit[] }> {
    await this.headless.sync()
    const q = query.toLowerCase()
    const hits: NoteSearchHit[] = []
    for (const n of this.notes()) {
      const title = String(n.title ?? '')
      const text = String(n.text ?? '')
      const idx = `${title}\n${text}`.toLowerCase().indexOf(q)
      if (idx === -1) {
        continue
      }
      const start = Math.max(0, idx - 30)
      const snippet = `${title}\n${text}`.slice(start, start + 160).replace(/\s+/g, ' ').trim()
      hits.push({ uuid: n.uuid, title, snippet })
      if (hits.length >= limit) {
        break
      }
    }
    return { hits }
  }

  async readNote(uuid: string): Promise<FullNote> {
    const note = this.noteByUuid(uuid)
    return {
      uuid: note.uuid,
      title: note.title ?? '',
      body: note.text ?? '',
      tags: this.tagsForNote(note),
      createdAt: iso(note.created_at),
      updatedAt: updatedAtIso(note),
    }
  }

  private async resolveTag(title: string): Promise<any> {
    const existing = this.app.items.getDisplayableTags().find((t: any) => t.title === title)
    if (existing) {
      return existing
    }
    return this.app.mutator.createTagOrSmartView(title)
  }

  async createNote(input: { title: string; body: string; tags: string[] }): Promise<{ uuid: string; title: string }> {
    this.requireWrites('notes.create')
    const note = await this.app.mutator.createItem(
      ContentType.TYPES.Note,
      { title: input.title, text: input.body, references: [] },
      false,
    )
    for (const tagTitle of input.tags ?? []) {
      const tag = await this.resolveTag(tagTitle)
      await this.app.mutator.addTagToNote(note, tag, false)
    }
    await this.headless.sync()
    return { uuid: note.uuid, title: input.title }
  }

  async updateNote(
    uuid: string,
    patch: { title?: string; body?: string; tags?: string[] },
  ): Promise<{ uuid: string; updatedAt: string }> {
    this.requireWrites('notes.update')
    const note = this.noteByUuid(uuid)
    await this.app.mutator.changeItem(note, (mutator: any) => {
      if (patch.title !== undefined) {
        mutator.title = patch.title
      }
      if (patch.body !== undefined) {
        mutator.text = patch.body
      }
    })
    if (patch.tags !== undefined) {
      const fresh = this.noteByUuid(uuid)
      for (const tagTitle of patch.tags) {
        const tag = await this.resolveTag(tagTitle)
        await this.app.mutator.addTagToNote(fresh, tag, false)
      }
    }
    await this.headless.sync()
    const updated = this.noteByUuid(uuid)
    return { uuid, updatedAt: updatedAtIso(updated) }
  }

  async deleteNote(uuid: string): Promise<void> {
    this.requireWrites('notes.delete')
    const note = this.noteByUuid(uuid)
    await this.app.mutator.setItemToBeDeleted(note)
    await this.headless.sync()
  }

  async listTags(): Promise<TagSummary[]> {
    await this.headless.sync()
    return this.app.items.getDisplayableTags().map((t: any) => ({ uuid: t.uuid, title: t.title ?? '' }))
  }
}
