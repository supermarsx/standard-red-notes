/**
 * Pure URL normalizer for the Super editor Embed block.
 *
 * Converts common video "share"/"watch" URLs into their embeddable (iframe-able)
 * form. The watch URLs (e.g. youtube.com/watch?v=ID) cannot be iframed directly:
 * YouTube serves them with `X-Frame-Options: SAMEORIGIN`, so the browser refuses
 * to render them inside an <iframe>. The `youtube.com/embed/ID` form is the
 * official embeddable endpoint and is what we must point the iframe `src` at.
 *
 * SECURITY: this block auto-loads its iframe with `allow-scripts allow-same-origin`,
 * which lets the framed origin run scripts in its own real origin. That is only
 * acceptable for a small set of trusted video providers. Therefore this function
 * recognizes ONLY an explicit allowlist of providers and returns a known-good
 * embed URL pointing at one of their canonical embed hosts. Any URL we do not
 * recognize (including arbitrary http(s) origins and dangerous schemes such as
 * `javascript:` / `data:`) returns null — callers MUST NOT load such URLs in an
 * `allow-same-origin` iframe. Use the "Embed website" block (WebEmbedNode), which
 * is click-to-load and does not grant same-origin, for arbitrary pages.
 */

/**
 * Canonical embed origins we are willing to load auto + `allow-same-origin`.
 * Every URL returned by `toEmbedUrl` MUST have one of these origins.
 */
export const TRUSTED_EMBED_ORIGINS = [
  'https://www.youtube.com',
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
] as const

/**
 * Parse a YouTube timestamp into whole seconds.
 * Accepts a plain seconds value ("90") or the `1h2m3s` / `2m3s` / `45s` form.
 * Returns undefined when there is no usable timestamp.
 */
function parseYouTubeStart(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10)
    return seconds > 0 ? seconds : undefined
  }
  const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)
  if (!match || (!match[1] && !match[2] && !match[3])) {
    return undefined
  }
  const hours = parseInt(match[1] || '0', 10)
  const minutes = parseInt(match[2] || '0', 10)
  const seconds = parseInt(match[3] || '0', 10)
  const total = hours * 3600 + minutes * 60 + seconds
  return total > 0 ? total : undefined
}

function buildYouTubeEmbed(videoId: string, start?: number): string {
  const base = `https://www.youtube.com/embed/${videoId}`
  return start ? `${base}?start=${start}` : base
}

/**
 * Confirm a finished embed URL really points at a trusted embed origin. This is
 * the final gate: even if a regex above matched loosely, the returned string
 * cannot escape the allowlist.
 */
function isTrustedEmbedUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (TRUSTED_EMBED_ORIGINS as readonly string[]).includes(parsed.origin)
}

/**
 * Normalize a raw URL to a trusted, embeddable provider URL, or return null when
 * the URL is not a recognized provider.
 *
 * Recognized:
 * - YouTube watch / youtu.be / shorts -> www.youtube.com/embed/ID (preserving t=/start= as ?start=SECONDS)
 * - YouTube /embed/ URLs on youtube.com / youtube-nocookie.com -> rebuilt to the canonical embed URL
 * - Vimeo vimeo.com/ID -> player.vimeo.com/video/ID
 * - player.vimeo.com/video/ID -> normalized canonical player URL
 *
 * Everything else (arbitrary http(s) origins, dangerous schemes, malformed
 * input) returns null — it MUST NOT be auto-loaded in an allow-same-origin iframe.
 */
export function toEmbedUrl(raw: string): string | null {
  const url = (raw || '').trim()
  if (!url) {
    return null
  }

  // Parse as an absolute http(s) URL and match against the REAL hostname. This
  // prevents an arbitrary origin from "laundering" a provider ID via a path or
  // query substring (e.g. evil.com/?x=vimeo.com/123 or
  // youtube.com.attacker.example/...). Anything that is not a parseable http(s)
  // URL with a recognized provider host returns null.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  const host = parsed.hostname.toLowerCase()

  // Extract a timestamp from either a `t=` or `start=` query/param if present.
  const start =
    parseYouTubeStart(parsed.searchParams.get('t')) ?? parseYouTubeStart(parsed.searchParams.get('start'))

  const isYouTubeHost = host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com'
  const isYouTubeNoCookieHost = host === 'youtube-nocookie.com' || host === 'www.youtube-nocookie.com'
  const isYouTuBeHost = host === 'youtu.be'

  if (isYouTubeHost || isYouTubeNoCookieHost) {
    // /embed/ID
    const embed = parsed.pathname.match(/^\/embed\/([\w-]{11})$/)
    if (embed) {
      return buildYouTubeEmbed(embed[1], start)
    }
    // /shorts/ID
    const shorts = parsed.pathname.match(/^\/shorts\/([\w-]{11})$/)
    if (shorts) {
      return buildYouTubeEmbed(shorts[1], start)
    }
    // /watch?v=ID
    if (parsed.pathname === '/watch') {
      const v = parsed.searchParams.get('v')
      if (v && /^[\w-]{11}$/.test(v)) {
        return buildYouTubeEmbed(v, start)
      }
    }
    return null
  }

  if (isYouTuBeHost) {
    // youtu.be/ID
    const id = parsed.pathname.match(/^\/([\w-]{11})$/)
    if (id) {
      return buildYouTubeEmbed(id[1], start)
    }
    return null
  }

  // Vimeo: player.vimeo.com/video/ID or vimeo.com/ID
  if (host === 'player.vimeo.com') {
    const id = parsed.pathname.match(/^\/video\/(\d+)$/)
    if (id) {
      return `https://player.vimeo.com/video/${id[1]}`
    }
    return null
  }
  if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    const id = parsed.pathname.match(/^\/(\d+)$/)
    if (id) {
      return `https://player.vimeo.com/video/${id[1]}`
    }
    return null
  }

  return null
}

/**
 * Convenience: normalize and verify a raw URL ends up on a trusted embed origin.
 * Returns the embed URL or null. The extra origin check is defense-in-depth on
 * top of the provider matching above.
 */
export function toTrustedEmbedUrl(raw: string): string | null {
  const embedUrl = toEmbedUrl(raw)
  if (!embedUrl || !isTrustedEmbedUrl(embedUrl)) {
    return null
  }
  return embedUrl
}
