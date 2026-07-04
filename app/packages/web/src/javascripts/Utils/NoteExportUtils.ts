import { WebApplication } from '@/Application/WebApplication'
import { HeadlessSuperConverter } from '@/Components/SuperEditor/Tools/HeadlessSuperConverter'
import { NoteType, PrefKey, SNNote, PrefDefaults, FileItem, PrefValue, isItemExportable } from '@standardnotes/snjs'
import { WebApplicationInterface } from '@standardnotes/ui-services'
import { type ZipDirectoryEntry } from '@zip.js/zip.js'
// @ts-ignore inline webpack loader imports
import superEditorCSS from '!css-loader?{"sourceMap":false}!sass-loader?{"api":"modern","sassOptions":{"quietDeps":true,"silenceDeprecations":["import","legacy-js-api"]}}!../Components/SuperEditor/Lexical/Theme/editor.scss'
// @ts-ignore inline webpack loader imports
import snColorsCSS from '!css-loader?{"sourceMap":false}!sass-loader?{"api":"modern","sassOptions":{"quietDeps":true,"silenceDeprecations":["import","legacy-js-api"]}}!@standardnotes/styles/src/Styles/_colors.scss'
// @ts-ignore inline webpack loader imports
import exportOverridesCSS from '!css-loader?{"sourceMap":false}!sass-loader?{"api":"modern","sassOptions":{"quietDeps":true,"silenceDeprecations":["import","legacy-js-api"]}}!../Components/SuperEditor/Lexical/Theme/export-overrides.scss'
import { getBase64FromBlob } from './Utils'
import { buildDocxBlobFromHtml, DOCX_MIME_TYPE } from './DocxExport'
import { parseFileName, parseAndCreateZippableFileName, sanitizeFileName } from '@standardnotes/utils'
import { getFullNoteText } from './Items/rehydrateLazyDecryptedNote'

export const getNoteFormat = (application: WebApplicationInterface, note: SNNote) => {
  if (note.noteType === NoteType.Super) {
    const superNoteExportFormatPref = application.getPreference(
      PrefKey.SuperNoteExportFormat,
      PrefDefaults[PrefKey.SuperNoteExportFormat],
    )

    return superNoteExportFormatPref
  }

  const editor = application.componentManager.editorForNote(note)
  return editor.fileType
}

export const getNoteFileName = (application: WebApplicationInterface, note: SNNote): string => {
  const format = getNoteFormat(application, note)
  const filename = sanitizeFileName(note.title)
  return `${filename}.${format}`
}

const headlessSuperConverter = new HeadlessSuperConverter()

const superHTML = (note: SNNote, content: string) => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${note.title}</title>
    <style>
${snColorsCSS.toString()}
${superEditorCSS.toString()}
${exportOverridesCSS.toString()}
    </style>
  </head>
  <body style="--font-size: 1rem; --line-height: 1.5; font-size: var(--font-size); line-height: var(--line-height);">
    ${content}
  </body>
</html>
`

const superMarkdown = (note: SNNote, content: string) => `---
title: ${note.title}
created_at: ${note.created_at.toISOString()}
updated_at: ${note.serverUpdatedAt.toISOString()}
uuid: ${note.uuid}
---

${content}
`

export const getNoteBlob = async (
  application: WebApplication,
  note: SNNote,
  superEmbedBehavior: PrefValue[PrefKey.SuperNoteExportEmbedBehavior],
  /**
   * LAZY-DECRYPT: the full note body. Under lazy-decrypt an un-opened note is a
   * body-less "lite" projection (`note.text === ''`), so callers MUST pass the
   * re-hydrated body here — reading raw `note.text` would export a blank file.
   * Defaults to `note.text` for the flag-off / already-full case.
   */
  noteText: string = note.text,
) => {
  const format = getNoteFormat(application, note)
  let type: string
  switch (format as string) {
    case 'html':
      type = 'text/html'
      break
    case 'json':
      type = 'application/json'
      break
    case 'md':
      type = 'text/markdown'
      break
    case 'pdf':
      type = 'application/pdf'
      break
    case 'docx':
      type = DOCX_MIME_TYPE
      break
    default:
      type = 'text/plain'
      break
  }
  if (note.noteType === NoteType.Super) {
    const isDocx = (format as string) === 'docx'
    // A Word document is produced from the HTML export, embedded as an altChunk.
    const converterFormat = (isDocx ? 'html' : format) as 'txt' | 'md' | 'html' | 'json' | 'pdf'
    const content = await headlessSuperConverter.convertSuperStringToOtherFormat(noteText, converterFormat, {
      embedBehavior: superEmbedBehavior,
      getFileItem: (id) => application.items.findItem<FileItem>(id),
      getFileBase64: async (id) => {
        const fileItem = application.items.findItem<FileItem>(id)
        if (!fileItem) {
          return
        }
        const fileBlob = await application.filesController.getFileBlob(fileItem)
        if (!fileBlob) {
          return
        }
        return await getBase64FromBlob(fileBlob)
      },
      pdf: {
        pageSize: application.getPreference(
          PrefKey.SuperNoteExportPDFPageSize,
          PrefDefaults[PrefKey.SuperNoteExportPDFPageSize],
        ),
      },
    })
    if (isDocx) {
      return buildDocxBlobFromHtml(superHTML(note, content))
    }
    const useMDFrontmatter =
      format === 'md' &&
      application.getPreference(
        PrefKey.SuperNoteExportUseMDFrontmatter,
        PrefDefaults[PrefKey.SuperNoteExportUseMDFrontmatter],
      )
    // result is a data url string if format is pdf
    const result =
      format === 'html' ? superHTML(note, content) : useMDFrontmatter ? superMarkdown(note, content) : content
    const blob =
      format === 'pdf'
        ? await fetch(result).then((res) => res.blob())
        : new Blob([result], {
            type,
          })
    return blob
  }
  const blob = new Blob([noteText], {
    type,
  })
  return blob
}

const isSuperNote = (note: SNNote) => {
  return note.noteType === NoteType.Super
}

export const noteHasEmbeddedFiles = (note: SNNote, noteText: string = note.text) => {
  return noteText.includes('"type":"snfile"')
}

const noteRequiresFolder = (
  note: SNNote,
  superExportFormat: PrefValue[PrefKey.SuperNoteExportFormat],
  superEmbedBehavior: PrefValue[PrefKey.SuperNoteExportEmbedBehavior],
  noteText: string = note.text,
) => {
  if (!isSuperNote(note)) {
    return false
  }
  if (
    superExportFormat === 'json' ||
    superExportFormat === 'pdf' ||
    (superExportFormat as string) === 'docx' ||
    (superExportFormat as string) === 'txt'
  ) {
    return false
  }
  if (superEmbedBehavior !== 'separate') {
    return false
  }
  return noteHasEmbeddedFiles(note, noteText)
}

const addEmbeddedFilesToFolder = async (
  application: WebApplication,
  note: SNNote,
  folder: ZipDirectoryEntry,
  noteText: string = note.text,
) => {
  try {
    const filenameCounts: Record<string, number> = {}
    const embeddedFileIDs = headlessSuperConverter.getEmbeddedFileIDsFromSuperString(noteText)
    for (const embeddedFileID of embeddedFileIDs) {
      const fileItem = application.items.findItem<FileItem>(embeddedFileID)
      if (!fileItem) {
        continue
      }
      const embeddedFileBlob = await application.filesController.getFileBlob(fileItem)
      if (!embeddedFileBlob) {
        continue
      }
      filenameCounts[fileItem.title] =
        filenameCounts[fileItem.title] == undefined ? 0 : filenameCounts[fileItem.title] + 1
      let name = fileItem.title
      if (filenameCounts[fileItem.title] > 0) {
        const { name: _name, ext } = parseFileName(fileItem.title)
        name = `${_name}-${fileItem.uuid}.${ext}`
      }
      folder.addBlob(parseAndCreateZippableFileName(name), embeddedFileBlob)
    }
  } catch (error) {
    console.error(error)
  }
}

export const createNoteExport = async (
  application: WebApplication,
  notes: SNNote[],
): Promise<
  | {
      blob: Blob
      fileName: string
    }
  | undefined
> => {
  // A note export is human-consumable / decrypted output, so never emit an items key or user
  // preferences even if a caller passes one in (shared rule with the bulk + storage exports).
  notes = notes.filter((note) => isItemExportable(note))
  if (notes.length === 0) {
    return
  }

  const superExportFormatPref = application.getPreference(
    PrefKey.SuperNoteExportFormat,
    PrefDefaults[PrefKey.SuperNoteExportFormat],
  )
  const superEmbedBehaviorPref =
    superExportFormatPref === 'pdf' || (superExportFormatPref as string) === 'docx'
      ? 'inline'
      : application.getPreference(
          PrefKey.SuperNoteExportEmbedBehavior,
          PrefDefaults[PrefKey.SuperNoteExportEmbedBehavior],
        )

  if (notes.length === 1) {
    // LAZY-DECRYPT: an un-opened note is a body-less "lite" projection
    // (`note.text === ''`); re-hydrate the full body from IndexedDB before reading
    // it, or the export writes a blank file and silently drops embedded files.
    // No-op / byte-identical when the flag is off (note is never lite).
    const singleNote = notes[0]
    const singleNoteText = await getFullNoteText(application.sync, singleNote)

    if (!noteRequiresFolder(singleNote, superExportFormatPref, superEmbedBehaviorPref, singleNoteText)) {
      const blob = await getNoteBlob(application, singleNote, superEmbedBehaviorPref, singleNoteText)
      const fileName = getNoteFileName(application, singleNote)
      return {
        blob,
        fileName,
      }
    }

    const zip = await import('@zip.js/zip.js')
    const zipFS = new zip.fs.FS()
    const { root } = zipFS

    const blob = await getNoteBlob(application, singleNote, superEmbedBehaviorPref, singleNoteText)
    const fileName = parseAndCreateZippableFileName(getNoteFileName(application, singleNote))
    root.addBlob(fileName, blob)

    await addEmbeddedFilesToFolder(application, singleNote, root, singleNoteText)

    const zippedBlob = await zipFS.exportBlob()
    return {
      blob: zippedBlob,
      fileName: fileName + '.zip',
    }
  }

  const zip = await import('@zip.js/zip.js')
  const zipFS = new zip.fs.FS()
  const { root } = zipFS

  const filenameCounts: Record<string, number> = {}

  for (const note of notes) {
    // LAZY-DECRYPT: re-hydrate each note's body before it is read (see above).
    const noteText = await getFullNoteText(application.sync, note)
    const blob = await getNoteBlob(application, note, superEmbedBehaviorPref, noteText)
    const _name = parseAndCreateZippableFileName(getNoteFileName(application, note))

    filenameCounts[_name] = filenameCounts[_name] == undefined ? 0 : filenameCounts[_name] + 1

    const currentFileNameIndex = filenameCounts[_name]

    const fileName = parseAndCreateZippableFileName(_name, currentFileNameIndex > 0 ? ` - ${currentFileNameIndex}` : '')

    if (!noteRequiresFolder(note, superExportFormatPref, superEmbedBehaviorPref, noteText)) {
      root.addBlob(fileName, blob)
      continue
    }

    const { name } = parseFileName(fileName)
    const folder = root.addDirectory(name)
    folder.addBlob(fileName, blob)
    await addEmbeddedFilesToFolder(application, note, folder, noteText)
  }

  const zippedBlob = await zipFS.exportBlob()

  return {
    blob: zippedBlob,
    fileName: `Standard Red Notes Export - ${application.archiveService.formattedDateForExports()}.zip`,
  }
}
