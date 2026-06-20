import { FilesController } from '@/Controllers/FilesController'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import { FileWithPath } from './DirectoryUpload'
import { uploadFilesWithFolderStructure } from './FolderUpload'

/**
 * Standard Red Notes: tests for the folder-structure bulk uploader.
 *
 * Verifies that distinct folder paths are pre-created (deduped) before upload, and
 * that each uploaded file is filed into the folder for its relative path while
 * files at the root are left unfiled.
 */

const fileWithPath = (path: string): FileWithPath => ({
  file: new File(['x'], path.split('/').pop() ?? 'f'),
  path,
})

type Folder = { uuid: string; title: string }

const makeControllers = () => {
  const folders: Folder[] = []
  let counter = 0

  const ensureFolderPath = jest.fn(async (segments: string[]): Promise<Folder | undefined> => {
    const joined = segments.join('/')
    const existing = folders.find((f) => f.title === joined)
    if (existing) {
      return existing
    }
    const folder = { uuid: `folder-${counter++}`, title: joined }
    folders.push(folder)
    return folder
  })

  const moveFileToFolder = jest.fn().mockResolvedValue(undefined)

  // uploadFiles invokes onFileUploaded for each file with its path, mimicking the
  // real FilesController fan-out.
  const uploadFiles = jest.fn(
    async (
      files: FileWithPath[],
      opts: { onFileUploaded: (file: unknown, path?: string) => Promise<void> },
    ) => {
      for (const { file, path } of files) {
        await opts.onFileUploaded(file, path)
      }
    },
  )

  const navigationController = {
    ensureFolderPath,
    moveFileToFolder,
    get folders() {
      return folders
    },
  } as unknown as NavigationController

  const filesController = { uploadFiles } as unknown as FilesController

  return { filesController, navigationController, ensureFolderPath, moveFileToFolder, uploadFiles, folders }
}

describe('uploadFilesWithFolderStructure', () => {
  it('pre-creates each distinct folder path exactly once', async () => {
    const c = makeControllers()
    const files = [
      fileWithPath('photos/2024/a.jpg'),
      fileWithPath('photos/2024/b.jpg'), // same folder -> dedupe
      fileWithPath('docs/c.txt'),
    ]
    await uploadFilesWithFolderStructure(files, c)

    expect(c.ensureFolderPath).toHaveBeenCalledTimes(2)
    expect(c.ensureFolderPath).toHaveBeenCalledWith(['photos', '2024'])
    expect(c.ensureFolderPath).toHaveBeenCalledWith(['docs'])
  })

  it('files each uploaded file into the folder for its path', async () => {
    const c = makeControllers()
    await uploadFilesWithFolderStructure([fileWithPath('photos/2024/a.jpg')], c)
    expect(c.moveFileToFolder).toHaveBeenCalledTimes(1)
    const [, folderArg] = c.moveFileToFolder.mock.calls[0]
    expect((folderArg as Folder).title).toBe('photos/2024')
  })

  it('leaves root-level files unfiled (no moveFileToFolder)', async () => {
    const c = makeControllers()
    await uploadFilesWithFolderStructure([fileWithPath('a.jpg')], c)
    expect(c.ensureFolderPath).not.toHaveBeenCalled()
    expect(c.moveFileToFolder).not.toHaveBeenCalled()
    expect(c.uploadFiles).toHaveBeenCalledTimes(1)
  })

  it('does not move a file when its folder could not be created', async () => {
    const c = makeControllers()
    c.ensureFolderPath.mockResolvedValueOnce(undefined)
    await uploadFilesWithFolderStructure([fileWithPath('photos/a.jpg')], c)
    expect(c.moveFileToFolder).not.toHaveBeenCalled()
  })
})
