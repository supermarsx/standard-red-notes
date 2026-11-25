import { ApplicationEvent, PrefKey } from '@standardnotes/snjs'
import { useLayoutEffect } from 'react'
import type { WebApplication } from '@/Application/WebApplication'

export const UI_SCALE_KEY = 'interfaceScale' as PrefKey
export function normalizeUiScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(75, Math.min(150, value))) : 100
}
export function applyUiScale(value: unknown, element: HTMLElement = document.documentElement): void {
  element.style.fontSize = `${normalizeUiScale(value)}%`
}
/** Root rem scaling keeps viewport coordinates intact, including portalled menus. */
export function useUiScale(application: WebApplication): void {
  useLayoutEffect(() => {
    const previous = document.documentElement.style.fontSize
    const reload = async () => applyUiScale(application.getPreference(UI_SCALE_KEY, 100))
    void reload()
    const remove = application.addEventObserver(reload, ApplicationEvent.PreferencesChanged)
    const launched = application.addEventObserver(reload, ApplicationEvent.Launched)
    return () => {
      remove?.()
      launched?.()
      document.documentElement.style.fontSize = previous
    }
  }, [application])
}
