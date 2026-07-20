import { Logger } from './Logger'

describe('Logger', () => {
  let log: jest.SpyInstance
  let warn: jest.SpyInstance
  let error: jest.SpyInstance
  let logger: Logger

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    logger = new Logger('app')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('should suppress everything at the default "none" level', () => {
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('should emit every level at "debug"', () => {
    logger.setLevel('debug')

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(log).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('should drop debug but keep info and above at "info"', () => {
    logger.setLevel('info')

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(log).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('should keep only warn and error at "warn"', () => {
    logger.setLevel('warn')

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(log).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('should keep only error at "error"', () => {
    logger.setLevel('error')

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('should suppress everything again when the level is set back to "none"', () => {
    logger.setLevel('error')
    logger.setLevel('none')

    logger.error('e')

    expect(error).not.toHaveBeenCalled()
  })

  it('should forward warn and error arguments verbatim', () => {
    logger.setLevel('warn')

    logger.warn('careful', 1, { a: 2 })
    logger.error('broken', 'detail')

    expect(warn).toHaveBeenCalledWith('careful', 1, { a: 2 })
    expect(error).toHaveBeenCalledWith('broken', 'detail')
  })

  it('should prefix debug and info output with the app identifier and a timestamp', () => {
    logger.setLevel('debug')

    logger.info('hello', 42)

    const [format, , , ...rest] = log.mock.calls[0]
    expect(format).toMatch(/^%capp%c\d/)
    expect(rest).toEqual(['hello', 42])
  })
})
