import { Request } from 'express'
import { getControllerMethodMetadata } from 'inversify-express-utils'

const UUID_IN_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The canonical spelling of an identifier on the admin surface: a uuid in lower
 * case. Anything that is not a uuid is returned untouched, so the handler it
 * belongs to still refuses it by name, in the spelling the caller sent.
 */
export function canonicalAdminIdentifier<T>(value: T): T | string {
  return typeof value === 'string' && UUID_IN_ANY_CASE.test(value) ? value.toLowerCase() : value
}

/**
 * Puts every uuid an admin request carries into lower case, in place: path
 * parameters that are uuids, and the two body fields that carry account uuids
 * (`userUuid`, `userUuids`). Tolerates a request with no parameters or no body.
 */
export function canonicalizeAdminRequest(request: Request): void {
  const params = request?.params as Record<string, unknown> | null | undefined
  if (params !== null && typeof params === 'object') {
    for (const name of Object.keys(params)) {
      params[name] = canonicalAdminIdentifier(params[name])
    }
  }

  const body = request?.body as Record<string, unknown> | null | undefined
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    if ('userUuid' in body) {
      body.userUuid = canonicalAdminIdentifier(body.userUuid)
    }
    if (Array.isArray(body.userUuids)) {
      body.userUuids = body.userUuids.map((candidate) => canonicalAdminIdentifier(candidate))
    }
  }
}

/**
 * Standard Red Notes: every uuid that enters `/v1/admin` is put into its
 * canonical lower-case spelling here, at the one door both topologies share.
 *
 * *** WHAT WAS BROKEN, MEASURED. *** A uuid is case-insensitive on input, and the
 * accounts, groups, roles and invite links this surface addresses are all minted
 * by the server in lower case. Asked about a real account in UPPER CASE on a
 * running all-in-one container (SQLite compares the two spellings as different
 * strings):
 *
 *   - `POST /v1/admin/item-storage-usage` answered 200 with zero bytes and zero
 *     items for an account holding 201,106 bytes -- a complete, measured-looking
 *     zero (the compose stack answered the same zero, by a different route);
 *   - `GET  /v1/admin/users/:uuid/feature-flags` answered 200 with every flag at
 *     its default for an account whose flags had been changed;
 *   - `GET  /v1/admin/users/:uuid/usage` answered 200 for an account of that
 *     upper-case name, which does not exist;
 *   - `PUT  /v1/admin/users/:uuid/feature-flags` answered a bare 500.
 *
 * The rest refused the account as not found, which is honest but is still a real
 * account an administrator cannot reach by a valid spelling of its id -- and the
 * same requests succeeded on the compose stack, whose MySQL collation is
 * case-insensitive. One spelling in, one behaviour out.
 *
 * *** WHY NORMALISE RATHER THAN REFUSE. *** Because the mapping loses nothing:
 * the server never mints an upper-case id on this surface, so the lower-case form
 * IS the account. Refusing would turn away a spelling RFC 4122 says is valid and
 * that most of these routes already accepted on one topology.
 *
 * *** WHY HERE AND NOT IN `Uuid.create`. *** That value object also carries item
 * uuids, which CLIENTS mint and which are stored as sent; lower-casing those
 * would make an existing upper-case item unfindable on SQLite. This is scoped to
 * the admin surface, where every id is the server's own.
 *
 * *** WHY A CLASS DECORATOR AND NOT A BOUND MIDDLEWARE. *** A middleware has to
 * be bound in the container before a route can use it, and a route whose
 * middleware is not bound fails at request time while every build stays green.
 * This needs no binding: it wraps each routed method of the class it decorates,
 * so the request is canonical before the gateway's own handlers read it, before
 * the in-process DirectCall hands the same request to auth, and before the
 * proxied path is built from it. Apply it ABOVE `@controller`, so the routes it
 * wraps have been declared.
 */
export const withCanonicalAdminUuids: ClassDecorator = (target) => {
  const prototype = target.prototype as Record<string | symbol, unknown>
  for (const { key } of getControllerMethodMetadata(target as never)) {
    const handler = prototype[key] as (this: unknown, request: Request, ...rest: unknown[]) => unknown
    prototype[key] = function (this: unknown, request: Request, ...rest: unknown[]): unknown {
      canonicalizeAdminRequest(request)

      return handler.call(this, request, ...rest)
    }
  }
}
