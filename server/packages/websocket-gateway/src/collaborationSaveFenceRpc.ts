import type { SyncApiRpcAdapter, SyncApiRpcRequest, SyncApiRpcResponse } from './syncCommandHandler.js'

export const COLLABORATION_SAVE_FENCE_RPC_PATH = '/v1/collaboration/save-fence'
export type CollaborationSaveFenceInput = {
  room: string
  roomEpoch: string
  leaseId: string
  action: 'claim' | 'renew' | 'release'
  token?: string
  userUuid: string
  deviceId: string
}
export type CollaborationSaverEditorIdentity = {
  room: string
  roomEpoch: string
  leaseId: string
  userUuid: string
  sessionUuid: string
}
export type CollaborationSaveFenceDispatch = (
  input: CollaborationSaveFenceInput,
  signal: AbortSignal,
) => Promise<SyncApiRpcResponse>

/** The client may request a fence only for its own activated editor lease.
 * The backend never receives client-supplied authentication identities. */
export function withCollaborationSaveFenceRpc(
  adapter: SyncApiRpcAdapter,
  validateEditor: (input: CollaborationSaverEditorIdentity) => Promise<boolean>,
  dispatch?: CollaborationSaveFenceDispatch,
): SyncApiRpcAdapter {
  return {
    idempotencyScope: adapter.idempotencyScope,
    ready: () => adapter.ready(),
    operations: () => adapter.operations(),
    execute: async (input: SyncApiRpcRequest, signal: AbortSignal): Promise<SyncApiRpcResponse> => {
      if (input.path !== COLLABORATION_SAVE_FENCE_RPC_PATH) {
        return adapter.execute(input, signal)
      }
      const body = input.body as Record<string, unknown> | undefined
      if (
        !dispatch ||
        input.method !== 'POST' ||
        input.stream ||
        !input.idempotencyKey ||
        !body ||
        typeof body.room !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(body.room) ||
        typeof body.roomEpoch !== 'string' ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body.roomEpoch) ||
        typeof body.leaseId !== 'string' ||
        body.leaseId.length === 0 ||
        body.leaseId.length > 128 ||
        !['claim', 'renew', 'release'].includes(body.action as string) ||
        (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 128))
      ) {
        return { status: 400, body: { error: 'Invalid collaboration save lease request' } }
      }
      const identity = {
        room: body.room,
        roomEpoch: body.roomEpoch,
        leaseId: body.leaseId,
        userUuid: input.identity.userUuid,
        sessionUuid: input.identity.sessionUuid,
      }
      if (!(await validateEditor(identity))) {
        return { status: 403, body: { error: 'An active editor lease is required' } }
      }
      return dispatch(
        {
          room: body.room,
          roomEpoch: body.roomEpoch,
          leaseId: body.leaseId,
          action: body.action as CollaborationSaveFenceInput['action'],
          ...(typeof body.token === 'string' ? { token: body.token } : {}),
          userUuid: input.identity.userUuid,
          deviceId: input.identity.deviceId,
        },
        signal,
      )
    },
  }
}
