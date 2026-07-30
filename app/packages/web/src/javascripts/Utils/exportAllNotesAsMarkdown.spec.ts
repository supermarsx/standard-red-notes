/**
 * @jest-environment jsdom
 */
import { ContentType } from '@standardnotes/snjs'

import { exportAllNotesAsMarkdown } from './exportAllNotesAsMarkdown'

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })

const note = (uuid: string, text: string, lite = false) => ({
  uuid,
  content_type: ContentType.TYPES.Note,
  title: `Title ${uuid}`,
  text: lite ? '' : text,
  payload: {
    uuid,
    content_type: ContentType.TYPES.Note,
    content: lite ? { title: `Title ${uuid}`, __lazyLite: true } : { title: `Title ${uuid}`, text },
  },
})

const application = (options?: {
  notes?: ReturnType<typeof note>[]
  invalidItems?: { uuid: string; content_type: string }[]
  getFullContentPayload?: jest.Mock
}) => {
  const zipData = jest.fn().mockResolvedValue(new Blob(['zip']))
  const downloadData = jest.fn()
  const getDisplayableNotes = jest.fn().mockReturnValue([])

  return {
    app: {
      items: {
        items: options?.notes ?? [],
        invalidItems: options?.invalidItems ?? [],
        getDisplayableNotes,
      },
      sync: {
        getFullContentPayload: options?.getFullContentPayload ?? jest.fn(),
      },
      archiveService: {
        zipData,
        downloadData,
        formattedDateForExports: jest.fn().mockReturnValue('date'),
      },
      getPreference: jest.fn(),
    },
    zipData,
    downloadData,
    getDisplayableNotes,
  }
}

describe('exportAllNotesAsMarkdown', () => {
  it('exports all decrypted notes rather than only the current display projection', async () => {
    const { app, zipData, downloadData, getDisplayableNotes } = application({
      notes: [note('archived-or-other-vault', 'Complete body')],
    })

    const count = await exportAllNotesAsMarkdown(app as never)

    expect(count).toBe(1)
    expect(getDisplayableNotes).not.toHaveBeenCalled()
    expect(zipData).toHaveBeenCalledTimes(1)
    expect(downloadData).toHaveBeenCalledTimes(1)
  })

  it('fails before creating a zip when an unreadable note exists', async () => {
    const { app, zipData, downloadData } = application({
      notes: [note('readable', 'Complete body')],
      invalidItems: [{ uuid: 'unreadable', content_type: ContentType.TYPES.Note }],
    })

    await expect(exportAllNotesAsMarkdown(app as never)).rejects.toThrow(
      '1 note is unreadable with the keys currently available',
    )
    expect(zipData).not.toHaveBeenCalled()
    expect(downloadData).not.toHaveBeenCalled()
  })

  it('fails before creating a zip when a lite note cannot be read in full', async () => {
    const getFullContentPayload = jest.fn().mockResolvedValue(undefined)
    const { app, zipData, downloadData } = application({
      notes: [note('lite-note', '', true)],
      getFullContentPayload,
    })

    await expect(exportAllNotesAsMarkdown(app as never)).rejects.toThrow(
      '1 note could not be read in full from local storage',
    )
    expect(getFullContentPayload).toHaveBeenCalledWith('lite-note')
    expect(zipData).not.toHaveBeenCalled()
    expect(downloadData).not.toHaveBeenCalled()
  })

  it('exports a lite note only after its complete body is confirmed', async () => {
    const getFullContentPayload = jest.fn().mockResolvedValue({
      uuid: 'lite-note',
      content_type: ContentType.TYPES.Note,
      content: { title: 'Title lite-note', text: 'Re-hydrated body' },
    })
    const { app, zipData, downloadData } = application({
      notes: [note('lite-note', '', true)],
      getFullContentPayload,
    })

    const count = await exportAllNotesAsMarkdown(app as never)

    expect(count).toBe(1)
    expect(zipData).toHaveBeenCalledTimes(1)
    const zippedEntries = zipData.mock.calls[0][0] as { content: Blob }[]
    expect(await readBlob(zippedEntries[0].content)).toBe('Re-hydrated body')
    expect(downloadData).toHaveBeenCalledTimes(1)
  })
})
