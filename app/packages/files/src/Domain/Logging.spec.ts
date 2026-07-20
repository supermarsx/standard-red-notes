import { logWithColor } from '@standardnotes/utils'
import { isDev, log, LoggingDomain } from './Logging'

jest.mock('@standardnotes/utils', () => ({
  logWithColor: jest.fn(),
}))

const logWithColorMock = logWithColor as jest.MockedFunction<typeof logWithColor>

describe('Logging', () => {
  beforeEach(() => {
    logWithColorMock.mockClear()
  })

  it('should treat the test environment as a dev environment', () => {
    expect(process.env.NODE_ENV).toBe('test')
    expect(isDev).toBe(true)
  })

  it('should expose a FilesPackage logging domain', () => {
    expect(LoggingDomain[LoggingDomain.FilesPackage]).toBe('FilesPackage')
  })

  it('should not emit anything while the FilesPackage domain is switched off', () => {
    log(LoggingDomain.FilesPackage, 'anything', 1, 2)

    expect(logWithColorMock).not.toHaveBeenCalled()
  })
})
