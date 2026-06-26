// Actions for the "Largest items" list in the Storage pane: open/navigate to an
// item, delete it (with confirmation), and export a selection as their native
// format in a zip. These wrap the app's EXISTING infrastructure rather than
// hand-rolling navigation/export/delete:
//
//   - open   -> LinkingController.activateItem (the same path used to open a linked
//               note/file; opens a File's preview), after closing Preferences.
//   - delete -> confirmDialog (ui-services) + mutator.deleteItems (notes) or
//               FilesController.deleteFile (files), then sync — matching how the app
//               deletes notes/files elsewhere.
//   - export -> createNoteExport (NoteExportUtils) for notes' native format, plus
//               decrypted file bytes, zipped via archiveService.zipData/downloadData.

import { WebApplication } from '@/Application/WebApplication'
import { createNoteExport } from '@/Utils/NoteExportUtils'
import { confirmDialog } from '@standardnotes/ui-services'
import { FileItem, isFile, isNote, SNNote } from '@standardnotes/snjs'
import { sanitizeFileName } from '@standardnotes/utils'
import { addToast, dismissToast, ToastType } from '@standardnotes/toast'
import { LinkableItem } from '@/Utils/Items/Search/LinkableItem'
import { StorageLargestItem } from '@/Utils/Storage/storageUsageWorkerProtocol'

/** Open / navigate to the item referenced by a largest-list row, closing Preferences. */
export async function openLargestItem(application: WebApplication, uuid: string): Promise<boolean> {
  const item = application.items.findItem(uuid)
  if (!item) {
    addToast({ type: ToastType.Error, message: 'This item is no longer available.' })
    return false
  }

  application.preferencesController.closePreferences()
  // activateItem opens a note in the editor, selects a tag, or previews a File.
  await application.linkingController.activateItem(item as LinkableItem)
  return true
}

/**
 * Delete the item behind a largest-list row after a confirmation dialog. Files go
 * through FilesController.deleteFile (which has its own confirm + toasts); notes and
 * everything else are permanently deleted via the mutator, then synced.
 */
export async function deleteLargestItem(application: WebApplication, row: StorageLargestItem): Promise<boolean> {
  const item = application.items.findItem(row.uuid)
  if (!item) {
    addToast({ type: ToastType.Error, message: 'This item is no longer available.' })
    return false
  }

  if (isFile(item)) {
    // FilesController.deleteFile already confirms, toasts and syncs.
    await application.filesController.deleteFile(item)
    return true
  }

  const label = row.title && row.title !== row.uuid ? `"${row.title}"` : 'this item'
  const confirmed = await confirmDialog({
    title: 'Delete item',
    text: `Permanently delete ${label}? This cannot be undone.`,
    confirmButtonStyle: 'danger',
    confirmButtonText: 'Delete',
  })
  if (!confirmed) {
    return false
  }

  await application.mutator.deleteItems([item])
  void application.sync.sync()
  return true
}

/** Resolve largest-list rows to live note/file items, dropping anything no longer present. */
function resolveExportableItems(
  application: WebApplication,
  rows: StorageLargestItem[],
): { notes: SNNote[]; files: FileItem[] } {
  const notes: SNNote[] = []
  const files: FileItem[] = []
  for (const row of rows) {
    const item = application.items.findItem(row.uuid)
    if (!item) {
      continue
    }
    if (isNote(item)) {
      notes.push(item)
    } else if (isFile(item)) {
      files.push(item)
    }
  }
  return { notes, files }
}

/**
 * Export the given largest-list rows (notes + files) as their NATIVE format in a
 * single zip. Notes are converted via the app's existing createNoteExport (honoring
 * the user's export-format prefs); files are decrypted to their raw bytes via
 * FilesController.getFileBlob. The zip is assembled and downloaded with the shared
 * archiveService.zipData/downloadData so we reuse the established export path.
 *
 * Returns the number of entries exported (0 = nothing exportable, nothing
 * downloaded).
 */
export async function exportLargestItems(application: WebApplication, rows: StorageLargestItem[]): Promise<number> {
  const { notes, files } = resolveExportableItems(application, rows)
  if (notes.length === 0 && files.length === 0) {
    addToast({ type: ToastType.Regular, message: 'Selected items can’t be exported (only notes and files).' })
    return 0
  }

  const toastId = addToast({ type: ToastType.Loading, message: 'Preparing export…' })
  try {
    const data: { name: string; content: Blob }[] = []

    // Notes: native format (reuses NoteExportUtils' converter + super handling).
    if (notes.length > 0) {
      const noteExport = await createNoteExport(application, notes)
      if (noteExport) {
        data.push({ name: noteExport.fileName, content: noteExport.blob })
      }
    }

    // Files: the decrypted file bytes under their original name.
    for (const file of files) {
      const blob = await application.filesController.getFileBlob(file)
      if (blob) {
        data.push({ name: sanitizeFileName(file.name) || file.uuid, content: blob })
      }
    }

    if (data.length === 0) {
      addToast({ type: ToastType.Error, message: 'Nothing could be exported.' })
      return 0
    }

    const zipBlob = await application.archiveService.zipData(data)
    application.archiveService.downloadData(
      zipBlob,
      `Standard Red Notes Storage Export - ${application.archiveService.formattedDateForExports()}.zip`,
    )
    addToast({ type: ToastType.Success, message: `Exported ${data.length} item${data.length === 1 ? '' : 's'}.` })
    return data.length
  } catch (error) {
    console.error(error)
    addToast({ type: ToastType.Error, message: 'Export failed. Please try again.' })
    return 0
  } finally {
    dismissToast(toastId)
  }
}
