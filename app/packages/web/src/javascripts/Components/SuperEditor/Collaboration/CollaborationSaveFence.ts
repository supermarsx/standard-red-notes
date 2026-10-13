import type { WebApplication } from '@/Application/WebApplication'

export type CollaborationSaveFenceIdentity = { room: string; roomEpoch: string; leaseId: string }
export type CollaborationSaveFence = { room: string; token: string; expiresAt: number }

async function request(
  application: WebApplication,
  identity: CollaborationSaveFenceIdentity,
  action: 'claim' | 'renew' | 'release',
  fence?: CollaborationSaveFence,
): Promise<CollaborationSaveFence | undefined> {
  const response = await application.collaborationSaveFenceRequest({
    ...identity,
    action,
    ...(fence ? { token: fence.token } : {}),
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error('The collaboration saver could not obtain its server lease.')
  }
  if (action === 'release') {
    return undefined
  }
  const body = response.body as Partial<CollaborationSaveFence> | undefined
  if (
    !body ||
    body.room !== identity.room ||
    typeof body.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.token) ||
    typeof body.expiresAt !== 'number' ||
    !Number.isSafeInteger(body.expiresAt) ||
    body.expiresAt <= Date.now()
  ) {
    throw new Error('The collaboration saver received an invalid server lease.')
  }
  return body as CollaborationSaveFence
}

export async function claimCollaborationSaveFence(
  application: WebApplication,
  identity: CollaborationSaveFenceIdentity,
): Promise<CollaborationSaveFence> {
  return (await request(application, identity, 'claim'))!
}
export async function renewCollaborationSaveFence(
  application: WebApplication,
  identity: CollaborationSaveFenceIdentity,
  fence: CollaborationSaveFence,
): Promise<CollaborationSaveFence> {
  return (await request(application, identity, 'renew', fence))!
}
export async function releaseCollaborationSaveFence(
  application: WebApplication,
  identity: CollaborationSaveFenceIdentity,
  fence: CollaborationSaveFence,
): Promise<void> {
  await request(application, identity, 'release', fence)
}
