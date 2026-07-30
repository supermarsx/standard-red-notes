/**
 * A caller-controlled CalDAV value failed validation.
 *
 * Controllers may safely translate this error to HTTP 400. Persistence and
 * infrastructure errors deliberately use their original types so they reach
 * the gateway error boundary as 5xx responses instead of being misreported as
 * bad client input.
 */
export class CaldavInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaldavInputError'
  }
}
