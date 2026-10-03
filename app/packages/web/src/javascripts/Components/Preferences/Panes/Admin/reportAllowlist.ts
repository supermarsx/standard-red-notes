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
 * A shape THIS BUILD declared, as a nominal type over `RegExp`.
 *
 * WHY THE BRAND. Admission by shape is only as good as the shape, and "the
 * caller passes a RegExp" is not a constraint: `admitToken(payload.revision,
 * new RegExp(payload.pattern))` and `admitToken(payload.revision, /./)` both
 * typecheck, and either turns the allowlist back into an echo. So the pattern a
 * `SafeValue` is admitted against is not any `RegExp` — it is one obtained from
 * `declarePattern`, which accepts a string LITERAL only, exactly as
 * `safeConstant` does. A value off the wire has type `string`, the parameter
 * resolves to `never`, and the call does not compile.
 *
 * The brand is nominal, like `SafeValue`'s: `x as DeclaredPattern` still
 * compiles. Same bargain — no bypass can happen by accident, and every
 * deliberate one is a single greppable expression.
 */
export type DeclaredPattern = RegExp & { readonly __declaredShape: 'literal-of-this-build' }

/**
 * Declare a shape from a literal of this build.
 *
 * Two things are enforced here rather than remembered:
 *
 *  - The source must be a LITERAL. `declarePattern(payload.whatever)` does not
 *    compile, so a shape cannot be derived from the data it is admitting, which
 *    would make the admission circular.
 *  - The source must be ANCHORED. An unanchored shape matches a substring, so
 *    `[0-9a-f]{40}` would happily admit a whole connection string with a hex
 *    blob somewhere inside it — the exact leak the allowlist exists to stop.
 *
 * Built with `new RegExp` rather than taking a literal `RegExp` so the result
 * carries no flags: a `g`-flagged pattern makes `.test` stateful and would
 * alternate between admitting and withholding the same value.
 */
export function declarePattern<T extends string>(source: T & (string extends T ? never : unknown)): DeclaredPattern {
  if (!source.startsWith('^') || !source.endsWith('$')) {
    throw new Error(`a declared shape must be anchored with ^ and $; "${source}" would admit a substring`)
  }

  return new RegExp(source) as DeclaredPattern
}

/**
 * A deployment revision: exactly the 40 lowercase hex characters `app/Dockerfile`
 * accepts, and nothing else. Keep this in step with that validation.
 */
export const DEPLOY_REVISION = declarePattern('^[0-9a-f]{40}$')

/** A version token: the shape `SRN_DEPLOY_VERSION` is itself validated against. */
export const VERSION_TOKEN = declarePattern('^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$')

/**
 * Admit a server-supplied string only when it matches `pattern`; never repair it,
 * never print a partial. The caller gets a constant in every other case, so no
 * unmatched byte of server text can reach the output.
 *
 * This is the ONE admission rule in the pane. `safeToken` in
 * `diagnosticsSections.ts` is this function plus the `SafeValue` brand, and it
 * narrows the parameter to a `DeclaredPattern`: the two reports admit a token by
 * exactly the rule a row does, so neither can be loosened without the other.
 */
export function admitToken(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string') {
    return NOT_REPORTED
  }
  return pattern.test(value) ? value : WITHHELD
}
