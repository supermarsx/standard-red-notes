// Resolves a chosen assistant context scope/selection into the concrete notes
// (and their plain text) that buildAssistantContext consumes. This is where we
// touch `application.items`; the assembly itself (assistantContext.ts) stays a
// pure, testable function with no app dependency.

import {
  ContentType,
  SNNote,
  SNTag,
  SNFolder,
  isNote,
  isFolderItem,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { doesItemMatchSearchQuery } from '@/Utils/Items/Search/doesItemMatchSearchQuery'
import { AssistantContextScope, ContextNote, BuiltAssistantContext, buildAssistantContext } from './assistantContext'

/**
 * Identifies the source of a "collection" scope: either a tag/folder whose
 * referenced notes form the set, or an explicit list of note uuids the user
 * multi-selected.
 */
export type CollectionSelection =
  | { type: 'tag'; uuid: string }
  | { type: 'folder'; uuid: string }
  | { type: 'notes'; uuids: string[] }

export interface AssistantContextSelection {
  scope: AssistantContextScope
  /** Present only when scope === 'collection'. */
  collection?: CollectionSelection
  /** Present only when scope === 'topic': the free-text query to match notes by. */
  topicQuery?: string
}

/**
 * Hard cap on how many notes a broad scope (open-notes / all-notes / topic /
 * collection) may resolve to BEFORE the character budget is applied. Even with a
 * generous budget, sending hundreds of note headers is rarely useful and risks
 * blowing the token budget; we keep the most-relevant first (notes arrive in the
 * app's sort/relevance order) and report the rest as omitted via the truncation
 * flag downstream.
 */
export const MAX_CONTEXT_NOTES = 30

/** Take at most MAX_CONTEXT_NOTES notes, preserving order. */
const capNotes = <T>(notes: T[]): T[] => (notes.length > MAX_CONTEXT_NOTES ? notes.slice(0, MAX_CONTEXT_NOTES) : notes)

/** Convert a note to the plain-text record context assembly expects. */
function toContextNote(application: WebApplication, note: SNNote): ContextNote {
  return {
    uuid: note.uuid,
    title: note.title,
    text: extractPlaintextFromNoteText(note.text ?? '', note.noteType),
  }
}

const allNotes = (application: WebApplication): SNNote[] =>
  application.items.getItems<SNNote>(ContentType.TYPES.Note).filter((note) => !note.trashed)

/**
 * Notes currently open in editor tabs, in tab order. Each open tab is backed by an
 * item-view controller; we take only the note controllers (skipping files and
 * unsaved template notes) and de-duplicate by uuid in case the same note is open
 * in more than one tab.
 */
function openNotes(application: WebApplication): SNNote[] {
  const seen = new Set<string>()
  const notes: SNNote[] = []
  for (const controller of application.itemControllerGroup.itemControllers) {
    if (!(controller instanceof NoteViewController) || controller.isTemplateNote) {
      continue
    }
    const note = controller.item
    if (!note || note.trashed || seen.has(note.uuid)) {
      continue
    }
    seen.add(note.uuid)
    notes.push(note)
  }
  return notes
}

/** Notes whose title/preview matches a free-text query, using the app's search helper. */
function notesMatchingTopic(application: WebApplication, query: string): SNNote[] {
  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }
  return allNotes(application).filter((note) => doesItemMatchSearchQuery(note, trimmed, application))
}

/** Notes referencing a tag (notes point at tags), most relevant first by app sort. */
function notesForTag(application: WebApplication, tag: SNTag): SNNote[] {
  return application.items.itemsReferencingItem(tag).filter(isNote).filter((note) => !note.trashed)
}

/** Notes a folder references (folders point at notes). */
function notesForFolder(application: WebApplication, folder: SNFolder): SNNote[] {
  return application.items
    .referencesForItem<SNNote>(folder, ContentType.TYPES.Note)
    .filter((note) => !note.trashed)
}

/** The notes resolved for a selection, plus how many were dropped by the count cap. */
export interface ResolvedContextNotes {
  notes: ContextNote[]
  collectionLabel?: string
  /** Notes that matched the scope but were dropped to honor MAX_CONTEXT_NOTES. */
  cappedNoteCount: number
}

/** Map raw notes to context records, capping at MAX_CONTEXT_NOTES and reporting the overflow. */
function resolveFrom(application: WebApplication, raw: SNNote[], collectionLabel?: string): ResolvedContextNotes {
  const capped = capNotes(raw)
  return {
    notes: capped.map((note) => toContextNote(application, note)),
    collectionLabel,
    cappedNoteCount: raw.length - capped.length,
  }
}

/**
 * Resolve the selection into the notes that should be sent as context.
 * Returns an empty array when nothing matches (e.g. no active note).
 */
export function resolveContextNotes(
  application: WebApplication,
  selection: AssistantContextSelection,
): ResolvedContextNotes {
  const empty: ResolvedContextNotes = { notes: [], cappedNoteCount: 0 }

  if (selection.scope === 'current-note') {
    const active = application.itemListController.activeControllerItem
    if (active && isNote(active)) {
      return { notes: [toContextNote(application, active)], cappedNoteCount: 0 }
    }
    return empty
  }

  if (selection.scope === 'open-notes') {
    return resolveFrom(application, openNotes(application))
  }

  if (selection.scope === 'all-notes') {
    return resolveFrom(application, allNotes(application))
  }

  if (selection.scope === 'topic') {
    const query = (selection.topicQuery ?? '').trim()
    if (!query) {
      return empty
    }
    return resolveFrom(application, notesMatchingTopic(application, query), `${query}`)
  }

  // Collection.
  const collection = selection.collection
  if (!collection) {
    return empty
  }

  if (collection.type === 'tag') {
    const tag = application.items.findItem<SNTag>(collection.uuid)
    if (!tag) {
      return empty
    }
    return resolveFrom(application, notesForTag(application, tag), application.items.getTagLongTitle(tag))
  }

  if (collection.type === 'folder') {
    const folder = application.items.findItem<SNFolder>(collection.uuid)
    if (!folder || !isFolderItem(folder)) {
      return empty
    }
    return resolveFrom(application, notesForFolder(application, folder), folder.title)
  }

  // Explicit multi-selection of notes.
  const selected = collection.uuids
    .map((uuid) => application.items.findItem<SNNote>(uuid))
    .filter((note): note is SNNote => Boolean(note) && isNote(note as SNNote))
  return resolveFrom(application, selected, `${selected.length} selected note${selected.length === 1 ? '' : 's'}`)
}

/** Resolve a selection and assemble its bounded context in one step. */
export function buildContextForSelection(
  application: WebApplication,
  selection: AssistantContextSelection,
  budget?: number,
): BuiltAssistantContext {
  const { notes, collectionLabel, cappedNoteCount } = resolveContextNotes(application, selection)
  const built = buildAssistantContext(selection.scope, notes, { budget, collectionLabel })
  if (cappedNoteCount <= 0) {
    return built
  }
  // Fold notes dropped by the COUNT cap (before budgeting) into the reported
  // omitted/truncated totals so the UI's "X chars (truncated)" notice is accurate.
  return {
    ...built,
    omittedNoteCount: built.omittedNoteCount + cappedNoteCount,
    truncated: true,
  }
}
