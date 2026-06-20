/**
 * Deterministically maps a stable id (a user uuid) to a color, so the same
 * collaborator always gets the same hue for their presence dot AND their remote
 * cursor across every client. Pure function — no shared state, no randomness.
 */

// A small palette of distinct, reasonably-accessible hues. Kept in sync with the
// cursor palette used when seeding `cursorColor` in SuperEditor.
export const COLLABORATOR_PALETTE = [
  '#e11d48', // rose
  '#2563eb', // blue
  '#16a34a', // green
  '#d97706', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#db2777', // pink
  '#65a30d', // lime
] as const

/** Stable string hash (djb2-ish) — small, deterministic, no crypto needed. */
function hashString(value: string): number {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i)
  }
  // Force unsigned 32-bit.
  return hash >>> 0
}

/** Returns a stable palette color for the given id (e.g. a user uuid). */
export function collaboratorColor(id: string): string {
  return COLLABORATOR_PALETTE[hashString(id) % COLLABORATOR_PALETTE.length]
}

/**
 * Two-letter initials for an avatar fallback, derived from a display name or
 * email. "ada@x.com" -> "AD", "Ada Lovelace" -> "AL".
 */
export function collaboratorInitials(nameOrEmail: string): string {
  const trimmed = nameOrEmail.trim()
  if (!trimmed) {
    return '?'
  }
  const parts = trimmed.split(/[\s@._-]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return trimmed.slice(0, 2).toUpperCase()
}
