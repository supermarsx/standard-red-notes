import { Request, Response } from 'express'

/**
 * Standard Red Notes: shared "who did it, from where" attribution for audit-log
 * writes made from an HTTP controller. BaseAdminController grew private copies
 * of these first; the user-facing controllers (credentials, settings) must
 * resolve the actor and the client IP exactly the same way, otherwise the same
 * log column would mean different things depending on which endpoint wrote it.
 */

/**
 * The acting principal: the authenticated user on the request, or null when no
 * user could be resolved (an unauthenticated or pre-authentication failure).
 */
export const auditActorUuid = (response?: Response): string | null =>
  (response?.locals as { user?: { uuid: string } } | undefined)?.user?.uuid ?? null

/**
 * Prefer the gateway-resolved `x-origin-ip` (set by HttpServiceProxy from the
 * trusted proxy chain) over the raw, client-spoofable `x-forwarded-for`. Fall
 * back to x-forwarded-for / request.ip only when x-origin-ip is absent (e.g. a
 * non-gateway/local request). Audit metadata only — never a security gate.
 */
export const auditClientIp = (request: Request): string | null =>
  (request.headers?.['x-origin-ip'] as string | undefined) ??
  (request.headers?.['x-forwarded-for'] as string | undefined) ??
  request.ip ??
  null
