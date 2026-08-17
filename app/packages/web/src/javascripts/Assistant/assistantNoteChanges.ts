import {
  isLitePayload,
  isNote,
  MutationType,
  NoteMutator,
  NoteType,
  PayloadEmitSource,
  SNNote,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

const MAX_DIFF_CELLS = 160_000
const MAX_DIFF_CHARS = 12_000
const DIFF_CONTEXT_LINES = 3
const MAX_SNAPSHOT_PREVIEW_PLAIN_CHARS = 2_000
const MAX_SNAPSHOT_PREVIEW_HTML_CHARS = 4_000
// Fast character ceiling; the tool performs an exact UTF-8 journal-admission
// check on the complete before/after record before it mutates a note.
export const MAX_REVERSIBLE_ASSISTANT_NOTE_CHARS = 40_000

export type AssistantNoteSnapshot = {
  title: string
  text: string
  previewPlain: string
  previewHtml?: string
  noteType: NoteType
  editorIdentifier?: string
}

export type AssistantNoteChange = {
  noteUuid: string
  noteTitle: string
  before: AssistantNoteSnapshot
  after: AssistantNoteSnapshot
  patch: string
  addedLines: number
  removedLines: number
  truncated: boolean
}

type DiffOperation = { kind: 'equal' | 'add' | 'delete'; line: string }

export type AssistantNoteChangeDirection = 'undo' | 'redo'
export type AssistantNoteChangeResult = { position: 'before' | 'after'; alreadyApplied: boolean }

const linesOf = (value: string): string[] => {
  if (value.length === 0) {
    return []
  }
  return value.replace(/\r\n?/g, '\n').split('\n')
}

function changedMiddle(before: string[], after: string[]): DiffOperation[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }

  const beforeMiddle = before.slice(prefix, before.length - suffix)
  const afterMiddle = after.slice(prefix, after.length - suffix)
  const operations: DiffOperation[] = before.slice(0, prefix).map((line) => ({ kind: 'equal', line }))

  if (beforeMiddle.length * afterMiddle.length <= MAX_DIFF_CELLS) {
    const width = afterMiddle.length + 1
    const table = new Uint32Array((beforeMiddle.length + 1) * width)
    for (let beforeIndex = beforeMiddle.length - 1; beforeIndex >= 0; beforeIndex--) {
      for (let afterIndex = afterMiddle.length - 1; afterIndex >= 0; afterIndex--) {
        table[beforeIndex * width + afterIndex] =
          beforeMiddle[beforeIndex] === afterMiddle[afterIndex]
            ? table[(beforeIndex + 1) * width + afterIndex + 1] + 1
            : Math.max(table[(beforeIndex + 1) * width + afterIndex], table[beforeIndex * width + afterIndex + 1])
      }
    }

    let beforeIndex = 0
    let afterIndex = 0
    while (beforeIndex < beforeMiddle.length && afterIndex < afterMiddle.length) {
      if (beforeMiddle[beforeIndex] === afterMiddle[afterIndex]) {
        operations.push({ kind: 'equal', line: beforeMiddle[beforeIndex] })
        beforeIndex++
        afterIndex++
      } else if (table[(beforeIndex + 1) * width + afterIndex] >= table[beforeIndex * width + afterIndex + 1]) {
        operations.push({ kind: 'delete', line: beforeMiddle[beforeIndex++] })
      } else {
        operations.push({ kind: 'add', line: afterMiddle[afterIndex++] })
      }
    }
    while (beforeIndex < beforeMiddle.length) {
      operations.push({ kind: 'delete', line: beforeMiddle[beforeIndex++] })
    }
    while (afterIndex < afterMiddle.length) {
      operations.push({ kind: 'add', line: afterMiddle[afterIndex++] })
    }
  } else {
    operations.push(...beforeMiddle.map((line): DiffOperation => ({ kind: 'delete', line })))
    operations.push(...afterMiddle.map((line): DiffOperation => ({ kind: 'add', line })))
  }

  operations.push(...before.slice(before.length - suffix).map((line): DiffOperation => ({ kind: 'equal', line })))
  return operations
}

function formatOperations(
  operations: DiffOperation[],
  filename: string,
): {
  patch: string
  addedLines: number
  removedLines: number
  truncated: boolean
} {
  const changeIndexes = operations.flatMap((operation, index) => (operation.kind === 'equal' ? [] : [index]))
  const addedLines = operations.filter((operation) => operation.kind === 'add').length
  const removedLines = operations.filter((operation) => operation.kind === 'delete').length
  if (changeIndexes.length === 0) {
    return { patch: '', addedLines, removedLines, truncated: false }
  }

  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changeIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES)
    const end = Math.min(operations.length, index + DIFF_CONTEXT_LINES + 1)
    const previous = ranges[ranges.length - 1]
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  const oldLineAt = new Uint32Array(operations.length + 1)
  const newLineAt = new Uint32Array(operations.length + 1)
  oldLineAt[0] = 1
  newLineAt[0] = 1
  for (let index = 0; index < operations.length; index++) {
    oldLineAt[index + 1] = oldLineAt[index] + (operations[index].kind === 'add' ? 0 : 1)
    newLineAt[index + 1] = newLineAt[index] + (operations[index].kind === 'delete' ? 0 : 1)
  }

  const output = [`diff --git a/${filename} b/${filename}`, `--- a/${filename}`, `+++ b/${filename}`]
  let outputChars = output.reduce((total, line) => total + line.length + 1, 0)
  let truncated = false
  outer: for (const range of ranges) {
    const slice = operations.slice(range.start, range.end)
    const oldCount = slice.filter((operation) => operation.kind !== 'add').length
    const newCount = slice.filter((operation) => operation.kind !== 'delete').length
    const header = `@@ -${oldLineAt[range.start]},${oldCount} +${newLineAt[range.start]},${newCount} @@`
    output.push(header)
    outputChars += header.length + 1
    for (const operation of slice) {
      const prefix = operation.kind === 'add' ? '+' : operation.kind === 'delete' ? '-' : ' '
      const line = `${prefix}${operation.line}`
      if (outputChars + line.length + 1 > MAX_DIFF_CHARS) {
        output.push('... diff display truncated ...')
        truncated = true
        break outer
      }
      output.push(line)
      outputChars += line.length + 1
    }
  }

  return { patch: output.join('\n'), addedLines, removedLines, truncated }
}

export function createAssistantNoteSnapshot(snapshot: AssistantNoteSnapshot): AssistantNoteSnapshot {
  const previewHtml = snapshot.previewHtml
  return {
    title: snapshot.title,
    text: snapshot.text,
    previewPlain: snapshot.previewPlain.slice(0, MAX_SNAPSHOT_PREVIEW_PLAIN_CHARS),
    ...(previewHtml && previewHtml.length <= MAX_SNAPSHOT_PREVIEW_HTML_CHARS ? { previewHtml } : {}),
    noteType: snapshot.noteType,
    ...(snapshot.editorIdentifier ? { editorIdentifier: snapshot.editorIdentifier } : {}),
  }
}

export function captureAssistantNoteSnapshot(note: SNNote): AssistantNoteSnapshot {
  return createAssistantNoteSnapshot({
    title: note.title,
    text: note.text,
    previewPlain: note.preview_plain,
    previewHtml: note.preview_html,
    noteType: note.noteType ?? NoteType.Plain,
    editorIdentifier: note.editorIdentifier,
  })
}

export function buildAssistantNoteChange(input: {
  noteUuid: string
  before: AssistantNoteSnapshot
  after: AssistantNoteSnapshot
  beforeDisplayText?: string
  afterDisplayText?: string
}): AssistantNoteChange | undefined {
  const { noteUuid, before, after } = input
  const titleChanged = before.title !== after.title
  const storedRepresentationChanged =
    before.text !== after.text ||
    before.noteType !== after.noteType ||
    before.editorIdentifier !== after.editorIdentifier
  const bodyOperations = changedMiddle(
    linesOf(input.beforeDisplayText ?? before.text),
    linesOf(input.afterDisplayText ?? after.text),
  )
  const body = formatOperations(bodyOperations, 'note.md')
  const title = titleChanged
    ? [
        'diff --git a/note-title.txt b/note-title.txt',
        '--- a/note-title.txt',
        '+++ b/note-title.txt',
        '@@ -1,1 +1,1 @@',
        `-${before.title}`,
        `+${after.title}`,
      ].join('\n')
    : ''
  const format =
    !body.patch && storedRepresentationChanged
      ? [
          'diff --git a/note-format.txt b/note-format.txt',
          '--- a/note-format.txt',
          '+++ b/note-format.txt',
          '@@ -1,1 +1,1 @@',
          `-${before.noteType}${before.editorIdentifier ? ` (${before.editorIdentifier})` : ''}`,
          `+${after.noteType}${after.editorIdentifier ? ` (${after.editorIdentifier})` : ''}`,
        ].join('\n')
      : ''
  if (!title && !body.patch && !format) {
    return undefined
  }
  const patch = [title, body.patch, format].filter(Boolean).join('\n\n')
  return {
    noteUuid,
    noteTitle: after.title || before.title || 'Untitled note',
    before,
    after,
    patch: patch.length > MAX_DIFF_CHARS ? `${patch.slice(0, MAX_DIFF_CHARS)}\n... diff display truncated ...` : patch,
    addedLines: body.addedLines + (titleChanged ? 1 : 0) + (format ? 1 : 0),
    removedLines: body.removedLines + (titleChanged ? 1 : 0) + (format ? 1 : 0),
    truncated: body.truncated || patch.length > MAX_DIFF_CHARS,
  }
}

export function assistantNoteSnapshotMatches(note: SNNote, snapshot: AssistantNoteSnapshot): boolean {
  return (
    note.title === snapshot.title &&
    note.text === snapshot.text &&
    (note.noteType ?? NoteType.Plain) === snapshot.noteType &&
    note.editorIdentifier === snapshot.editorIdentifier
  )
}

/** Flush every mounted copy before taking or comparing a durable note snapshot. */
export async function flushAssistantNoteEditors(application: WebApplication, noteUuid: string): Promise<void> {
  const controllers = application.itemControllerGroup?.itemControllers ?? []
  for (const controller of controllers) {
    if (
      controller.item?.uuid !== noteUuid ||
      !('flushAndAwaitPendingSaveStrict' in controller) ||
      typeof controller.flushAndAwaitPendingSaveStrict !== 'function'
    ) {
      continue
    }
    await controller.flushAndAwaitPendingSaveStrict()
  }
}

function assertWritable(application: WebApplication, note: SNNote): void {
  if (note.locked || isLitePayload(note.payload) || !application.isAuthorizedToRenderItem(note)) {
    throw new Error('This note is no longer available for an assistant history action.')
  }
  if (application.sessions.isCurrentSessionReadOnly()) {
    throw new Error('This session is read-only.')
  }
  const vault = application.vaults.getItemVault(note)
  if (vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault)) {
    throw new Error('This shared vault is read-only for the current user.')
  }
}

export async function applyAssistantNoteChange(
  application: WebApplication,
  change: AssistantNoteChange,
  direction: AssistantNoteChangeDirection,
): Promise<AssistantNoteChangeResult> {
  await flushAssistantNoteEditors(application, change.noteUuid)
  const candidate = application.items.findItem<SNNote>(change.noteUuid)
  if (!candidate || !isNote(candidate)) {
    throw new Error('The changed note no longer exists.')
  }
  assertWritable(application, candidate)

  const expected = direction === 'undo' ? change.after : change.before
  const target = direction === 'undo' ? change.before : change.after
  const position = direction === 'undo' ? 'before' : 'after'
  if (assistantNoteSnapshotMatches(candidate, target)) {
    return { position, alreadyApplied: true }
  }
  if (!assistantNoteSnapshotMatches(candidate, expected)) {
    throw new Error('The note changed again after this assistant action. Review the latest note before replacing it.')
  }

  await application.mutator.changeItem<NoteMutator, SNNote>(
    candidate,
    (mutator) => {
      mutator.title = target.title
      mutator.text = target.text
      mutator.preview_plain = target.previewPlain
      mutator.preview_html = target.previewHtml
      mutator.noteType = target.noteType
      mutator.editorIdentifier = target.editorIdentifier
    },
    MutationType.UpdateUserTimestamps,
    PayloadEmitSource.AssistantChanged,
  )
  try {
    void application.sync.sync().catch((error) => console.error('Assistant history action sync failed', error))
  } catch (error) {
    console.error('Assistant history action sync failed', error)
  }
  return { position, alreadyApplied: false }
}
