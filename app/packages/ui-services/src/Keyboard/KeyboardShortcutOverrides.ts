import { KeyboardKey } from './KeyboardKey'
import { KeyboardModifier } from './KeyboardModifier'
import { KeyboardShortcut } from './KeyboardShortcut'

/**
 * Standard Red Notes: user-configurable keyboard shortcuts.
 *
 * Keyboard commands are JS Symbols, which are not serializable. Each command is
 * created via `Symbol(type)` with a stable `description` string (see
 * {@link KeyboardCommands}). We use that `Symbol.description` as the stable
 * persistence key for a user's override, so overrides survive reloads and remain
 * matched to the right command even though the Symbol identity changes per page
 * load.
 *
 * Only the chord (modifiers + key/code) is overridable. The `preventDefault`
 * behaviour and the command identity itself are never user-editable.
 */
export type SerializedKeyboardShortcut = {
  modifiers?: KeyboardModifier[]
  key?: KeyboardKey | string
  code?: string
}

/** Map of `Symbol.description` -> overridden chord. */
export type KeyboardShortcutOverrides = Record<string, SerializedKeyboardShortcut>

export const KEYBOARD_SHORTCUT_OVERRIDES_STORAGE_KEY = 'keyboardShortcutOverrides'

export function serializeShortcut(shortcut: KeyboardShortcut): SerializedKeyboardShortcut {
  const serialized: SerializedKeyboardShortcut = {}
  if (shortcut.modifiers && shortcut.modifiers.length > 0) {
    serialized.modifiers = [...shortcut.modifiers]
  }
  if (shortcut.key) {
    serialized.key = shortcut.key
  }
  if (shortcut.code) {
    serialized.code = shortcut.code
  }
  return serialized
}

export function loadKeyboardShortcutOverrides(): KeyboardShortcutOverrides {
  try {
    const raw = localStorage.getItem(KEYBOARD_SHORTCUT_OVERRIDES_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as KeyboardShortcutOverrides
    }
    return {}
  } catch (error) {
    console.error('Failed to load keyboard shortcut overrides', error)
    return {}
  }
}

export function persistKeyboardShortcutOverrides(overrides: KeyboardShortcutOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(KEYBOARD_SHORTCUT_OVERRIDES_STORAGE_KEY)
      return
    }
    localStorage.setItem(KEYBOARD_SHORTCUT_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides))
  } catch (error) {
    console.error('Failed to persist keyboard shortcut overrides', error)
  }
}

/**
 * Two chords are considered to conflict when they require the exact same set of
 * modifiers and resolve to the same physical key. A chord with neither a key nor
 * a code (a bare-modifier shortcut, e.g. Alt) only conflicts with another
 * bare-modifier chord using the same modifiers.
 */
export function shortcutsConflict(a: SerializedKeyboardShortcut, b: SerializedKeyboardShortcut): boolean {
  const modsA = [...(a.modifiers ?? [])].sort()
  const modsB = [...(b.modifiers ?? [])].sort()
  if (modsA.length !== modsB.length || modsA.some((mod, index) => mod !== modsB[index])) {
    return false
  }

  const keyA = a.key?.toLowerCase()
  const keyB = b.key?.toLowerCase()
  if (keyA || keyB) {
    return keyA === keyB
  }

  const codeA = a.code
  const codeB = b.code
  if (codeA || codeB) {
    return codeA === codeB
  }

  // Both are bare-modifier chords with identical modifier sets.
  return true
}
