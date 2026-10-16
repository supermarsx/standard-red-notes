import 'reflect-metadata'
import type { Request, Response } from 'express'
import { WebDeploymentController } from './WebDeploymentController'
import type { WebDeploymentMarkerReader } from '../../Service/Readiness/WebDeploymentMarker'
import { WebDeploymentMarkerReader as MarkerReader } from '../../Service/Readiness/WebDeploymentMarker'
import { LoopbackSyncApiRpcAdapter } from '../../Service/Sync/LoopbackSyncApiRpcAdapter'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'
import express from 'express'

it('returns only the authoritative web marker with no-store and a closed unavailable response', async () => {
  const marker = { revision: 'a'.repeat(40), version: 'src-aaaaaaaaaaaa' }
  const read = jest.fn().mockResolvedValue(marker)
  const controller = new WebDeploymentController({ read } as unknown as WebDeploymentMarkerReader)
  const response = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() }
  response.status.mockReturnValue(response)
  await controller.web(
    { headers: { host: 'attacker.invalid' }, query: { url: 'http://attacker.invalid' } } as unknown as Request,
    response as unknown as Response,
  )
  expect(read).toHaveBeenCalledWith()
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  expect(response.status).toHaveBeenLastCalledWith(200)
  expect(response.json).toHaveBeenLastCalledWith(marker)
  read.mockResolvedValue(undefined)
  await controller.web({} as Request, response as unknown as Response)
  expect(response.status).toHaveBeenLastCalledWith(503)
  expect(response.json).toHaveBeenLastCalledWith({
    error: { tag: 'service-unavailable', message: 'The web deployment marker is unavailable.' },
  })
})

it('carries the live frontend marker through API_RPC and detects a frontend-only handover', async () => {
  let marker = { revision: 'a'.repeat(40), version: 'src-aaaaaaaaaaaa' }
  let now = 0
  const frontendHeaders: Record<string, unknown>[] = []
  const frontend = createServer((request, response) => {
    frontendHeaders.push(request.headers)
    expect(request.url).toBe('/.well-known/srn-deployment.json')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(marker))
  })
  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    )
  const close = (server: Server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  const frontendPort = await listen(frontend)
  const reader = new MarkerReader({ internalOrigin: `http://127.0.0.1:${frontendPort}`, now: () => now })
  const controller = new WebDeploymentController(reader)
  const app = express()
  app.get('/v1/deployment/web', (request, response) => {
    void controller.web(request, response)
  })
  const gateway = createServer(app)
  try {
    const gatewayPort = await listen(gateway)
    const adapter = new LoopbackSyncApiRpcAdapter({
      origin: `http://127.0.0.1:${gatewayPort}`,
      operations: ['API_RPC'],
    })
    const input = {
      identity: {
        userUuid: 'user',
        sessionUuid: 'session',
        deviceId: 'device',
        authorization: 'Bearer must-not-reach-frontend',
      },
      method: 'GET' as const,
      path: '/v1/deployment/web',
      headers: {},
      stream: false,
    }
    expect((await adapter.execute(input, new AbortController().signal)).body).toEqual(marker)
    marker = { revision: 'b'.repeat(40), version: 'src-bbbbbbbbbbbb' }
    now = 5_001
    expect((await adapter.execute(input, new AbortController().signal)).body).toEqual(marker)
    expect(frontendHeaders).toHaveLength(2)
    expect(frontendHeaders.every((headers) => !headers.authorization && !headers.cookie)).toBe(true)
  } finally {
    await close(gateway)
    await close(frontend)
  }
})
