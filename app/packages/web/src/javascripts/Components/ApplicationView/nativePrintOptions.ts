import { SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { createPersistedPrintOptions, PRINT_NOTE_UUID_ATTRIBUTE, PrintNoteOptions } from '../NoteView/Print/PrintNote'
import { hasPrintableView } from '../NoteView/Print/PrintableViewRegistry'

/**
 * What the browser menu's Print and Ctrl/Cmd+P should print.
 *
 * This answers two independent questions, and deliberately answers them from two
 * different sources:
 *
 *  - WHICH note — the item list controller's active item. It is the only
 *    authoritative answer: the controller is what decides which tab is active.
 *  - WHETHER an editor is on screen at all — the DOM. A view tab (Todos, Bookmarks, …)
 *    takes the content area over from the note editor, so a note the controller still
 *    holds is NOT what the user is looking at; naming it would print that note instead
 *    of the view in front of them.
 *
 * Standard Red Notes (t112): those two jobs used to be done by one DOM query, and that
 * conflation was the bug. The tiled editor mounts one NoteView per open note
 * (NoteGroupView keeps every open tab mounted and merely hides the inactive ones), so
 * from the second open tab onward `[data-srn-note-uuid]` matches once per open note and
 * the FIRST match is the first open note — not the active one. Ctrl/Cmd+P therefore
 * printed a note the user was not looking at. The DOM is now only ever asked the
 * yes/no question, which is the one it can actually answer.
 */
export function resolveNativePrintOptions(application: WebApplication): PrintNoteOptions {
  // Any tile at all proves the note editor (rather than a view tab) owns the content
  // area. Which tile it is must not be read from here.
  const anEditorIsOnScreen = document.querySelector(`[${PRINT_NOTE_UUID_ATTRIBUTE}]`) !== null
  if (!anEditorIsOnScreen && hasPrintableView()) {
    return {}
  }

  const noteUuid = application.itemListController.activeControllerItem?.uuid
  const note = noteUuid ? application.items.findItem<SNNote>(noteUuid) : undefined
  const editor = note ? application.componentManager.editorForNote(note) : undefined
  return (note ? createPersistedPrintOptions(note, editor) : undefined) ?? { noteUuid }
}
