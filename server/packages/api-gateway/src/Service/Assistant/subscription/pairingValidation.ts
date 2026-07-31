import { isSafeRecordKey } from '../../../Infra/SecureJsonFileStore'

const SUBSCRIPTION_ID_MAX_LENGTH = 128
const AUTHORIZATION_CODE_MAX_LENGTH = 4_096

/**
 * Historical encrypted stores accepted any safe record key as a slot id. Keep
 * that older shape readable only so administrators can identify and remove it;
 * runtime use and all newly-created pairings still require
 * isValidSubscriptionId.
 */
export function isLegacyCompatibleSubscriptionId(value: unknown): value is string {
  return isSafeRecordKey(value, SUBSCRIPTION_ID_MAX_LENGTH)
}

/**
 * Pairing slot ids are also used in settings records, URLs, and usage-meter
 * subjects. Keep them portable and unambiguous across every one of those
 * surfaces instead of accepting arbitrary JSON-record keys.
 */
export function isValidSubscriptionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= SUBSCRIPTION_ID_MAX_LENGTH &&
    isLegacyCompatibleSubscriptionId(value) &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)
  )
}

/** OAuth state generated from exactly 32 random bytes encoded as base64url. */
export function isValidPairingState(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** RFC 7636 verifier syntax and length. */
export function isValidPkceVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value)
}

/** Standard Notes user ids are canonical RFC 4122 UUIDs. */
export function isValidAdminUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

/**
 * OAuth authorization codes are opaque printable-ASCII values. They are never
 * persisted or echoed; this bound prevents oversized/control-character input
 * from reaching the upstream token endpoint.
 */
export function isValidAuthorizationCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= AUTHORIZATION_CODE_MAX_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  )
}
