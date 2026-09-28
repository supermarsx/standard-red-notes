import { Request } from 'express'

import { LoginLockGuardDTO } from '../../../Domain/User/LoginLockGuard'

/**
 * Standard Red Notes: the recovery sign-in route, which LoginLockGuard exempts
 * from hard refusal (but never from counting or from the delay ramp).
 */
const RECOVERY_LOGIN_PATH = '/recovery/login'

/**
 * Whether this request is the recovery sign-in.
 *
 * Checked against originalUrl as well as path because a route-level middleware
 * sees a URL rewritten relative to the router mount, while the controller (on
 * the DirectCall topology) may see neither. Anything unrecognised is treated as
 * the ordinary sign-in route, so a path we fail to classify falls to the
 * STRICTER branch rather than silently gaining the exemption.
 */
export function isRecoveryLoginRequest(request: Pick<Request, 'path' | 'originalUrl'>): boolean {
  const candidates = [request.originalUrl, request.path]

  return candidates.some((candidate) => {
    if (typeof candidate !== 'string') {
      return false
    }
    // Drop any query string before comparing.
    const withoutQuery = candidate.split('?')[0].replace(/\/+$/, '')

    return withoutQuery.endsWith(RECOVERY_LOGIN_PATH)
  })
}

/**
 * Build the guard's input from an Express request.
 *
 * The client address comes from `x-origin-ip`, which the gateway's proxy sets
 * from the trusted proxy chain — the same header SignIn already records on the
 * session. The raw, client-spoofable `x-forwarded-for` is deliberately NOT
 * consulted: a trusted-source exemption driven by a header the caller controls
 * would be an exemption an attacker could simply ask for.
 */
export function resolveLoginLockRequest(request: Request): LoginLockGuardDTO {
  const originIp = request.headers['x-origin-ip']

  return {
    identifier: (request.body?.email ?? request.body?.username ?? '') as string,
    clientIp: typeof originIp === 'string' ? originIp : undefined,
    isRecoveryRoute: isRecoveryLoginRequest(request),
  }
}

/** Stall for the progressive back-off. A zero or negative wait returns at once. */
export async function sleepSeconds(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return
  }

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}
