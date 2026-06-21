/**
 * Pure URL validator/normalizer for the Super editor "Tweet / X post" embed
 * block.
 *
 * The Tweet block renders the official X/Twitter embed by handing a status URL
 * to platform.twitter.com/widgets.js. Because that widget reads the link from
 * the rendered <blockquote>, we MUST only ever feed it a canonical
 * twitter.com / x.com status URL — never an arbitrary origin or a dangerous
 * scheme (`javascript:`, `data:`, etc.). This function is the gate: it accepts
 * only http(s) URLs whose host is a twitter.com / x.com domain and whose path
 * is a `/<user>/status/<id>` permalink, and returns a normalized canonical
 * https URL. Anything else returns '' ("not embeddable").
 */

/** Allowed apex hosts (matched exactly or as a `*.host` subdomain). */
const ALLOWED_TWEET_HOSTS = ['twitter.com', 'x.com']

function isAllowedHost(host: string): boolean {
  const lower = host.toLowerCase()
  return ALLOWED_TWEET_HOSTS.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`))
}

export function sanitizeTweetUrl(raw: string | null | undefined): string {
  const input = (raw || '').trim()
  if (!input) {
    return ''
  }

  // Require an explicit http/https scheme up front so a string like
  // "javascript:alert(1)" can never be coerced into a "valid" URL.
  if (!/^https?:\/\//i.test(input)) {
    return ''
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return ''
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return ''
  }

  if (!isAllowedHost(parsed.hostname)) {
    return ''
  }

  // Must be a status permalink: /<user>/status/<numeric id> (also accept the
  // legacy /statuses/<id> form). We extract the id and rebuild a canonical URL
  // so query strings / fragments / trackers are dropped.
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})\/?$/)
  if (!match) {
    return ''
  }

  const user = match[1]
  const id = match[2]
  return `https://twitter.com/${user}/status/${id}`
}

/**
 * Convenience predicate mirroring sanitizeTweetUrl for readability at call
 * sites that just need a boolean.
 */
export function isValidTweetUrl(raw: string | null | undefined): boolean {
  return sanitizeTweetUrl(raw) !== ''
}
