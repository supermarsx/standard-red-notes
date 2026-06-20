// Local, unsynced home-page configuration. This lives in localStorage rather than a
// synced PrefKey because adding a PrefKey would require touching @standardnotes/models
// (off-limits for this web-only change). It mirrors the QuickActions storage pattern:
// the email-backup / large-file features likewise avoided published-models PrefKeys.
//
// The config describes a fully customizable "Home" landing view with three modes:
// - `default`: today's behavior (a friendly placeholder pane).
// - `note`:    render one chosen note as the landing page.
// - `cards`:   a user-built grid of tiles, each opening a note or selecting a tag/view.

import { VectorIconNameOrEmoji } from '@standardnotes/snjs'

const STORAGE_KEY = 'standardnotes.homeConfig.v1'

export type HomeMode = 'default' | 'note' | 'cards'

/** The kinds of things a home card can point at. */
export type HomeCardKind = 'note' | 'tag'

export interface HomeCard {
  /** Stable id for React keys + reorder/remove. */
  id: string
  kind: HomeCardKind
  /** uuid of the target note (kind: 'note') or tag/folder/smart-view (kind: 'tag'). */
  targetUuid: string
  /** Optional user label override. When empty we derive a label from the target. */
  label?: string
  /** Optional icon override. When empty we derive an icon from the card kind. */
  icon?: VectorIconNameOrEmoji
}

export interface HomeConfig {
  mode: HomeMode
  /** uuid of the note rendered in `note` mode. */
  noteUuid?: string
  cards: HomeCard[]
}

export const HOME_MODES: HomeMode[] = ['default', 'note', 'cards']
export const HOME_CARD_KINDS: HomeCardKind[] = ['note', 'tag']

const VALID_MODES = new Set<HomeMode>(HOME_MODES)
const VALID_CARD_KINDS = new Set<HomeCardKind>(HOME_CARD_KINDS)

/** The canonical empty config. */
export const DEFAULT_HOME_CONFIG: HomeConfig = { mode: 'default', cards: [] }

function isHomeCard(value: unknown): value is HomeCard {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.kind === 'string' &&
    VALID_CARD_KINDS.has(candidate.kind as HomeCardKind) &&
    typeof candidate.targetUuid === 'string' &&
    candidate.targetUuid.length > 0 &&
    (candidate.label === undefined || typeof candidate.label === 'string') &&
    (candidate.icon === undefined || typeof candidate.icon === 'string')
  )
}

/**
 * Coerce an arbitrary parsed value into a well-formed HomeConfig.
 *
 * - Unknown / missing `mode` falls back to `default`.
 * - `cards` is always an array of valid cards (malformed entries dropped).
 * - `noteUuid` is preserved only when it is a non-empty string.
 *
 * This is the single source of truth for "what is a valid config" and is unit-tested.
 */
export function normalizeHomeConfig(value: unknown): HomeConfig {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_HOME_CONFIG }
  }
  const candidate = value as Record<string, unknown>

  const mode: HomeMode = VALID_MODES.has(candidate.mode as HomeMode) ? (candidate.mode as HomeMode) : 'default'

  const cards = Array.isArray(candidate.cards) ? candidate.cards.filter(isHomeCard) : []

  const noteUuid =
    typeof candidate.noteUuid === 'string' && candidate.noteUuid.length > 0 ? candidate.noteUuid : undefined

  return { mode, noteUuid, cards }
}

/**
 * Drop cards whose target item no longer exists, given a predicate that resolves
 * whether a uuid currently maps to a live item. Also clears `noteUuid` (and falls
 * back to `default` mode) when the chosen home note has been deleted.
 *
 * Pure + unit-tested: the caller supplies the existence check so this has no app dep.
 */
export function pruneMissingTargets(config: HomeConfig, exists: (uuid: string) => boolean): HomeConfig {
  const cards = config.cards.filter((card) => exists(card.targetUuid))

  let mode = config.mode
  let noteUuid = config.noteUuid
  if (noteUuid !== undefined && !exists(noteUuid)) {
    noteUuid = undefined
    if (mode === 'note') {
      mode = 'default'
    }
  }

  return { mode, noteUuid, cards }
}

/** Move the card at `index` by `direction` (-1 up, +1 down). Returns a new array. */
export function reorderCards(cards: HomeCard[], index: number, direction: -1 | 1): HomeCard[] {
  const target = index + direction
  if (index < 0 || index >= cards.length || target < 0 || target >= cards.length) {
    return cards
  }
  const next = [...cards]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

export function loadHomeConfig(): HomeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_HOME_CONFIG }
    }
    return normalizeHomeConfig(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_HOME_CONFIG }
  }
}

export function saveHomeConfig(config: HomeConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeHomeConfig(config)))
  } catch {
    /* storage may be unavailable (private mode); config simply won't persist */
  }
}

/** Create a reasonably-unique id without pulling in a uuid dependency. */
export function createHomeCardId(): string {
  return `home_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
