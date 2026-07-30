import { AnyKeyParamsContent, ProtocolVersion } from '@standardnotes/common'
import { RootKeyContentSpecialized } from '@standardnotes/models'
import { PkcKeyPair } from '@standardnotes/sncrypto-common'

export const ACCOUNT_RECOVERY_ESCROW_SETTING_NAME = 'ACCOUNT_RECOVERY_ESCROW'
export const ACCOUNT_RECOVERY_VERSION = 2 as const
export const ACCOUNT_RECOVERY_CODE_PREFIX = 'SRN-RECOVERY-V2'
export const RECOVERY_CODE_ENTROPY_BITS = 256
export const RECOVERY_KDF_SALT_BITS = 128
export const RECOVERY_NONCE_BITS = 192
export const RECOVERY_ARGON_ITERATIONS = 5
export const RECOVERY_ARGON_MEMORY_BYTES = 64 * 1024 * 1024
export const RECOVERY_ARGON_OUTPUT_BYTES = 32
export const MAX_RECOVERY_CODE_LENGTH = 160
export const MAX_ESCROW_JSON_LENGTH = 64 * 1024
export const MAX_ESCROW_CIPHERTEXT_LENGTH = 48 * 1024
export const MAX_RECOVERY_SECRET_JSON_LENGTH = 32 * 1024

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX_32_PATTERN = /^[0-9a-f]{32}$/i
const HEX_48_PATTERN = /^[0-9a-f]{48}$/i
const HEX_64_PATTERN = /^[0-9a-f]{64}$/i
const HEX_PATTERN = /^[0-9a-f]+$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const ENVELOPE_FIELDS = ['ciphertext', 'nonce', 'salt', 'userUuid', 'version']
const SECRET_FIELDS = [
  'dataAuthenticationKey',
  'encryptionKeyPair',
  'keyParams',
  'masterKey',
  'serverPassword',
  'signingKeyPair',
  'version',
]
const KEY_PARAMS_FIELDS = ['created', 'email', 'identifier', 'origination', 'pw_cost', 'pw_nonce', 'pw_salt', 'version']
const KEY_PAIR_FIELDS = ['privateKey', 'publicKey']
const SUPPORTED_VERSIONS = new Set<string>([
  ProtocolVersion.V001,
  ProtocolVersion.V002,
  ProtocolVersion.V003,
  ProtocolVersion.V004,
])

export interface AccountRecoveryEscrowPayload {
  version: typeof ACCOUNT_RECOVERY_VERSION
  userUuid: string
  salt: string
  nonce: string
  ciphertext: string
}

export interface AccountRecoveryEscrowSecret extends RootKeyContentSpecialized {
  serverPassword: string
}

export type AccountRecoveryStatus = 'disabled' | 'enabled' | 'legacy'

export function accountRecoveryAssociatedData(userUuid: string): string {
  return `standard-red-notes:account-recovery:v2:${userUuid}`
}

export function createRecoveryCode(userUuid: string, secret: string): string {
  return `${ACCOUNT_RECOVERY_CODE_PREFIX}.${userUuid}.${secret}`
}

export function parseRecoveryCode(value: string): { userUuid: string; secret: string } | undefined {
  if (value.length === 0 || value.length > MAX_RECOVERY_CODE_LENGTH) {
    return undefined
  }

  const parts = value.split('.')
  if (
    parts.length !== 3 ||
    parts[0] !== ACCOUNT_RECOVERY_CODE_PREFIX ||
    !UUID_PATTERN.test(parts[1]) ||
    !HEX_64_PATTERN.test(parts[2])
  ) {
    return undefined
  }

  return { userUuid: parts[1], secret: parts[2] }
}

export function parseAccountRecoveryEnvelope(
  value: string,
  expectedUserUuid?: string,
): AccountRecoveryEscrowPayload | undefined {
  if (value.length === 0 || value.length > MAX_ESCROW_JSON_LENGTH) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed) || !hasExactFields(parsed, ENVELOPE_FIELDS)) {
    return undefined
  }
  if (
    parsed.version !== ACCOUNT_RECOVERY_VERSION ||
    typeof parsed.userUuid !== 'string' ||
    !UUID_PATTERN.test(parsed.userUuid) ||
    (expectedUserUuid !== undefined && parsed.userUuid !== expectedUserUuid) ||
    typeof parsed.salt !== 'string' ||
    !HEX_32_PATTERN.test(parsed.salt) ||
    typeof parsed.nonce !== 'string' ||
    !HEX_48_PATTERN.test(parsed.nonce) ||
    typeof parsed.ciphertext !== 'string' ||
    parsed.ciphertext.length === 0 ||
    parsed.ciphertext.length > MAX_ESCROW_CIPHERTEXT_LENGTH ||
    parsed.ciphertext.length % 4 !== 0 ||
    !BASE64_PATTERN.test(parsed.ciphertext)
  ) {
    return undefined
  }

  return parsed as unknown as AccountRecoveryEscrowPayload
}

export function serializeAccountRecoverySecret(rootKey: {
  keyVersion: ProtocolVersion
  masterKey: string
  serverPassword: string | undefined
  dataAuthenticationKey: string | undefined
  keyParams: { getPortableValue(): AnyKeyParamsContent }
  encryptionKeyPair: PkcKeyPair | undefined
  signingKeyPair: PkcKeyPair | undefined
}): string | undefined {
  if (!rootKey.serverPassword) {
    return undefined
  }

  const secret: AccountRecoveryEscrowSecret = {
    version: rootKey.keyVersion,
    masterKey: rootKey.masterKey,
    serverPassword: rootKey.serverPassword,
    keyParams: rootKey.keyParams.getPortableValue(),
    ...(rootKey.dataAuthenticationKey ? { dataAuthenticationKey: rootKey.dataAuthenticationKey } : {}),
    ...(rootKey.encryptionKeyPair ? { encryptionKeyPair: rootKey.encryptionKeyPair } : {}),
    ...(rootKey.signingKeyPair ? { signingKeyPair: rootKey.signingKeyPair } : {}),
  }
  const serialized = JSON.stringify(secret)
  return parseAccountRecoverySecret(serialized) ? serialized : undefined
}

export function parseAccountRecoverySecret(value: string): AccountRecoveryEscrowSecret | undefined {
  if (value.length === 0 || value.length > MAX_RECOVERY_SECRET_JSON_LENGTH) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed) || !hasOnlyFields(parsed, SECRET_FIELDS)) {
    return undefined
  }
  if (
    !SUPPORTED_VERSIONS.has(String(parsed.version)) ||
    !isBoundedSecret(parsed.masterKey) ||
    !isBoundedSecret(parsed.serverPassword) ||
    !isValidKeyParams(parsed.keyParams, parsed.version as ProtocolVersion)
  ) {
    return undefined
  }

  if (parsed.dataAuthenticationKey !== undefined && !isBoundedSecret(parsed.dataAuthenticationKey)) {
    return undefined
  }
  if (parsed.version === ProtocolVersion.V002 && !isBoundedSecret(parsed.dataAuthenticationKey)) {
    return undefined
  }

  const hasEncryptionPair = parsed.encryptionKeyPair !== undefined
  const hasSigningPair = parsed.signingKeyPair !== undefined
  if (hasEncryptionPair !== hasSigningPair) {
    return undefined
  }
  if (
    (hasEncryptionPair && !isValidKeyPair(parsed.encryptionKeyPair)) ||
    (hasSigningPair && !isValidKeyPair(parsed.signingKeyPair)) ||
    (parsed.version === ProtocolVersion.V004 && (!hasEncryptionPair || !hasSigningPair))
  ) {
    return undefined
  }

  return parsed as unknown as AccountRecoveryEscrowSecret
}

function isValidKeyParams(value: unknown, version: ProtocolVersion): value is AnyKeyParamsContent {
  if (!isPlainObject(value) || !hasOnlyFields(value, KEY_PARAMS_FIELDS)) {
    return false
  }
  if (
    value.version !== version ||
    (value.origination !== undefined && !isBoundedIdentifier(value.origination)) ||
    (value.created !== undefined && !isBoundedIdentifier(value.created))
  ) {
    return false
  }

  if (version === ProtocolVersion.V001 || version === ProtocolVersion.V002) {
    return (
      isBoundedIdentifier(value.email) &&
      typeof value.pw_cost === 'number' &&
      Number.isSafeInteger(value.pw_cost) &&
      value.pw_cost > 0 &&
      isBoundedIdentifier(value.pw_salt) &&
      isBoundedIdentifier(value.pw_nonce)
    )
  }

  return (
    isBoundedIdentifier(value.identifier) &&
    isBoundedIdentifier(value.pw_nonce) &&
    (version !== ProtocolVersion.V004 || (isBoundedIdentifier(value.created) && isBoundedIdentifier(value.origination)))
  )
}

function isValidKeyPair(value: unknown): value is PkcKeyPair {
  return (
    isPlainObject(value) &&
    hasExactFields(value, KEY_PAIR_FIELDS) &&
    isBoundedHex(value.privateKey) &&
    isBoundedHex(value.publicKey)
  )
}

function isBoundedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value
}

function isBoundedHex(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.length % 2 === 0 &&
    HEX_PATTERN.test(value)
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactFields(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((field, index) => field === expected[index])
}

function hasOnlyFields(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((field) => allowed.includes(field))
}
