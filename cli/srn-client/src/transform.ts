/**
 * Pure note-shaping helpers used by the `export` and `import` commands.
 *
 * These are deliberately free of snjs/network dependencies so they can be unit
 * tested directly; index.ts only wires them to stdout/the filesystem.
 */

/** Structural shape of an exported note (matches NotesClient's FullNote). */
export interface ExportableNote {
  uuid: string
  title: string
  text: string
  tags: string[]
  updatedAt: string
}

/** Render notes as a single Markdown document, one `---`-separated section per note. */
export function toMarkdown(notes: ExportableNote[]): string {
  return notes
    .map((n) => {
      const header = `# ${n.title || '(untitled)'}\n`
      const meta = `<!-- uuid: ${n.uuid} | updated: ${n.updatedAt}${
        n.tags.length ? ` | tags: ${n.tags.join(', ')}` : ''
      } -->\n\n`
      return header + meta + (n.text ?? '')
    })
    .join('\n\n---\n\n')
}

export interface ImportRecord {
  title?: string
  text?: string
  tags?: string[]
}

/**
 * Parse an import file's contents into records.
 *
 * Throws (rather than exiting) so the caller controls the exit path; the
 * messages are the ones surfaced to the user.
 */
export function parseImportPayload(raw: string, file: string): ImportRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON. Import expects a JSON array of notes.`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Import file must be a JSON array of { title, text, tags? } objects.')
  }
  return parsed as ImportRecord[]
}

/**
 * Coerce one import record into a creatable note, or `undefined` if it carries
 * neither a title nor body (such entries are skipped rather than creating
 * empty notes). Non-string fields are discarded, not stringified.
 */
export function normalizeImportRecord(rec: ImportRecord): { title: string; text: string; tags: string[] } | undefined {
  const title = typeof rec?.title === 'string' ? rec.title : ''
  const text = typeof rec?.text === 'string' ? rec.text : ''
  const tags = Array.isArray(rec?.tags) ? rec.tags.filter((t): t is string => typeof t === 'string') : []
  if (!title && !text) {
    return undefined
  }
  return { title: title || '(untitled)', text, tags }
}
