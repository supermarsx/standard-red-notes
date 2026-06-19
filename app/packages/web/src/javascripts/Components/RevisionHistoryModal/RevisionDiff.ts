import { NoteContent, NoteType } from '@standardnotes/snjs'

export type DiffLineType = 'context' | 'added' | 'removed'

export type DiffLine = {
  type: DiffLineType
  /** 1-based line number in the original (left) text; null for added lines. */
  oldNumber: number | null
  /** 1-based line number in the new (right) text; null for removed lines. */
  newNumber: number | null
  text: string
}

/**
 * Recursively extracts readable plain text from a Super (Lexical) note's JSON
 * `text` payload. Falls back to the raw string when the content cannot be
 * parsed as Lexical JSON (e.g. plain notes or malformed data).
 */
const extractPlaintextFromLexicalJSON = (raw: string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }

  if (!parsed || typeof parsed !== 'object') {
    return raw
  }

  const lines: string[] = []
  let current = ''

  const isBlockNode = (type: unknown) => {
    return (
      type === 'paragraph' ||
      type === 'heading' ||
      type === 'listitem' ||
      type === 'quote' ||
      type === 'code' ||
      type === 'horizontalrule'
    )
  }

  const flush = () => {
    lines.push(current)
    current = ''
  }

  const walk = (node: Record<string, unknown>) => {
    const type = node.type

    if (type === 'linebreak') {
      flush()
      return
    }

    if (typeof node.text === 'string') {
      current += node.text
    }

    const children = node.children
    if (Array.isArray(children)) {
      children.forEach((child) => {
        if (child && typeof child === 'object') {
          walk(child as Record<string, unknown>)
        }
      })
    }

    if (isBlockNode(type)) {
      flush()
    }
  }

  const root = (parsed as { root?: unknown }).root
  if (root && typeof root === 'object') {
    walk(root as Record<string, unknown>)
    if (current.length > 0) {
      flush()
    }
    return lines.join('\n').replace(/\n+$/, '')
  }

  return raw
}

/**
 * Resolves a note's content into a single diffable plain-text string. Super
 * notes are decoded from their Lexical JSON to plain text; everything else
 * uses the raw text. The title is prepended so title changes are diffed too.
 */
export const getDiffableTextFromContent = (content: NoteContent): string => {
  const title = content.title ?? ''
  const rawText = content.text ?? ''

  const body = content.noteType === NoteType.Super ? extractPlaintextFromLexicalJSON(rawText) : rawText

  return title.length > 0 ? `${title}\n${body}` : body
}

const splitLines = (text: string): string[] => {
  if (text.length === 0) {
    return []
  }
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Computes a line-based diff between two strings using a Longest Common
 * Subsequence (LCS) dynamic-programming algorithm. Returns an ordered list of
 * diff lines suitable for both unified and split rendering.
 *
 * No external dependency is used.
 */
export const computeLineDiff = (oldText: string, newText: string): DiffLine[] => {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  const oldCount = oldLines.length
  const newCount = newLines.length

  // LCS length table.
  const lcs: number[][] = Array.from({ length: oldCount + 1 }, () => new Array(newCount + 1).fill(0))

  for (let i = oldCount - 1; i >= 0; i--) {
    for (let j = newCount - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  let oldNumber = 1
  let newNumber = 1

  while (i < oldCount && j < newCount) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'context', oldNumber, newNumber, text: oldLines[i] })
      i++
      j++
      oldNumber++
      newNumber++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'removed', oldNumber, newNumber: null, text: oldLines[i] })
      i++
      oldNumber++
    } else {
      result.push({ type: 'added', oldNumber: null, newNumber, text: newLines[j] })
      j++
      newNumber++
    }
  }

  while (i < oldCount) {
    result.push({ type: 'removed', oldNumber, newNumber: null, text: oldLines[i] })
    i++
    oldNumber++
  }

  while (j < newCount) {
    result.push({ type: 'added', oldNumber: null, newNumber, text: newLines[j] })
    j++
    newNumber++
  }

  return result
}

export type SplitDiffRow = {
  left: DiffLine | null
  right: DiffLine | null
}

/**
 * Pairs the linear diff into left/right rows for a side-by-side (split) view.
 * Removed and added lines that occur consecutively are aligned on the same row.
 */
export const buildSplitRows = (lines: DiffLine[]): SplitDiffRow[] => {
  const rows: SplitDiffRow[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.type === 'context') {
      rows.push({ left: line, right: line })
      index++
      continue
    }

    // Gather a contiguous block of removed and added lines.
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (index < lines.length && lines[index].type !== 'context') {
      if (lines[index].type === 'removed') {
        removed.push(lines[index])
      } else {
        added.push(lines[index])
      }
      index++
    }

    const maxLength = Math.max(removed.length, added.length)
    for (let k = 0; k < maxLength; k++) {
      rows.push({
        left: removed[k] ?? null,
        right: added[k] ?? null,
      })
    }
  }

  return rows
}

export type DiffStats = {
  added: number
  removed: number
}

export const computeDiffStats = (lines: DiffLine[]): DiffStats => {
  return lines.reduce<DiffStats>(
    (stats, line) => {
      if (line.type === 'added') {
        stats.added++
      } else if (line.type === 'removed') {
        stats.removed++
      }
      return stats
    },
    { added: 0, removed: 0 },
  )
}
