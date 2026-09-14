import { createGatewayLoggerBridge, formatGatewayLogArgument } from './GatewayLoggerBridge'

describe('GatewayLoggerBridge', () => {
  const host = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })

  // N1: the previous bridge did `args.map(String)`, so every metadata object
  // the gateway logs — the per-push `{ socketCount }`, every redacted
  // `{ errorType, errorCode }` — reached the log as `[object Object]`.
  it('serialises metadata objects instead of printing [object Object]', () => {
    const logger = host()

    createGatewayLoggerBridge(logger).info('[push:sqs] dispatched websocket message', { socketCount: 3 })

    expect(logger.info).toHaveBeenCalledWith('[push:sqs] dispatched websocket message {"socketCount":3}')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('[object Object]')
  })

  it('routes each level to the matching host method as one message line', () => {
    const logger = host()
    const bridge = createGatewayLoggerBridge(logger)

    bridge.warn('a', 1, true)
    bridge.error('b', { errorType: 'Error', errorCode: undefined })
    bridge.debug('c')

    expect(logger.warn).toHaveBeenCalledWith('a 1 true')
    expect(logger.error).toHaveBeenCalledWith('b {"errorType":"Error"}')
    expect(logger.debug).toHaveBeenCalledWith('c')
  })

  it('renders errors and JSON-hostile values via inspect rather than {} or a throw', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(formatGatewayLogArgument(new Error('boom'))).toContain('Error: boom')
    expect(formatGatewayLogArgument(circular)).toContain('Circular')
    expect(formatGatewayLogArgument(undefined)).toBe('undefined')
    expect(formatGatewayLogArgument(10n)).toBe('10n')
    expect(formatGatewayLogArgument('plain')).toBe('plain')
  })
})
