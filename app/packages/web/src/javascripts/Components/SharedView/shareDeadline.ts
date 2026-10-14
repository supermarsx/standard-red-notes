/** Map the server's fixed deadline to this browser clock, without restarting the view window. */
export function localShareDeadline(
  expiresAt: string | undefined,
  serverTime: string | undefined,
  receivedAt: number,
  roundTripMs: number,
): number | undefined {
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN
  if (!Number.isFinite(expiry)) {
    return undefined
  }
  const serverNow = serverTime ? Date.parse(serverTime) : NaN
  return Number.isFinite(serverNow) ? receivedAt + expiry - serverNow - Math.max(0, roundTripMs) / 2 : expiry
}
