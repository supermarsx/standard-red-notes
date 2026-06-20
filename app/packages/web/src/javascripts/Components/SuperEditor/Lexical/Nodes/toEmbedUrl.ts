/**
 * Pure URL normalizer for the Super editor Embed block.
 *
 * Converts common video "share"/"watch" URLs into their embeddable (iframe-able)
 * form. The watch URLs (e.g. youtube.com/watch?v=ID) cannot be iframed directly:
 * YouTube serves them with `X-Frame-Options: SAMEORIGIN`, so the browser refuses
 * to render them inside an <iframe>. The `youtube.com/embed/ID` form is the
 * official embeddable endpoint and is what we must point the iframe `src` at.
 *
 * Non-video / unrecognized URLs are returned unchanged so generic page embeds
 * keep working.
 */

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
 * Normalize a raw URL to an embeddable URL.
 * - YouTube watch / youtu.be / shorts -> youtube.com/embed/ID (preserving t=/start= as ?start=SECONDS)
 * - YouTube /embed/ URLs pass through unchanged
 * - Vimeo vimeo.com/ID -> player.vimeo.com/video/ID
 * - Everything else is returned trimmed but otherwise unchanged
 */
export function toEmbedUrl(raw: string): string {
  const url = (raw || '').trim()
  if (!url) {
    return ''
  }

  // Already an embeddable YouTube URL: pass through unchanged.
  if (/youtube(?:-nocookie)?\.com\/embed\/[\w-]{11}/i.test(url)) {
    return url
  }

  // Extract a timestamp from either a `t=` or `start=` query/param if present.
  const timestampMatch = url.match(/[?&#](?:t|start)=([\dhms]+)/i)
  const start = parseYouTubeStart(timestampMatch ? timestampMatch[1] : undefined)

  // youtube.com/watch?v=ID  and  youtu.be/ID  and  youtube.com/shorts/ID
  const yt = url.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/i)
  if (yt) {
    return buildYouTubeEmbed(yt[1], start)
  }

  // Vimeo: vimeo.com/ID  (already-embeddable player.vimeo.com URLs pass through below).
  if (/player\.vimeo\.com\/video\/\d+/i.test(url)) {
    return url
  }
  const vimeo = url.match(/vimeo\.com\/(\d+)/i)
  if (vimeo) {
    return `https://player.vimeo.com/video/${vimeo[1]}`
  }

  return url
}
