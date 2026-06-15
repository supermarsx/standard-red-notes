import { WebApplication } from '@/Application/WebApplication'
import { HeadlessSuperConverter } from '@/Components/SuperEditor/Tools/HeadlessSuperConverter'
import { FileItem, NoteType, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { sanitizeFileName } from '@standardnotes/utils'
import { getBase64FromBlob } from './Utils'

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
  const notes = application.items.getDisplayableNotes()
  if (notes.length === 0) {
    return 0
  }

  const data: { name: string; content: Blob }[] = []
  for (const note of notes) {
    const markdown = await noteToMarkdown(application, note)
    const title = sanitizeFileName(note.title || 'Untitled')
    data.push({
      name: `${title}-${note.uuid.split('-')[0]}.md`,
      content: new Blob([markdown], { type: 'text/markdown' }),
    })
  }

  const blob = await application.archiveService.zipData(data)
  application.archiveService.downloadData(
    blob,
    `Standard Red Notes Markdown Export - ${application.archiveService.formattedDateForExports()}.zip`,
  )
  return notes.length
}
