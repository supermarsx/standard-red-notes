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

  it('should redact credential, session, PII, and content fields at the variadic logger sink', () => {
    logger.setLevel('debug')

    logger.error('request failed', {
      accessToken: 'access-token-sentinel',
      refreshToken: 'refresh-token-sentinel',
      offlineToken: 'offline-token-sentinel',
      featuresToken: 'features-token-sentinel',
      subscriptionToken: 'subscription-token-sentinel',
      sessionKey: 'session-key-sentinel',
      sessionUuid: 'session-uuid-sentinel',
      cookie: 'cookie-sentinel',
      password: 'password-sentinel',
      codeVerifier: 'pkce-sentinel',
      apiKey: 'api-key-sentinel',
      email: 'person@example.test',
      content: 'encrypted-content-sentinel',
      userId: 'user-123',
    })

    const serialized = JSON.stringify(error.mock.calls)
    for (const sentinel of [
      'access-token-sentinel',
      'refresh-token-sentinel',
      'offline-token-sentinel',
      'features-token-sentinel',
      'subscription-token-sentinel',
      'session-key-sentinel',
      'session-uuid-sentinel',
      'cookie-sentinel',
      'password-sentinel',
      'pkce-sentinel',
      'api-key-sentinel',
      'person@example.test',
      'encrypted-content-sentinel',
    ]) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(serialized).toContain('user-123')
  })

  it('should project Error instances to allowlisted metadata without message or stack text', () => {
    logger.setLevel('debug')
    const thrown = Object.assign(new Error('opaque-upstream-secret'), {
      code: 'ERR_NETWORK',
      accessToken: 'access-token-sentinel',
    })

    logger.error('request failed', thrown)

    expect(error).toHaveBeenCalledWith('request failed', {
      errorType: 'Error',
      errorCode: 'ERR_NETWORK',
      status: undefined,
    })
    const serialized = JSON.stringify(error.mock.calls)
    expect(serialized).not.toContain('opaque-upstream-secret')
    expect(serialized).not.toContain('access-token-sentinel')
  })
})
