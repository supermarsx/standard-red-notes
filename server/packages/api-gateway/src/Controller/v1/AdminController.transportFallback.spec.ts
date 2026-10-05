import 'reflect-metadata'

import { Request, Response } from 'express'

import { AdminController } from './AdminController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { deploymentDiagnostics, observeDeployment } from '../../Service/Diagnostics/DeploymentDiagnostics'
import { grpcTransportFallbackDiagnostics } from '../../Service/gRPC/GrpcTransportFallbackDiagnostics'

jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue([]),
}))

/**
 * Standard Red Notes: the RUNTIME half of /v1/admin/sync-diagnostics.
 *
 * `deployment.boundServiceProxy` is recorded ONCE, at container configuration
 * time. A gRPC listener that dies after boot therefore leaves it reading
 * `'grpc'` forever while `GRPCServiceProxy` falls back and serves every call
 * over HTTP — two materially different deployments that used to look identical
 * through this endpoint.
 *
 * The counters that separate them are worth nothing unless they actually reach
 * the payload, which is the lesson this repository keeps relearning: a recorder
 * nobody reads is not a diagnostic. So the wiring is asserted here rather than
 * assumed from the code.
 *
 * This lives in its own file, beside `AdminController.syncDiagnostics.spec.ts`
 * rather than inside it, because the recorder is a process global: a file that
 * owns its clearing cannot have its counters perturbed by a neighbouring suite's
 * fixtures, and vice versa.
 */
describe('AdminController sync-diagnostics transport fallback', () => {
  let jsonMock: jest.Mock

  const makeController = () => new AdminController({} as ServiceProxyInterface, {} as EndpointResolverInterface)

  const adminResponse = (): Response => {
    jsonMock = jest.fn()
    return {
      locals: { user: { uuid: 'admin-1' }, roles: [{ name: 'ADMIN_USER' }] },
      setHeader: jest.fn(),
      status: jest.fn(() => ({ json: jsonMock })),
      json: jsonMock,
    } as unknown as Response
  }

  type Payload = {
    deployment: { boundServiceProxy: string }
    transportFallback: {
      observed: boolean
      everDegraded: boolean
      lanes: Record<string, { degradedCalls: number; refusedCalls: number; lastFailureClass: string | null }>
    }
  }

  const diagnose = async (): Promise<Payload> => {
    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    return jsonMock.mock.calls[0][0] as Payload
  }

  const recordBoundProxy = (boundServiceProxy: 'grpc' | 'http') => {
    deploymentDiagnostics.record(
      observeDeployment(() => undefined, {
        boundServiceProxy,
        grpcSyncingProxyBound: boundServiceProxy === 'grpc',
        redisBound: true,
      }),
    )
  }

  beforeEach(() => {
    grpcTransportFallbackDiagnostics.clear()
    deploymentDiagnostics.clear()
  })

  afterAll(() => {
    grpcTransportFallbackDiagnostics.clear()
    deploymentDiagnostics.clear()
  })

  it('carries the transport fallback block with both lanes at zero on a healthy gateway', async () => {
    recordBoundProxy('grpc')

    const { deployment, transportFallback } = await diagnose()

    expect(deployment.boundServiceProxy).toBe('grpc')
    expect(transportFallback.observed).toBe(false)
    expect(transportFallback.everDegraded).toBe(false)
    expect(transportFallback.lanes['session-validation']).toMatchObject({ degradedCalls: 0, refusedCalls: 0 })
    expect(transportFallback.lanes['items-sync']).toMatchObject({ degradedCalls: 0, refusedCalls: 0 })
  })

  /**
   * The state that had no representation before: the branch that ran was gRPC,
   * and the calls are going out over HTTP.
   */
  it('distinguishes a gateway that BOUND gRPC but is SERVING over HTTP', async () => {
    recordBoundProxy('grpc')
    grpcTransportFallbackDiagnostics.recordDegradation('session-validation', 'channel-unavailable')
    grpcTransportFallbackDiagnostics.recordDegradation('items-sync', 'method-unimplemented')

    const { deployment, transportFallback } = await diagnose()

    expect(deployment.boundServiceProxy).toBe('grpc')
    expect(transportFallback.everDegraded).toBe(true)
    expect(transportFallback.lanes['session-validation']).toMatchObject({
      degradedCalls: 1,
      lastFailureClass: 'channel-unavailable',
    })
    expect(transportFallback.lanes['items-sync']).toMatchObject({
      degradedCalls: 1,
      lastFailureClass: 'method-unimplemented',
    })
  })

  /**
   * A refused fallback is a request that FAILED, deliberately — an
   * un-deduplicated item write that must not be re-delivered on a second
   * transport. It must never read as a degradation the gateway absorbed.
   */
  it('reports a refused fallback as its own number, not as a degradation', async () => {
    recordBoundProxy('grpc')
    grpcTransportFallbackDiagnostics.recordRefusal('items-sync', 'channel-unavailable')

    const { transportFallback } = await diagnose()

    expect(transportFallback.observed).toBe(true)
    expect(transportFallback.everDegraded).toBe(false)
    expect(transportFallback.lanes['items-sync']).toMatchObject({ degradedCalls: 0, refusedCalls: 1 })
  })

  it('leaves a plain HTTP deployment reading as untouched', async () => {
    recordBoundProxy('http')

    const { deployment, transportFallback } = await diagnose()

    expect(deployment.boundServiceProxy).toBe('http')
    expect(transportFallback.observed).toBe(false)
  })

  /**
   * Same secrecy contract as the rest of the payload. The recorder's own spec
   * pins its field types; this pins that nothing richer reached the response.
   */
  it('contributes no free-form string to the payload', async () => {
    recordBoundProxy('grpc')
    grpcTransportFallbackDiagnostics.recordDegradation('session-validation', 'transport-internal')
    grpcTransportFallbackDiagnostics.recordRefusal('items-sync', 'application')

    const block = (await diagnose()).transportFallback
    const serialized = JSON.stringify(block)

    expect(Object.keys(block)).toEqual(['observed', 'everDegraded', 'lanes'])
    expect(Object.keys(block.lanes)).toEqual(['session-validation', 'items-sync'])
    // Every quoted token in the block — keys and values alike — is a bare
    // identifier or a kebab-case literal. No URL, host, path or env value can
    // match that shape, so the whole block is provably value-free.
    for (const token of serialized.match(/"[^"]*"/g) ?? []) {
      expect(token).toMatch(/^"[A-Za-z][A-Za-z-]*"$/)
    }
  })
})
