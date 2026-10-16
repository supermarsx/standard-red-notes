import { createHash, randomUUID } from 'node:crypto'
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
  authorizeRelease?: (input: SyncApiRpcRequest, signal: AbortSignal) => Promise<boolean>,
): SyncApiRpcAdapter {
  // The wrapper is created once per socket. Binding its internal lease prevents
  // delayed disconnect cleanup from releasing a replacement connection's proof,
  // even when that connection presents the same public editor lease and device.
  const connectionId = randomUUID()
  const fences = new Map<string, { input: CollaborationSaveFenceInput; expiresAt: number }>()
  let closed = false
  let pending = 0
  const release = async (input: CollaborationSaveFenceInput): Promise<void> => {
    try {
      await dispatch?.({ ...input, action: 'release' }, AbortSignal.timeout(5_000))
    } catch {
      // An unreachable backend retains the original bounded SQL expiry.
    }
  }
  return {
    idempotencyScope: adapter.idempotencyScope,
    ready: () => adapter.ready(),
    operations: () => adapter.operations(),
    disconnect: async () => {
      if (closed) {
        return
      }
      closed = true
      const owned = [...fences.values()]
      fences.clear()
      await Promise.allSettled(owned.map(({ input }) => release(input)))
    },
    execute: async (input: SyncApiRpcRequest, signal: AbortSignal): Promise<SyncApiRpcResponse> => {
      if (closed) {
        throw new Error('RPC connection is closed')
      }
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
        (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 128)) ||
        (body.action === 'release' && (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)))
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
      // Ending the editor lease can race its final release. The authenticated
      // owner may still release only its exact SQL-bound token/room/epoch/device/lease;
      // the backend enforces those bindings under the fence row lock.
      const authorized =
        body.action === 'release' && authorizeRelease
          ? await authorizeRelease(input, signal)
          : await validateEditor(identity)
      if (!authorized) {
        return { status: 403, body: { error: 'An active editor lease is required' } }
      }
      const forwarded: CollaborationSaveFenceInput = {
        room: body.room,
        roomEpoch: body.roomEpoch,
        leaseId: createHash('sha256')
          .update(JSON.stringify([connectionId, body.leaseId]))
          .digest('hex'),
        action: body.action as CollaborationSaveFenceInput['action'],
        ...(typeof body.token === 'string' ? { token: body.token } : {}),
        userUuid: input.identity.userUuid,
        deviceId: input.identity.deviceId,
      }
      const key = JSON.stringify([
        forwarded.userUuid,
        forwarded.deviceId,
        forwarded.room,
        forwarded.roomEpoch,
        forwarded.leaseId,
      ])
      for (const [known, fence] of fences) {
        if (fence.expiresAt <= Date.now()) {
          fences.delete(known)
        }
      }
      if (body.action !== 'release' && !fences.has(key) && fences.size + pending >= 32) {
        return { status: 429, body: { error: 'Too many active collaboration save leases' } }
      }
      pending += 1
      try {
        const response = await dispatch(forwarded, signal)
        const result = response.body as Record<string, unknown> | undefined
        if (response.status >= 200 && response.status < 300) {
          if (forwarded.action === 'release') {
            if (fences.get(key)?.input.token === forwarded.token) {
              fences.delete(key)
            }
          } else if (
            result?.room === forwarded.room &&
            typeof result.token === 'string' &&
            /^[a-f0-9]{64}$/.test(result.token) &&
            typeof result.expiresAt === 'number' &&
            Number.isSafeInteger(result.expiresAt) &&
            result.expiresAt > Date.now()
          ) {
            const owned = { ...forwarded, token: result.token }
            if (closed) {
              // A claim can finish after disconnect (SQL may already have
              // committed when the RPC abort arrived). Do not orphan its proof.
              await release(owned)
            } else if ((fences.get(key)?.expiresAt ?? 0) <= result.expiresAt) {
              // Concurrent renewals can return out of order. Keep the newest
              // expiry/proof rather than forgetting a still-live lease early.
              fences.set(key, { input: owned, expiresAt: result.expiresAt })
            }
          }
        }
        return response
      } finally {
        pending -= 1
      }
    },
  }
}
