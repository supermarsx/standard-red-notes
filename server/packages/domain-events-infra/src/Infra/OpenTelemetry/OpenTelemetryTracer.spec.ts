import 'reflect-metadata'

import * as OpenTelemetryApi from '@opentelemetry/api'

import { OpenTelemetryTracer } from './OpenTelemetryTracer'

describe('OpenTelemetryTracer', () => {
  let parentSpan: { end: jest.Mock; recordException: jest.Mock }
  let internalSpan: { end: jest.Mock; recordException: jest.Mock }
  let startSpan: jest.Mock
  let setSpan: jest.SpyInstance

  const createTracer = () => new OpenTelemetryTracer()

  const makeSpan = () => ({ end: jest.fn(), recordException: jest.fn() })

  beforeEach(() => {
    parentSpan = makeSpan()
    internalSpan = makeSpan()

    startSpan = jest.fn().mockReturnValueOnce(parentSpan).mockReturnValueOnce(internalSpan)
    jest.spyOn(OpenTelemetryApi.trace, 'getTracer').mockReturnValue({ startSpan } as never)
    setSpan = jest.spyOn(OpenTelemetryApi.trace, 'setSpan').mockReturnValue('parent-context' as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('opens a consumer parent span and an internal child span under it', () => {
    createTracer().startSpan('handle-event', 'persist')

    expect(OpenTelemetryApi.trace.getTracer).toHaveBeenCalledWith('handle-event-handler')
    expect(startSpan).toHaveBeenNthCalledWith(1, 'handle-event', { kind: OpenTelemetryApi.SpanKind.CONSUMER })
    expect(setSpan).toHaveBeenCalledWith(expect.anything(), parentSpan)
    // The child is started inside the parent's context, not the ambient one.
    expect(startSpan).toHaveBeenNthCalledWith(
      2,
      'persist',
      { kind: OpenTelemetryApi.SpanKind.INTERNAL },
      'parent-context',
    )
  })

  it('ends both spans on stopSpan', () => {
    const tracer = createTracer()
    tracer.startSpan('handle-event', 'persist')

    tracer.stopSpan()

    expect(internalSpan.end).toHaveBeenCalledTimes(1)
    expect(parentSpan.end).toHaveBeenCalledTimes(1)
  })

  it('does not end the same spans twice', () => {
    const tracer = createTracer()
    tracer.startSpan('handle-event', 'persist')

    tracer.stopSpan()
    tracer.stopSpan()

    expect(internalSpan.end).toHaveBeenCalledTimes(1)
    expect(parentSpan.end).toHaveBeenCalledTimes(1)
  })

  it('records the exception on the internal span before ending both', () => {
    const tracer = createTracer()
    tracer.startSpan('handle-event', 'persist')
    const error = new Error('handler blew up')

    tracer.stopSpanWithError(error)

    expect(internalSpan.recordException).toHaveBeenCalledWith(error)
    expect(internalSpan.end).toHaveBeenCalledTimes(1)
    expect(parentSpan.end).toHaveBeenCalledTimes(1)
    // The parent carries the failure via its child, not a second recorded exception.
    expect(parentSpan.recordException).not.toHaveBeenCalled()
  })

  it('tolerates stopSpan and stopSpanWithError before any span was started', () => {
    expect(() => createTracer().stopSpan()).not.toThrow()
    expect(() => createTracer().stopSpanWithError(new Error('boom'))).not.toThrow()
  })

  it('starts a fresh pair of spans after the previous pair was stopped', () => {
    const tracer = createTracer()
    tracer.startSpan('first', 'inner')
    tracer.stopSpan()

    const secondParent = makeSpan()
    const secondInternal = makeSpan()
    startSpan.mockReturnValueOnce(secondParent).mockReturnValueOnce(secondInternal)

    tracer.startSpan('second', 'inner')
    tracer.stopSpan()

    expect(secondParent.end).toHaveBeenCalledTimes(1)
    expect(secondInternal.end).toHaveBeenCalledTimes(1)
    expect(parentSpan.end).toHaveBeenCalledTimes(1)
  })
})
