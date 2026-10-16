import { describe, expect, it, vi } from 'vitest'
import { withCollaborationSaveFenceRpc } from '../src/collaborationSaveFenceRpc.js'
import type { SyncApiRpcAdapter, SyncApiRpcRequest, SyncApiRpcResponse } from '../src/syncCommandHandler.js'

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
  const grant = () => ({
    status: 200,
    body: { room: (request().body as { room: string }).room, token: 'a'.repeat(64), expiresAt: Date.now() + 20_000 },
  })

  it('releases only its exact server-issued proof once when the socket closes', async () => {
    const dispatch = vi.fn().mockResolvedValue(grant())
    const validate = vi.fn().mockResolvedValue(true)
    const rpc = withCollaborationSaveFenceRpc(adapter(), validate, dispatch)
    await rpc.execute(request(), new AbortController().signal)
    const forwarded = dispatch.mock.calls[0][0]
    expect(forwarded.leaseId).toMatch(/^[a-f0-9]{64}$/)
    expect(validate.mock.calls[0][0].leaseId).toBe('editor-1')
    await rpc.disconnect!()
    await rpc.disconnect!()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1][0]).toEqual({ ...forwarded, action: 'release', token: 'a'.repeat(64) })
    await expect(rpc.execute(request(), new AbortController().signal)).rejects.toThrow('closed')
  })

  it('binds the internal lease to the connection, so delayed old cleanup cannot release its replacement', async () => {
    const dispatch = vi.fn().mockResolvedValue(grant())
    const old = withCollaborationSaveFenceRpc(adapter(), async () => true, dispatch)
    const replacement = withCollaborationSaveFenceRpc(adapter(), async () => true, dispatch)
    await old.execute(request(), new AbortController().signal)
    await replacement.execute(request(), new AbortController().signal)
    const oldLease = dispatch.mock.calls[0][0].leaseId
    const newLease = dispatch.mock.calls[1][0].leaseId
    expect(oldLease).not.toBe(newLease)
    await old.disconnect!()
    expect(dispatch.mock.calls[2][0].leaseId).toBe(oldLease)
    await replacement.disconnect!()
    expect(dispatch.mock.calls[3][0].leaseId).toBe(newLease)
  })

  it('cleans up a claim that committed after its socket disconnected', async () => {
    let complete!: (value: SyncApiRpcResponse) => void
    const dispatch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SyncApiRpcResponse>((resolve) => {
            complete = resolve
          }),
      )
      .mockResolvedValue({ status: 200 })
    const rpc = withCollaborationSaveFenceRpc(adapter(), async () => true, dispatch)
    const claim = rpc.execute(request(), new AbortController().signal)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await rpc.disconnect!()
    complete(grant())
    await claim
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1][0]).toMatchObject({ action: 'release', token: 'a'.repeat(64) })
  })

  it('does not forget a renewed proof when an older release finishes later', async () => {
    let complete!: (value: SyncApiRpcResponse) => void
    const dispatch = vi.fn().mockResolvedValue(grant())
    const rpc = withCollaborationSaveFenceRpc(adapter(), async () => true, dispatch)
    await rpc.execute(request(), new AbortController().signal)
    dispatch.mockImplementationOnce(
      () =>
        new Promise<SyncApiRpcResponse>((resolve) => {
          complete = resolve
        }),
    )
    const release = rpc.execute(
      { ...request(), body: { ...(request().body as object), action: 'release', token: 'a'.repeat(64) } },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    dispatch.mockResolvedValueOnce({ ...grant(), body: { ...grant().body, token: 'b'.repeat(64) } })
    await rpc.execute(request(), new AbortController().signal)
    complete({ status: 200, body: { expiresAt: 0 } })
    await release
    await rpc.disconnect!()
    expect(dispatch.mock.calls.at(-1)![0]).toMatchObject({ action: 'release', token: 'b'.repeat(64) })
  })

  it('never releases an unsuccessful or malformed claim, and contains cleanup failures', async () => {
    for (const response of [
      { status: 409, body: grant().body },
      { status: 200, body: { token: 'invalid' } },
    ]) {
      const dispatch = vi.fn().mockResolvedValue(response)
      const rpc = withCollaborationSaveFenceRpc(adapter(), async () => true, dispatch)
      await rpc.execute(request(), new AbortController().signal)
      await rpc.disconnect!()
      expect(dispatch).toHaveBeenCalledTimes(1)
    }
    const dispatch = vi.fn().mockResolvedValueOnce(grant()).mockRejectedValue(new Error('offline'))
    const rpc = withCollaborationSaveFenceRpc(adapter(), async () => true, dispatch)
    await rpc.execute(request(), new AbortController().signal)
    await expect(rpc.disconnect!()).resolves.toBeUndefined()
  })

  it('keeps the newest proof when concurrent backend responses arrive out of order', async () => {
    let complete!: (value: SyncApiRpcResponse) => void
    const older = grant()
    const newer = {
      ...grant(),
      body: { ...grant().body, token: 'b'.repeat(64), expiresAt: older.body.expiresAt + 1_000 },
    }
    const dispatch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SyncApiRpcResponse>((resolve) => {
            complete = resolve
          }),
      )
      .mockResolvedValue(newer)
    const rpc = withCollaborationSaveFenceRpc(adapter(), async () => true, dispatch)
    const pending = rpc.execute(request(), new AbortController().signal)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await rpc.execute(request(), new AbortController().signal)
    complete(older)
    await pending
    await rpc.disconnect!()
    expect(dispatch.mock.calls.at(-1)![0]).toMatchObject({ action: 'release', token: newer.body.token })
  })

  it('allows a freshly authenticated exact-token release after the editor lease ended, preserving gateway identities', async () => {
    const validate = vi.fn().mockResolvedValue(false)
    const authorize = vi.fn().mockResolvedValue(true)
    const dispatch = vi.fn().mockResolvedValue({ status: 200, body: { expiresAt: 0 } })
    const input = { ...request(), body: { ...(request().body as object), action: 'release', token: 'a'.repeat(64) } }
    await expect(
      withCollaborationSaveFenceRpc(adapter(), validate, dispatch, authorize).execute(
        input,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 200 })
    expect(authorize).toHaveBeenCalledWith(input, expect.anything())
    expect(validate).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'release',
        userUuid: 'authenticated-user',
        deviceId: 'authenticated-device',
        token: 'a'.repeat(64),
      }),
      expect.anything(),
    )
  })
  it('denies a revoked release and preserves live editor checks for claim and renew', async () => {
    const validate = vi.fn().mockResolvedValue(false)
    const dispatch = vi.fn()
    const authorize = vi.fn().mockResolvedValue(false)
    const rpc = withCollaborationSaveFenceRpc(adapter(), validate, dispatch, authorize)
    for (const action of ['release', 'renew', 'claim']) {
      await expect(
        rpc.execute(
          { ...request(), body: { ...(request().body as object), action, token: 'a'.repeat(64) } },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 403 })
    }
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(validate).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('requires the exact bounded release token and falls back to the strict live editor check without a fresh auth callback', async () => {
    const dispatch = vi.fn()
    const rpc = withCollaborationSaveFenceRpc(adapter(), async () => false, dispatch)
    for (const token of [undefined, 'short', 'g'.repeat(64)]) {
      await expect(
        rpc.execute(
          { ...request(), body: { ...(request().body as object), action: 'release', token } },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 400 })
    }
    await expect(
      rpc.execute(
        { ...request(), body: { ...(request().body as object), action: 'release', token: 'a'.repeat(64) } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 403 })
    expect(dispatch).not.toHaveBeenCalled()
  })
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
