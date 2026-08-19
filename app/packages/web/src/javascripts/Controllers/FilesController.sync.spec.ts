import { FileItemActionType } from '@/Components/AttachedFilesPopover/PopoverFileItemAction'
import { ContentType, FileItem } from '@standardnotes/snjs'
import { FilesController } from './FilesController'

describe('FilesController sync scheduling', () => {
  it('schedules exactly one sync for one attachment mutation', async () => {
    const file = {
      uuid: 'file-1',
      content_type: ContentType.TYPES.File,
      name: 'attachment.txt',
      mimeType: 'text/plain',
      protected: false,
    } as FileItem
    const note = { uuid: 'note-1' }
    const sync = { sync: jest.fn().mockResolvedValue(undefined) }
    const mutator = { associateFileWithNote: jest.fn().mockResolvedValue(undefined) }
    const items = {
      findItem: jest.fn().mockReturnValue(file),
      streamItems: jest.fn().mockReturnValue(jest.fn()),
    }
    const controller = new FilesController(
      { firstSelectedNote: note, selectedNotes: [note] } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      items as never,
      {} as never,
      mutator as never,
      sync as never,
      {} as never,
      {} as never,
      'linux-web' as never,
      undefined,
      {} as never,
      {} as never,
      () => true,
      {} as never,
    )

    await expect(
      controller.handleFileAction({
        type: FileItemActionType.AttachFileToNote,
        payload: { file },
      }),
    ).resolves.toEqual({ didHandleAction: true })

    expect(mutator.associateFileWithNote).toHaveBeenCalledTimes(1)
    expect(mutator.associateFileWithNote).toHaveBeenCalledWith(file, note)
    expect(sync.sync).toHaveBeenCalledTimes(1)

    controller.deinit()
  })
})
