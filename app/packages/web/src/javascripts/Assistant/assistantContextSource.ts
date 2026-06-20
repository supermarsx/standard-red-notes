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
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
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
}

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

/**
 * Resolve the selection into the notes that should be sent as context.
 * Returns an empty array when nothing matches (e.g. no active note).
 */
export function resolveContextNotes(
  application: WebApplication,
  selection: AssistantContextSelection,
): { notes: ContextNote[]; collectionLabel?: string } {
  if (selection.scope === 'current-note') {
    const active = application.itemListController.activeControllerItem
    if (active && isNote(active)) {
      return { notes: [toContextNote(application, active)] }
    }
    return { notes: [] }
  }

  if (selection.scope === 'all-notes') {
    return { notes: allNotes(application).map((note) => toContextNote(application, note)) }
  }

  // Collection.
  const collection = selection.collection
  if (!collection) {
    return { notes: [] }
  }

  if (collection.type === 'tag') {
    const tag = application.items.findItem<SNTag>(collection.uuid)
    if (!tag) {
      return { notes: [] }
    }
    return {
      notes: notesForTag(application, tag).map((note) => toContextNote(application, note)),
      collectionLabel: application.items.getTagLongTitle(tag),
    }
  }

  if (collection.type === 'folder') {
    const folder = application.items.findItem<SNFolder>(collection.uuid)
    if (!folder || !isFolderItem(folder)) {
      return { notes: [] }
    }
    return {
      notes: notesForFolder(application, folder).map((note) => toContextNote(application, note)),
      collectionLabel: folder.title,
    }
  }

  // Explicit multi-selection of notes.
  const notes = collection.uuids
    .map((uuid) => application.items.findItem<SNNote>(uuid))
    .filter((note): note is SNNote => Boolean(note) && isNote(note as SNNote))
    .map((note) => toContextNote(application, note))
  return { notes, collectionLabel: `${notes.length} selected note${notes.length === 1 ? '' : 's'}` }
}

/** Resolve a selection and assemble its bounded context in one step. */
export function buildContextForSelection(
  application: WebApplication,
  selection: AssistantContextSelection,
  budget?: number,
): BuiltAssistantContext {
  const { notes, collectionLabel } = resolveContextNotes(application, selection)
  return buildAssistantContext(selection.scope, notes, { budget, collectionLabel })
}
