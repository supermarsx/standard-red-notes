import { AppDataField, PrefKey, SNNote } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'

export const EDITOR_VIEW_DEFAULTS_KEY = 'editorViewDefaults' as PrefKey
export const NOTE_VIEW_KEY = 'editorView' as AppDataField
export const EDITOR_VIEW_CHANGED = 'srn:editor-view-changed'
export type EditorViewPreferences = {
  tocVisible: boolean
  tocToggle: boolean
  tocMode: 'left' | 'right' | 'floating'
  bookmarks: boolean
  tocWidth: number
  tocHeight: number
  tocX: number
  tocY: number
  commentsVisible: boolean
  compactTitle: boolean
  compactTabs: boolean
  checklistBoxSizing: 'font' | 'fixed'
  checklistBoxScale: number
  checklistBoxSize: number
}
export const DEFAULT_EDITOR_VIEW: EditorViewPreferences = {
  tocVisible: false,
  tocToggle: true,
  tocMode: 'right',
  bookmarks: true,
  tocWidth: 260,
  tocHeight: 360,
  tocX: 24,
  tocY: 24,
  commentsVisible: false,
  compactTitle: true,
  compactTabs: true,
  checklistBoxSizing: 'font',
  checklistBoxScale: 100,
  checklistBoxSize: 18,
}
export function normalizeEditorView(value: unknown): EditorViewPreferences {
  const source = value && typeof value === 'object' ? (value as Partial<EditorViewPreferences>) : {}
  const next = { ...DEFAULT_EDITOR_VIEW }
  for (const key of [
    'tocVisible',
    'tocToggle',
    'bookmarks',
    'commentsVisible',
    'compactTitle',
    'compactTabs',
  ] as const) {
    if (typeof source[key] === 'boolean') {
      next[key] = source[key]
    }
  }
  if (source.tocMode === 'left' || source.tocMode === 'right' || source.tocMode === 'floating') {
    next.tocMode = source.tocMode
  }
  if (source.checklistBoxSizing === 'font' || source.checklistBoxSizing === 'fixed') {
    next.checklistBoxSizing = source.checklistBoxSizing
  }
  for (const [key, min, max] of [
    ['tocWidth', 200, 600],
    ['tocHeight', 160, 900],
    ['tocX', 0, 10000],
    ['tocY', 0, 10000],
    ['checklistBoxScale', 50, 200],
    ['checklistBoxSize', 10, 64],
  ] as const) {
    const number = source[key]
    if (typeof number === 'number' && Number.isFinite(number)) {
      next[key] = Math.round(Math.max(min, Math.min(max, number)))
    }
  }
  return next
}
export function normalizeViewOverrides(value: unknown): Partial<EditorViewPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const normalized = normalizeEditorView(value)
  return Object.fromEntries(
    Object.entries(normalized).filter(([key]) => Object.prototype.hasOwnProperty.call(value, key)),
  )
}
export function readEditorViewDefaults(application: Pick<WebApplication, 'getPreference'>): EditorViewPreferences {
  const stored = application.getPreference?.(EDITOR_VIEW_DEFAULTS_KEY, undefined)
  if (typeof stored === 'string') {
    try {
      return normalizeEditorView(JSON.parse(stored))
    } catch {
      return { ...DEFAULT_EDITOR_VIEW }
    }
  }
  return normalizeEditorView(stored)
}
export function noteViewOverrides(note?: Pick<SNNote, 'getAppDomainValue'>): Partial<EditorViewPreferences> {
  return normalizeViewOverrides(note?.getAppDomainValue?.(NOTE_VIEW_KEY))
}
export function readEditorView(
  note: Pick<SNNote, 'getAppDomainValue'> | undefined,
  application: Pick<WebApplication, 'getPreference'>,
): EditorViewPreferences {
  return normalizeEditorView({ ...readEditorViewDefaults(application), ...noteViewOverrides(note) })
}
