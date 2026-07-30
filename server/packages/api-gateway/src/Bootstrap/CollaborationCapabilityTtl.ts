export const DEFAULT_COLLABORATION_CAPABILITY_TTL_SECONDS = 300
export const MIN_COLLABORATION_CAPABILITY_TTL_SECONDS = 30
export const MAX_COLLABORATION_CAPABILITY_TTL_SECONDS = 900

export function isValidCollaborationCapabilityTtlSeconds(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_COLLABORATION_CAPABILITY_TTL_SECONDS &&
    value <= MAX_COLLABORATION_CAPABILITY_TTL_SECONDS
  )
}

/**
 * Parse the collaboration capability lifetime at startup. Blank/unset keeps the
 * 300-second default; malformed, fractional, or out-of-range values abort
 * configuration instead of producing an unbounded or unusable JWT.
 */
export function parseCollaborationCapabilityTtlSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_COLLABORATION_CAPABILITY_TTL_SECONDS
  }

  const parsed = Number(value)
  if (!isValidCollaborationCapabilityTtlSeconds(parsed)) {
    throw new Error(
      'COLLABORATION_CAPABILITY_TTL_SECONDS must be a safe integer between ' +
        `${MIN_COLLABORATION_CAPABILITY_TTL_SECONDS} and ${MAX_COLLABORATION_CAPABILITY_TTL_SECONDS}.`,
    )
  }

  return parsed
}
