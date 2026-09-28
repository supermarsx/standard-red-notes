/**
 * Standard Red Notes: shape predicates shared by the two COPYABLE diagnostic
 * reports (capability diagnostics and health & services).
 *
 * WHY AN ALLOWLIST. `sanitizeServerCopy` is a denylist and says so in its own
 * header: "It cannot catch an opaque secret with no structure, and does not
 * pretend to." That is the right second line for text rendered into a panel the
 * operator is already looking at. It is the wrong ONLY line for text a button
 * puts on the clipboard, because a copied report ends up in chats and issue
 * trackers and cannot be taken back.
 *
 * This was not theoretical. The health report's planted-secret scan caught two
 * real leaks on its first run, both in the deployment marker, which is served by
 * whatever fronts the web bundle:
 *   - a revision reading `token-sk-live-...` printed verbatim, because it has no
 *     address shape for a denylist to match;
 *   - a version reading `v1.2.3-build@ci.internal.example.com` printed as
 *     `v1.2.3-build@[address withheld]` — the host removed, the rest intact.
 *
 * So both fields are admitted by SHAPE instead: the revision must be exactly what
 * `app/Dockerfile` itself validates, and anything else is refused rather than
 * repaired. Refusing is safe; a partially-scrubbed string is not.
 */

/** Printed when a value was supplied but does not match its expected shape. */
export const WITHHELD = 'withheld (unrecognised format)'
/** Printed when a value was not supplied at all. */
export const NOT_REPORTED = 'not reported'

/**
 * A deployment revision: exactly the 40 lowercase hex characters `app/Dockerfile`
 * accepts, and nothing else. Keep this in step with that validation.
 */
export const DEPLOY_REVISION = /^[0-9a-f]{40}$/

/** A version token: the shape `SRN_DEPLOY_VERSION` is itself validated against. */
export const VERSION_TOKEN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/

/**
 * Admit a server-supplied string only when it matches `pattern`; never repair it,
 * never print a partial. The caller gets a constant in every other case, so no
 * unmatched byte of server text can reach the output.
 */
export function admitToken(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string') {
    return NOT_REPORTED
  }
  return pattern.test(value) ? value : WITHHELD
}
