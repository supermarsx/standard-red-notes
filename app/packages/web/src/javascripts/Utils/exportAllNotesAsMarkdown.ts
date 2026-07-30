import { WebApplication } from '@/Application/WebApplication'
import { HeadlessSuperConverter } from '@/Components/SuperEditor/Tools/HeadlessSuperConverter'
import {
  ContentType,
  FileItem,
  isItemExportable,
  isLitePayload,
  isNote,
  NoteType,
  PrefDefaults,
  PrefKey,
} from '@standardnotes/snjs'
import { sanitizeFileName } from '@standardnotes/utils'
import { getBase64FromBlob } from './Utils'
import { isLiteNote } from './Items/rehydrateLazyDecryptedNote'

const headlessSuperConverter = new HeadlessSuperConverter()

async function noteToMarkdown(
  application: WebApplication,
  note: { noteType?: string; text: string; uuid: string },
): Promise<string> {
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
  const unreadableNotes = application.items.invalidItems.filter(
    (item) => item.content_type === ContentType.TYPES.Note && isItemExportable(item),
  )
  if (unreadableNotes.length > 0) {
    throw new Error(
      `Markdown export stopped because ${unreadableNotes.length} ${
        unreadableNotes.length === 1 ? 'note is' : 'notes are'
      } unreadable with the keys currently available. No incomplete export was downloaded.`,
    )
  }

  // Export every decrypted note, independent of the current vault, trash, archive, or list-display
  // filters. "Displayable" is a UI projection and silently omitted valid notes from an all-notes
  // export.
  const notes = application.items.items.filter(isNote).filter((note) => isItemExportable(note))
  if (notes.length === 0) {
    return 0
  }

  const data: { name: string; content: Blob }[] = []
  const unavailableNoteUuids: string[] = []
  for (const note of notes) {
    let text = note.text
    if (isLiteNote(note)) {
      const fullPayload = await application.sync.getFullContentPayload(note.uuid)
      const fullText = (fullPayload?.content as { text?: unknown } | undefined)?.text

      if (!fullPayload || isLitePayload(fullPayload) || typeof fullText !== 'string') {
        unavailableNoteUuids.push(note.uuid)
        continue
      }

      text = fullText
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

  if (unavailableNoteUuids.length > 0) {
    throw new Error(
      `Markdown export stopped because ${unavailableNoteUuids.length} ${
        unavailableNoteUuids.length === 1 ? 'note could' : 'notes could'
      } not be read in full from local storage. No incomplete export was downloaded.`,
    )
  }

  const blob = await application.archiveService.zipData(data)
  application.archiveService.downloadData(
    blob,
    `Standard Red Notes Markdown Export - ${application.archiveService.formattedDateForExports()}.zip`,
  )

  return notes.length
}
