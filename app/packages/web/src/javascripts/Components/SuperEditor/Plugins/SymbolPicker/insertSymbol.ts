/**
 * Insertion + "recently used" state for the Insert -> Symbol picker.
 *
 * Insertion is plain text at the caret — the repo's own idiom (see
 * AutoPairPlugin.tsx:113): insert into the range selection when there is one,
 * otherwise append a fresh text node. The char becomes ordinary note text, so
 * there is NO custom node, command, or serialization concern.
 *
 * Recents are a self-contained, dependency-free localStorage cache (no PrefKey /
 * models edit). Every storage access is guarded so jsdom/SSR/absence never throws.
 */
import { $getSelection, $isRangeSelection, $insertNodes, $createTextNode } from 'lexical'

/** Insert `char` as plain text at the current selection (Lexical, runs inside editor.update). */
export function $insertSymbol(char: string): void {
  const selection = $getSelection()
  if ($isRangeSelection(selection)) {
    // Inserts at the caret, or replaces a non-collapsed range (Word-like).
    selection.insertText(char)
  } else {
    $insertNodes([$createTextNode(char)])
  }
}

/** Max number of recently-used symbols kept. */
export const RECENT_SYMBOLS_LIMIT = 24

const RECENT_SYMBOLS_STORAGE_KEY = 'super-editor:recent-symbols'

/**
 * Pure move-to-front reducer: put `char` first, dedupe, cap at the limit.
 * Returns a new array (never mutates the input).
 */
export function addRecentSymbol(list: string[], char: string): string[] {
  if (!char) {
    return list
  }
  return [char, ...list.filter((existing) => existing !== char)].slice(0, RECENT_SYMBOLS_LIMIT)
}

/** True when a working localStorage is reachable. Never throws. */
function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null
  } catch {
    return false
  }
}

/** Load the recents list from localStorage. Returns [] on any error/absence. */
export function loadRecentSymbols(): string[] {
  if (!hasLocalStorage()) {
    return []
  }
  try {
    const raw = localStorage.getItem(RECENT_SYMBOLS_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, RECENT_SYMBOLS_LIMIT)
  } catch {
    return []
  }
}

/** Persist the recents list to localStorage. Silently no-ops on any error/absence. */
export function saveRecentSymbols(list: string[]): void {
  if (!hasLocalStorage()) {
    return
  }
  try {
    localStorage.setItem(RECENT_SYMBOLS_STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_SYMBOLS_LIMIT)))
  } catch {
    // Ignore quota / disabled-storage / serialization failures — recents are best-effort.
  }
}
