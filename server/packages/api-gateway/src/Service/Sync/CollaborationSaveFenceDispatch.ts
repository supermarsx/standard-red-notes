import { createHmac } from 'crypto'
import type { CollaborationSaveFenceDispatch } from '@standard-red-notes/websocket-gateway'

export function createCollaborationSaveFenceDispatch(baseUrl: string, secret: string): CollaborationSaveFenceDispatch {
  const target = new URL('/internal/collaboration-save-fence', baseUrl)
  return async (input, signal) => {
    if (!secret) {
      throw new Error('Collaboration save fence authentication is unavailable')
    }
    const timestamp = String(Date.now())
    const body = JSON.stringify(input)
    const signature = createHmac('sha256', secret).update(`save-fence:${timestamp}:${body}`).digest('hex')
    const response = await fetch(target, {
      method: 'POST',
      body,
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-collaboration-fence-timestamp': timestamp,
        'x-collaboration-fence-signature': signature,
      },
    })
    return { status: response.status, body: await response.json() }
  }
}

/** Only the authenticated socket adapter can attach this backend proof. */
export function signCollaborationSaveProof<T extends Record<string, unknown>>(
  body: T,
  userUuid: string,
  deviceId: string,
  secret: string,
): T & Record<string, unknown> {
  const {
    collaboration_save_fence_device_id: _device,
    collaboration_save_fence_timestamp: _timestamp,
    collaboration_save_fence_signature: _signature,
    ...clean
  } = body
  const proofs = clean.collaboration_save_fences
  if (!Array.isArray(proofs) || proofs.length === 0) {
    return clean as T
  }
  if (proofs.length > 32) {
    throw new Error('Too many collaboration save proofs')
  }
  if (!secret) {
    throw new Error('Collaboration save proof authentication is unavailable')
  }
  const timestamp = String(Date.now())
  const signature = createHmac('sha256', secret)
    .update(`save-proof:${timestamp}:${JSON.stringify({ userUuid, deviceId, proofs })}`)
    .digest('hex')
  return {
    ...clean,
    collaboration_save_fence_device_id: deviceId,
    collaboration_save_fence_timestamp: timestamp,
    collaboration_save_fence_signature: signature,
  } as unknown as T & Record<string, unknown>
}
