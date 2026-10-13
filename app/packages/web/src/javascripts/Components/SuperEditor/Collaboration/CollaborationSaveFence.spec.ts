import type { WebApplication } from '@/Application/WebApplication'
import {
  claimCollaborationSaveFence,
  releaseCollaborationSaveFence,
  renewCollaborationSaveFence,
} from './CollaborationSaveFence'

const identity = { room: 'note', roomEpoch: 'epoch', leaseId: 'editor-lease' }
const lease = () => ({ room: identity.room, token: 'a'.repeat(64), expiresAt: Date.now() + 20_000 })

it('claims, renews and releases only through the socket-specific application method', async () => {
  const body = lease()
  const rpc = jest.fn().mockResolvedValue({ status: 200, body })
  const application = { collaborationSaveFenceRequest: rpc } as unknown as WebApplication
  expect(await claimCollaborationSaveFence(application, identity)).toEqual(body)
  expect(rpc).toHaveBeenLastCalledWith({ ...identity, action: 'claim' })
  expect(await renewCollaborationSaveFence(application, identity, body)).toEqual(body)
  expect(rpc).toHaveBeenLastCalledWith({ ...identity, action: 'renew', token: body.token })
  await releaseCollaborationSaveFence(application, identity, body)
  expect(rpc).toHaveBeenLastCalledWith({ ...identity, action: 'release', token: body.token })
})

it.each([
  { status: 409, body: lease() },
  { status: 200, body: { ...lease(), room: 'another-note' } },
  { status: 200, body: { ...lease(), token: 'not-a-server-token' } },
  { status: 200, body: { ...lease(), expiresAt: 1 } },
])('fails closed on a refused, mismatched or invalid lease', async (response) => {
  const rpc = jest.fn().mockResolvedValue(response)
  const application = { collaborationSaveFenceRequest: rpc } as unknown as WebApplication
  await expect(claimCollaborationSaveFence(application, identity)).rejects.toThrow()
  expect(rpc).toHaveBeenCalledTimes(1)
})
