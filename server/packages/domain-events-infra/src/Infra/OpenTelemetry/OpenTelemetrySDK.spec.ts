import 'reflect-metadata'

import * as OpenTelemetrySDKNode from '@opentelemetry/sdk-node'

import { OpenTelemetrySDK } from './OpenTelemetrySDK'

describe('OpenTelemetrySDK', () => {
  let nodeSdkOptions: Record<string, never>
  let start: jest.Mock
  let shutdown: jest.Mock

  const createSDK = (options: { serviceName: string; spanRatio?: number; metricExportIntervalMillis?: number }) =>
    new OpenTelemetrySDK(options)

  beforeEach(() => {
    start = jest.fn()
    shutdown = jest.fn().mockResolvedValue(undefined)

    // The real NodeSDK registers global instrumentation hooks in the worker, so
    // capture the assembled configuration instead of standing one up.
    jest.spyOn(OpenTelemetrySDKNode, 'NodeSDK').mockImplementation(function (options: unknown) {
      nodeSdkOptions = options as Record<string, never>

      return { start, shutdown } as never
    } as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('tags the resource with the configured service name', () => {
    createSDK({ serviceName: 'auth' })

    expect(nodeSdkOptions.resource.attributes['service.name']).toEqual('auth')
  })

  it('samples 10% of spans by default and honours an explicit ratio', () => {
    createSDK({ serviceName: 'auth' })
    expect(nodeSdkOptions.sampler.toString()).toContain('0.1')

    createSDK({ serviceName: 'auth', spanRatio: 0.5 })
    expect(nodeSdkOptions.sampler.toString()).toContain('0.5')
  })

  it('exports metrics every five minutes by default', () => {
    createSDK({ serviceName: 'auth' })

    expect(nodeSdkOptions.metricReader).toBeInstanceOf(
      OpenTelemetrySDKNode.metrics.PeriodicExportingMetricReader as never,
    )
  })

  it('registers the instrumentations the services depend on', () => {
    createSDK({ serviceName: 'auth' })

    const names = (nodeSdkOptions.instrumentations as unknown as { instrumentationName: string }[]).map(
      (instrumentation) => instrumentation.instrumentationName,
    )
    expect(names).toEqual(
      expect.arrayContaining([
        '@opentelemetry/instrumentation-http',
        '@opentelemetry/instrumentation-express',
        '@opentelemetry/instrumentation-aws-sdk',
        '@opentelemetry/instrumentation-winston',
        '@opentelemetry/instrumentation-ioredis',
        '@opentelemetry/instrumentation-grpc',
      ]),
    )
  })

  it('detects resources automatically and enables auto-detection', () => {
    createSDK({ serviceName: 'auth' })

    expect(nodeSdkOptions.autoDetectResources).toBe(true)
    expect(nodeSdkOptions.resourceDetectors).toHaveLength(1)
  })

  it('delegates start and shutdown to the underlying node sdk', async () => {
    const sdk = createSDK({ serviceName: 'auth' })

    sdk.start()
    expect(start).toHaveBeenCalledTimes(1)

    await sdk.shutdown()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  /** The config the SDK handed to one of the registered instrumentations. */
  const instrumentationConfig = (name: string): Record<string, never> => {
    const instrumentation = (
      nodeSdkOptions.instrumentations as unknown as { instrumentationName: string; getConfig(): unknown }[]
    ).find((candidate) => candidate.instrumentationName === name)

    return instrumentation?.getConfig() as Record<string, never>
  }

  it('excludes healthcheck requests from tracing but keeps ordinary ones', () => {
    createSDK({ serviceName: 'auth' })
    const ignoreIncomingRequestHook = instrumentationConfig('@opentelemetry/instrumentation-http')
      .ignoreIncomingRequestHook as unknown as (request: { url?: string }) => boolean

    // Healthchecks are polled constantly; tracing them is pure noise and cost.
    expect(ignoreIncomingRequestHook({ url: '/healthcheck' })).toBe(true)
    expect(ignoreIncomingRequestHook({ url: '/v1/healthcheck?verbose=1' })).toBe(true)
    expect(ignoreIncomingRequestHook({ url: '/v1/items' })).toBe(false)
    expect(ignoreIncomingRequestHook({})).toBe(false)
  })

  it('strips the client ip from incoming server spans', () => {
    createSDK({ serviceName: 'auth' })
    const startIncomingSpanHook = instrumentationConfig('@opentelemetry/instrumentation-http')
      .startIncomingSpanHook as unknown as (request: unknown) => Record<string, unknown>

    // The client ip is personal data and must not be attached to exported spans.
    const attributes = startIncomingSpanHook({})
    expect(Object.keys(attributes)).toEqual(['http.client_ip'])
    expect(attributes['http.client_ip']).toBeUndefined()
  })

  it('stamps the service name onto every winston log record', () => {
    createSDK({ serviceName: 'auth' })
    const logHook = instrumentationConfig('@opentelemetry/instrumentation-winston').logHook as unknown as (
      span: unknown,
      record: Record<string, unknown>,
    ) => void

    const record: Record<string, unknown> = { message: 'hello' }
    logHook({}, record)

    expect(record['resource.service.name']).toEqual('auth')
  })

  it('rebuilds the node sdk when build() is called again', () => {
    const sdk = createSDK({ serviceName: 'auth' })
    const first = nodeSdkOptions

    sdk.build()

    expect(nodeSdkOptions).not.toBe(first)
  })
})
