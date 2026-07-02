/**
 * Standard Red Notes: helpers for validating CollaborationIDs scanned from QR
 * codes before they are accepted into the add-trusted-contact flow.
 *
 * A CollaborationID (see ContactService.buildCollaborationId in
 * @standardnotes/services) is the base64 encoding of:
 *   `${version}:${userUuid}:${publicKey}:${signingPublicKey}`
 * where version is currently '1'.
 */

export type ParsedCollaborationID = {
  version: string
  userUuid: string
  publicKey: string
  signingPublicKey: string
}

const SupportedCollaborationIdVersion = '1'

const UuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const Base64Regex = /^[A-Za-z0-9+/]+={0,2}$/

function base64DecodeSafely(value: string): string | undefined {
  if (!Base64Regex.test(value)) {
    return undefined
  }
  try {
    return atob(value)
  } catch {
    return undefined
  }
}

export function parseCollaborationIDSafely(value: string): ParsedCollaborationID | undefined {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const decoded = base64DecodeSafely(trimmed)
  if (!decoded) {
    return undefined
  }

  const parts = decoded.split(':')
  if (parts.length !== 4) {
    return undefined
  }

  const [version, userUuid, publicKey, signingPublicKey] = parts

  if (version !== SupportedCollaborationIdVersion) {
    return undefined
  }

  if (!UuidRegex.test(userUuid)) {
    return undefined
  }

  if (publicKey.length === 0 || signingPublicKey.length === 0) {
    return undefined
  }

  return { version, userUuid, publicKey, signingPublicKey }
}

export function isValidCollaborationID(value: string): boolean {
  return parseCollaborationIDSafely(value) !== undefined
}

/**
 * Given the raw string payload of a scanned QR code, returns the normalized
 * (trimmed) CollaborationID if the payload is a valid one, or undefined.
 */
export function collaborationIDFromQRPayload(rawPayload: string): string | undefined {
  const trimmed = rawPayload.trim()
  return isValidCollaborationID(trimmed) ? trimmed : undefined
}
