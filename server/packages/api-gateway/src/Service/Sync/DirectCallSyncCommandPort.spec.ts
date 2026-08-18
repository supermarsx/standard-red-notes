import type { Request, Response } from 'express'
import { ServiceContainer, ServiceIdentifier } from '@standardnotes/domain-core'

import { DirectCallSyncCommandPort } from './DirectCallSyncCommandPort'

describe('DirectCallSyncCommandPort', () => {
  const commandId = 'device:command-1'
  const digest = 'a'.repeat(64)

  function harness(result: Record<string, unknown>) {
    const services = new ServiceContainer()
    const handleRequest = jest.fn().mockResolvedValue({ statusCode: 200, json: result })
    services.register(ServiceIdentifier.create(ServiceIdentifier.NAMES.SyncingServer).getValue(), {
      handleRequest,
    } as never)
    return { port: new DirectCallSyncCommandPort(services), handleRequest }
  }

  it('advertises the trusted in-process path without requiring gRPC authentication', () => {
    expect(harness({}).port.durableCommandAuthenticationReady()).toBe(true)
  })

  it('enters the durable sync method with the same body and command headers as gRPC', async () => {
    const responseBody = { command: { id: commandId, digest, status: 'committed', replayed: false }, saved_items: [] }
    const { port, handleRequest } = harness(responseBody)
    const response = { locals: { user: { uuid: 'user-1' }, session: { uuid: 'session-1' } } } as Response
    const payload = { api: '20240226', items: [], command: { id: commandId, digest } }

    await expect(
      port.sync({ headers: { 'x-snjs-version': '20240226' } } as Request, response, payload),
    ).resolves.toEqual({
      status: 200,
      data: responseBody,
      replayed: false,
    })

    const [request, forwardedResponse, method] = handleRequest.mock.calls[0]
    expect(method).toBe('sync.items.sync')
    expect(forwardedResponse).toBe(response)
    expect(request.body).toBe(payload)
    expect(request.headers).toMatchObject({
      'x-snjs-version': '20240226',
      'x-sync-command-id': commandId,
      'x-sync-command-digest': digest,
    })
  })

  it('enters the same durable command-status method and preserves its result', async () => {
    const responseBody = { command: { id: commandId, digest, status: 'committed' }, result: { saved_items: [] } }
    const { port, handleRequest } = harness(responseBody)
    const response = { locals: { user: { uuid: 'user-1' } } } as Response

    await expect(port.getSyncCommandStatus({ headers: {} } as Request, response, commandId, digest)).resolves.toEqual({
      status: 200,
      data: responseBody,
    })
    expect(handleRequest.mock.calls[0][0]).toMatchObject({
      params: { commandId },
      headers: { 'x-sync-command-digest': digest },
    })
    expect(handleRequest.mock.calls[0][2]).toBe('sync.items.sync_command_status')
  })

  it('fails closed when the bundled syncing service is absent', async () => {
    const port = new DirectCallSyncCommandPort(new ServiceContainer())
    await expect(port.sync({ headers: {} } as Request, { locals: {} } as Response, {})).rejects.toThrow(
      'Syncing service is unavailable',
    )
  })
})
