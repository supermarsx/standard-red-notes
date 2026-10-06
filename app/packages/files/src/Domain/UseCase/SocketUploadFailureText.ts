/**
 * What a user is told when the FILES_V1 socket lane could not finish an upload
 * and could not be restarted over HTTP.
 *
 * WHY THIS EXISTS. The whole report used to be
 * `Failed to push file bytes to server (SOCKET_CLOSED)`, and that is the one
 * sentence a person actually sees in the error toast
 * (`FilesController.uploadNewFile` renders `ClientDisplayableError.text`). It
 * says nothing about the single question that matters next — whether the file
 * reached the server — so the only available action was to guess. A real case:
 * an ordinary 2.97 MB photo was refused by the gateway's rate limiter mid-stream
 * and the operator saw exactly that string.
 *
 * WHAT MAKES THE ANSWER KNOWABLE. `safeToFallback` is not a hint; it is the
 * transfer's own invariant. `SocketUploadTransfer` keeps it true for exactly as
 * long as `FILES_UPLOAD_FINISH` has not been attempted even once, and FINISH is
 * the server's commit — nothing is published before it. So:
 *
 *   - `safeToFallback === true`  -> FINISH never went out, so the server
 *     published nothing and the bytes it buffered are discarded. Retrying is
 *     safe and cannot duplicate anything.
 *   - `safeToFallback === false` -> FINISH was attempted and this client cannot
 *     know whether it was applied, because the answer is what went missing. The
 *     file may already be there, so the honest instruction is to look before
 *     uploading it again.
 *
 * The protocol code is kept in the text on purpose: it is the one token that
 * ties a user's screenshot to a server-side counter or close reason.
 */
export function socketUploadFailureText(code: string, safeToFallback: boolean): string {
  const cause = `The realtime connection did not carry the whole file to the server (${code}).`

  return safeToFallback
    ? `${cause} Nothing was saved — upload it again.`
    : `${cause} It may already have been saved; check before uploading it again.`
}
