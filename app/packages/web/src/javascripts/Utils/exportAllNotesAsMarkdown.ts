import { WebApplication } from '@/Application/WebApplication'
import { HeadlessSuperConverter } from '@/Components/SuperEditor/Tools/HeadlessSuperConverter'
import { FileItem, NoteType, PrefDefaults, PrefKey, isItemExportable } from '@standardnotes/snjs'
import { sanitizeFileName } from '@standardnotes/utils'
import { addToast, ToastType } from '@standardnotes/toast'
import { c } from 'ttag'
import { getBase64FromBlob } from './Utils'
import { getFullNoteText, isLiteNote } from './Items/rehydrateLazyDecryptedNote'

const headlessSuperConverter = new HeadlessSuperConverter()

async function noteToMarkdown(application: WebApplication, note: { noteType?: string; text: string; uuid: string }): Promise<string> {
  if (note.noteType === NoteType.Super) {
    return headlessSuperConverter.convertSuperStringToOtherFormat(note.text, 'md', {
      embedBehavior: application.getPreference(
        PrefKey.SuperNoteExportEmbedBehavior,
        PrefDefaults[PrefKey.SuperNoteExportEmbedBehavior],
      ),
      getFileItem: (id) => application.items.findItem<FileItem>(id),
      getFileBase64: async (id) => {
        try {
          const fileItem = application.items.findItem<FileItem>(id)
          if (!fileItem) {
            return
          }
          const fileBlob = await application.filesController.getFileBlob(fileItem)
          return fileBlob ? await getBase64FromBlob(fileBlob) : undefined
        } catch {
          return undefined
        }
      },
    })
  }
  // Plaintext and Markdown notes are already plain text.
  return note.text ?? ''
}

/**
 * Export every note in the account as a simple Markdown file, zipped. Super notes
 * are converted to Markdown via the headless Lexical converter; plaintext and
 * markdown notes are written as-is. Returns the number of notes exported (0 = no
 * notes, nothing downloaded).
 */
export async function exportAllNotesAsMarkdown(application: WebApplication): Promise<number> {
  // Displayable notes only, and never an items key / user preferences: this is decrypted,
  // human-consumable output (shared exportability rule with the other export paths).
  const notes = application.items.getDisplayableNotes().filter((note) => isItemExportable(note))
  if (notes.length === 0) {
    return 0
  }

  const data: { name: string; content: Blob }[] = []
  let unavailableCount = 0
  for (const note of notes) {
    // LAZY-DECRYPT: notes may be body-less "lite" projections on cold-load; pull
    // the full body on demand from IndexedDB (no-op / unchanged with the flag off).
    const text = await getFullNoteText(application.sync, note)
    // If a lite note's on-disk body can't be re-hydrated it falls back to an empty body,
    // which would otherwise be written as a silent zero-byte .md file. Count it so the user
    // is warned rather than getting truncated notes with no signal. (An intentionally empty
    // note also yields '', so this may slightly over-count; the toast is phrased accordingly.)
    if (text.length === 0 && isLiteNote(note)) {
      unavailableCount++
    }
    const markdown = await noteToMarkdown(application, { noteType: note.noteType, text, uuid: note.uuid })
    const title = sanitizeFileName(note.title || 'Untitled')
    data.push({
      // Full uuid (not a prefix) guarantees a unique entry per note so two
      // same-titled notes can't collide and silently drop one from the export.
      name: `${title}-${note.uuid}.md`,
      content: new Blob([markdown], { type: 'text/markdown' }),
    })
  }

  const blob = await application.archiveService.zipData(data)
  application.archiveService.downloadData(
    blob,
    `Standard Red Notes Markdown Export - ${application.archiveService.formattedDateForExports()}.zip`,
  )

  if (unavailableCount > 0) {
    addToast({
      type: ToastType.Error,
      message: c('Warning').t`${unavailableCount} note(s) may not have been fully exported because their content isn't available locally.`,
    })
  }

  return notes.length
}
