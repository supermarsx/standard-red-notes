const REDACTED = '[REDACTED]'

/**
 * Standard Red Notes: a secret that cannot leave the process by accident.
 *
 * An external account's password passes through three places that all turn
 * values into text without being asked: a log call, `JSON.stringify` on a
 * response body, and string interpolation in an error message. Holding the
 * password as a bare `string` makes every one of them a leak waiting for a
 * careless line.
 *
 * So it is held here instead. The value lives in a private field, which is not
 * an own property: it does not show up in `Object.keys`, in a spread, in
 * `JSON.stringify`, in `util.inspect` or in a structured logger's metadata walk.
 * The four ways a value is implicitly rendered all answer `[REDACTED]`.
 *
 * The plaintext comes out through `reveal()` and nothing else. That method has
 * exactly one caller in production code, the function that builds the
 * `Authorization` header (`DavRelay.authorizationHeader`), and one more inside
 * the cipher that seals it for storage.
 */
export class SecretString {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  /** The plaintext. Call sites are an audited, closed list; see the class comment. */
  reveal(): string {
    return this.#value
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }

  get [Symbol.toStringTag](): string {
    return 'SecretString'
  }
}
