import { saveFile } from '../utils'
import { ClassicFileSaver } from './ClassicSaver'

jest.mock('../utils', () => ({
  saveFile: jest.fn(),
}))

const saveFileMock = saveFile as jest.MockedFunction<typeof saveFile>

describe('ClassicFileSaver', () => {
  beforeEach(() => {
    saveFileMock.mockClear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('should cap the classic (non-streaming) path at 50 MB', () => {
    expect(ClassicFileSaver.maximumFileSize()).toBe(50_000_000)
  })

  it('should delegate to the DOM download helper with the name and bytes', () => {
    const bytes = new Uint8Array([1, 2, 3])

    new ClassicFileSaver().saveFile('note.txt', bytes)

    expect(saveFileMock).toHaveBeenCalledWith('note.txt', bytes)
  })

  it('should not log by default', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    new ClassicFileSaver().saveFile('note.txt', new Uint8Array([1]))

    expect(log).not.toHaveBeenCalled()
  })

  it('should log before and after the save once logging is enabled', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const saver = new ClassicFileSaver()
    saver.loggingEnabled = true

    saver.saveFile('note.txt', new Uint8Array([1]))

    expect(log.mock.calls).toEqual([[['Saving file to disk...']], [['Closing write stream']]])
  })
})
