import { useSyncExternalStore } from 'react'
import { formatPainterStore, FormatPainterState } from './formatPainterStore'

/**
 * React hook exposing the live format-painter state for a toolbar button. Use
 * `armed` to drive the button's active styling and `locked` to indicate sticky
 * mode.
 */
export function useFormatPainter(): FormatPainterState {
  return useSyncExternalStore(formatPainterStore.subscribe, formatPainterStore.getSnapshot)
}
