import type { Response } from 'express'

import type { ResponseLocals } from '../../Controller/ResponseLocals'

/**
 * The Express `Response` a controller is handed when a caller enters it
 * DIRECTLY -- no HTTP server, no socket, no middleware. Two lanes do that in
 * this tree: the bundled single-container build's `DirectCallSyncCommandPort`
 * (via `SyncWebSocketCommandAdapter`) and the home server's
 * `CanonicalHomeServerFileResourceAuthorizer`,
 * which drives `auth.valet-tokens.create` /
 * `sync.shared-vaults.create-file-valet-token` the same way. Exported for the
 * second: one header sink, not two, so a lane cannot be fixed while its twin
 * stays broken. It lives in a leaf module of its own, with no runtime import
 * at all, so a caller outside this package can reach it without dragging the
 * inversify-decorated Bootstrap graph behind it.
 *
 * `{ locals } as unknown as Response` was not enough, and the gap was invisible
 * to every gate. `BaseItemsController.sync` stamps `X-Sync-Command-Status` and
 * `X-Sync-Command-Replayed` on the response one line AFTER the durable write
 * commits, and `syncCommandError` stamps `Retry-After` on a pending command. On
 * the direct-call port that bare literal therefore threw
 *
 *   TypeError: response.setHeader is not a function
 *
 * with the items already persisted: the controller caught its own TypeError,
 * logged "Durable sync command execution failed." and answered 503, `execute`
 * below read the non-2xx and threw, and the socket reported `BACKEND_ERROR` for
 * a save that had in fact landed. Every `SYNC_ITEMS` command on the single
 * container failed that way while advertising the capability. The multi-container
 * topology never saw it because its durable port speaks gRPC and never enters a
 * controller with a fabricated response.
 *
 * The collected headers are intentionally discarded -- this lane carries command
 * status in the frame, not in HTTP headers -- but the methods have to EXIST, and
 * a header written must read back, so a controller that branches on one is not
 * silently told "unset". The sibling fabrication in
 * `CollaborationAuthorizationService.checkAccessWithSyncingServer` has always
 * carried `setHeader` for the same reason.
 *
 * `locals` is widened past `ResponseLocals` only so a caller outside this
 * package can pass the equivalent record it already builds; nothing here reads
 * a field of it.
 */
export function createDirectCallResponse(locals: ResponseLocals | Record<string, unknown>): Response {
  const headers = new Map<string, unknown>()
  const response: Record<string, unknown> = {
    locals,
    getHeader: (name: string): unknown => headers.get(String(name).toLowerCase()),
    getHeaderNames: (): string[] => [...headers.keys()],
    hasHeader: (name: string): boolean => headers.has(String(name).toLowerCase()),
    removeHeader: (name: string): void => {
      headers.delete(String(name).toLowerCase())
    },
  }
  response.setHeader = (name: string, value: unknown): unknown => {
    headers.set(String(name).toLowerCase(), value)
    return response
  }
  return response as unknown as Response
}
