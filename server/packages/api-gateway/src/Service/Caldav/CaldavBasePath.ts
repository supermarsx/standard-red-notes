const SAFE_DAV_SEGMENT = /^[A-Za-z0-9._~-]+$/

/**
 * Validate and normalize the single CalDAV mount path used by routing and by
 * client configuration responses. Invalid operator input is a startup error;
 * silently advertising a different fallback would strand configured clients.
 */
export function normalizeCaldavBasePath(value: string): string {
  if (value !== value.trim()) {
    throw new Error(`CALDAV_BASE_PATH must be a safe absolute non-root path; received ${JSON.stringify(value)}.`)
  }

  const normalized = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
  const segments = normalized.split('/').slice(1)
  if (
    normalized.length === 0 ||
    normalized === '/' ||
    normalized.length > 256 ||
    !normalized.startsWith('/') ||
    normalized.includes('//') ||
    segments.some((segment) => segment === '.' || segment === '..' || !SAFE_DAV_SEGMENT.test(segment))
  ) {
    throw new Error(`CALDAV_BASE_PATH must be a safe absolute non-root path; received ${JSON.stringify(value)}.`)
  }
  return normalized
}
