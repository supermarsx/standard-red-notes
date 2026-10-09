import { Request, Response } from 'express'
import { ServiceContainerInterface, ServiceIdentifier, ServiceInterface } from '@standardnotes/domain-core'

import { createDirectCallRequest } from './DirectCallRequest'
import { DurableSyncCommandPort } from './SyncWebSocketCommandAdapter'

interface DirectJsonResult {
  statusCode: number
  json: Record<string, unknown>
}

/**
 * Durable command adapter for the bundled HomeServer. It enters the exact
 * syncing-server controller methods backed by the same transaction/journal as
 * HTTP and gRPC; it is not an alternate executor and opens no loopback socket.
 *
 * Both methods re-shape the request they were handed (a command's body and
 * headers, a status call's `commandId` param) through `createDirectCallRequest`
 * rather than `{ ...request, ... } as unknown as Request`. An object spread
 * copies own enumerable properties only, so it silently strips `get`, `header`
 * and anything else living on a real request's PROTOTYPE -- which is how a
 * genuine Express request, handed here by a future caller, would have arrived
 * at the controller missing the methods it had on the way in.
 */
export class DirectCallSyncCommandPort implements DurableSyncCommandPort {
  constructor(private readonly services: ServiceContainerInterface) {}

  /** HomeServer crosses no process boundary, so this direct port needs no gRPC request signer. */
  durableCommandAuthenticationReady(): boolean {
    return true
  }

  async sync(
    request: Request,
    response: Response,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown; replayed?: boolean }> {
    const command = this.commandMetadata(payload)
    const result = await this.execute(
      createDirectCallRequest({
        from: request,
        body: payload,
        headers: command ? { 'x-sync-command-id': command.id, 'x-sync-command-digest': command.digest } : {},
      }),
      response,
      'sync.items.sync',
    )
    const responseCommand = result.json.command
    const replayed =
      responseCommand && typeof responseCommand === 'object' && 'replayed' in responseCommand
        ? responseCommand.replayed === true
        : undefined
    return { status: result.statusCode, data: result.json, replayed }
  }

  async getSyncCommandStatus(
    request: Request,
    response: Response,
    commandId: string,
    digest?: string,
  ): Promise<{
    status: number
    data: {
      command: { id: string; status: 'accepted' | 'committed' | 'unknown'; digest?: string }
      result?: Record<string, unknown>
    }
  }> {
    const result = await this.execute(
      createDirectCallRequest({
        from: request,
        params: { ...request.params, commandId },
        headers: digest ? { 'x-sync-command-digest': digest } : {},
      }),
      response,
      'sync.items.sync_command_status',
    )
    return {
      status: result.statusCode,
      data: result.json as {
        command: { id: string; status: 'accepted' | 'committed' | 'unknown'; digest?: string }
        result?: Record<string, unknown>
      },
    }
  }

  private async execute(request: Request, response: Response, method: string): Promise<DirectJsonResult> {
    const service = this.services.get(ServiceIdentifier.create(ServiceIdentifier.NAMES.SyncingServer).getValue()) as
      ServiceInterface | undefined
    if (!service) {
      throw new Error('Syncing service is unavailable in the HomeServer service container.')
    }
    const result = (await service.handleRequest(
      request as never,
      response as never,
      method,
    )) as Partial<DirectJsonResult>
    if (!Number.isInteger(result.statusCode) || !result.json || typeof result.json !== 'object') {
      throw new Error('Syncing service returned an invalid direct-call result.')
    }
    return result as DirectJsonResult
  }

  private commandMetadata(payload: Record<string, unknown>): { id: string; digest: string } | undefined {
    const command = payload.command
    if (!command || typeof command !== 'object') {
      return undefined
    }
    const { id, digest } = command as Record<string, unknown>
    return typeof id === 'string' && typeof digest === 'string' ? { id, digest } : undefined
  }
}
