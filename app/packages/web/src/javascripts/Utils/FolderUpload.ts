import { FilesController } from '@/Controllers/FilesController'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import { FileWithPath, folderSegmentsForPath } from './DirectoryUpload'

/**
 * Standard Red Notes: upload a batch of files and recreate the dropped/selected
 * folder structure using the existing file-folders mechanism.
 *
 * Folder paths are resolved/created up front (reusing folders with matching
 * titles) so concurrent uploads don't race to create the same folder. Each
 * uploaded file is then filed into the folder for its relative path via
 * `navigationController.moveFileToFolder`. Files whose path has no folder
 * component are left unfiled ("No folder"), matching a plain multi-file upload.
 *
 * This recreates the full nested structure — see the comment in the caller for
 * the rationale. All size / large-file / local-only handling is preserved
 * because uploads go through `FilesController.uploadFiles`, which routes each
 * file through the unchanged single-file upload path.
 */
export const uploadFilesWithFolderStructure = async (
  filesWithPaths: FileWithPath[],
  controllers: {
    filesController: FilesController
    navigationController: NavigationController
  },
): Promise<void> => {
  const { filesController, navigationController } = controllers

  // Pre-create every distinct folder path so workers don't create duplicates.
  const distinctPaths = new Set<string>()
  for (const { path } of filesWithPaths) {
    const segments = folderSegmentsForPath(path)
    if (segments.length > 0) {
      distinctPaths.add(segments.join('/'))
    }
  }

  const folderUuidByPath = new Map<string, string | undefined>()
  for (const joined of distinctPaths) {
    const folder = await navigationController.ensureFolderPath(joined.split('/'))
    folderUuidByPath.set(joined, folder?.uuid)
  }

  await filesController.uploadFiles(filesWithPaths, {
    onFileUploaded: async (file, path) => {
      const segments = path ? folderSegmentsForPath(path) : []
      if (segments.length === 0) {
        return
      }
      const folderUuid = folderUuidByPath.get(segments.join('/'))
      if (!folderUuid) {
        return
      }
      const folder = navigationController.folders.find((candidate) => candidate.uuid === folderUuid)
      if (folder) {
        await navigationController.moveFileToFolder(file, folder)
      }
    },
  })
}
