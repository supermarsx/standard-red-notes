import snjs from '@standardnotes/snjs'
import type { HeadlessApp } from './bootstrap.js'

const { ContentType } = snjs as unknown as Record<string, any>

export interface NoteSummary {
  uuid: string
  title: string
  updatedAt: string
}

export interface FullNote {
  uuid: string
  title: string
  text: string
  tags: string[]
  createdAt: string
  updatedAt: string
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

// A just-created item reports `updated_at` as epoch 0 until it round-trips a
// server stamp; fall back to `created_at` so callers get a meaningful timestamp.
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
 * Operates on a real, decrypted snjs account: notes are decrypted locally and
 * changes sync back end-to-end encrypted. Adapted from the MCP bridge's
 * SnjsBackedClient (the proven headless-snjs blueprint).
 */
export class NotesClient {
  constructor(private readonly headless: HeadlessApp) {}

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

  private async resolveTag(title: string): Promise<any> {
    const existing = this.app.items.getDisplayableTags().find((t: any) => t.title === title)
    if (existing) {
      return existing
    }
    return this.app.mutator.createTagOrSmartView(title)
  }

  async listNotes(limit?: number): Promise<NoteSummary[]> {
    await this.headless.sync()
    const sorted = this.notes()
      .slice()
      .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
    const sliced = limit && limit > 0 ? sorted.slice(0, limit) : sorted
    return sliced.map((n) => ({ uuid: n.uuid, title: n.title ?? '', updatedAt: updatedAtIso(n) }))
  }

  async readNote(uuid: string): Promise<FullNote> {
    const note = this.noteByUuid(uuid)
    return {
      uuid: note.uuid,
      title: note.title ?? '',
      text: note.text ?? '',
      tags: this.tagsForNote(note),
      createdAt: iso(note.created_at),
      updatedAt: updatedAtIso(note),
    }
  }

  async createNote(input: { title: string; text: string; tags: string[] }): Promise<{ uuid: string; title: string }> {
    // needsSync MUST be true so the note is marked dirty and actually uploaded on
    // sync; otherwise it stays local-only.
    const note = await this.app.mutator.createItem(
      ContentType.TYPES.Note,
      { title: input.title, text: input.text, references: [] },
      true,
    )
    for (const tagTitle of input.tags ?? []) {
      const tag = await this.resolveTag(tagTitle)
      await this.app.mutator.addTagToNote(this.noteByUuid(note.uuid), tag, false)
    }
    await this.headless.sync()
    return { uuid: note.uuid, title: input.title }
  }

  async updateNote(
    uuid: string,
    patch: { title?: string; text?: string; tags?: string[] },
  ): Promise<{ uuid: string; updatedAt: string }> {
    const note = this.noteByUuid(uuid)
    await this.app.mutator.changeItem(note, (mutator: any) => {
      if (patch.title !== undefined) {
        mutator.title = patch.title
      }
      if (patch.text !== undefined) {
        mutator.text = patch.text
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
    return { uuid, updatedAt: updatedAtIso(this.noteByUuid(uuid)) }
  }

  async deleteNote(uuid: string): Promise<void> {
    const note = this.noteByUuid(uuid)
    await this.app.mutator.setItemToBeDeleted(note)
    await this.headless.sync()
  }

  /** All notes, fully decrypted, for export. */
  async exportAll(): Promise<FullNote[]> {
    await this.headless.sync()
    return this.notes()
      .slice()
      .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
      .map((note) => ({
        uuid: note.uuid,
        title: note.title ?? '',
        text: note.text ?? '',
        tags: this.tagsForNote(note),
        createdAt: iso(note.created_at),
        updatedAt: updatedAtIso(note),
      }))
  }
}
