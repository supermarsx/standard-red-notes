import { describe, expect, it, vi } from 'vitest'
import { withCollaborationSaveFenceRpc } from '../src/collaborationSaveFenceRpc.js'
import type { SyncApiRpcAdapter, SyncApiRpcRequest } from '../src/syncCommandHandler.js'

const request = (): SyncApiRpcRequest => ({
  identity: {
    userUuid: 'authenticated-user',
    sessionUuid: 'authenticated-session',
    deviceId: 'authenticated-device',
  } as never,
  method: 'POST',
  path: '/v1/collaboration/save-fence',
  headers: {},
  idempotencyKey: 'attempt-1',
  stream: false,
  body: {
    room: '00000000-0000-4000-8000-000000000001',
    roomEpoch: '1234567890abcdef',
    leaseId: 'editor-1',
    action: 'claim',
    userUuid: 'forged-user',
    deviceId: 'forged-device',
  },
})
const adapter = (): SyncApiRpcAdapter => ({
  idempotencyScope: 'shared-durable',
  ready: () => true,
  operations: () => ['API_RPC'],
  execute: vi.fn().mockResolvedValue({ status: 200, body: { ordinary: true } }),
})
describe('collaboration fence RPC authorization', () => {
  it('requires the activated editor lease and overwrites supplied identities', async () => {
    const validate = vi.fn().mockResolvedValue(true)
    const dispatch = vi.fn().mockResolvedValue({ status: 200, body: { token: 'fence' } })
    const rpc = withCollaborationSaveFenceRpc(adapter(), validate, dispatch)
    await expect(rpc.execute(request(), new AbortController().signal)).resolves.toMatchObject({ status: 200 })
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ userUuid: 'authenticated-user', sessionUuid: 'authenticated-session' }),
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ userUuid: 'authenticated-user', deviceId: 'authenticated-device' }),
      expect.anything(),
    )
  })
  it('does not call the backend for an expired, reserved or foreign editor lease', async () => {
    const dispatch = vi.fn()
    const rpc = withCollaborationSaveFenceRpc(adapter(), async () => false, dispatch)
    await expect(rpc.execute(request(), new AbortController().signal)).resolves.toMatchObject({ status: 403 })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects malformed mutations and never routes the fence through public HTTP middleware', async () => {
    const base = adapter()
    const dispatch = vi.fn()
    const rpc = withCollaborationSaveFenceRpc(base, async () => true, dispatch)
    await expect(rpc.execute({ ...request(), stream: true }, new AbortController().signal)).resolves.toMatchObject({
      status: 400,
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(base.execute).not.toHaveBeenCalled()
  })
  it('preserves the normal RPC adapter for ordinary requests', async () => {
    const base = adapter()
    const input = { ...request(), method: 'GET' as const, path: '/v1/me' }
    const signal = new AbortController().signal
    await withCollaborationSaveFenceRpc(base, async () => false).execute(input, signal)
    expect(base.execute).toHaveBeenCalledWith(input, signal)
  })
})
