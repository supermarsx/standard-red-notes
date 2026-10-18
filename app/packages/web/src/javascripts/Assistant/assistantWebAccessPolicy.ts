import type { PrefKey } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'

export type AssistantWebAccessMode = 'allow' | 'safe' | 'strict'
export const ASSISTANT_WEB_ACCESS_MODE_PREF_KEY = 'assistantWebAccessMode' as PrefKey
export function normalizeAssistantWebAccessMode(value: unknown): AssistantWebAccessMode {
  return value === undefined || value === 'allow' ? 'allow' : value === 'safe' ? 'safe' : 'strict'
}
export function getAssistantWebAccessMode(application: WebApplication): AssistantWebAccessMode {
  return normalizeAssistantWebAccessMode(application.getPreference?.(ASSISTANT_WEB_ACCESS_MODE_PREF_KEY, 'allow'))
}
/** Exact returned URLs only; grants are bounded and local to this tool session/run. */
export class AssistantWebAccessPolicy {
  private approvedSearchUrls = new Set<string>()
  requiresApproval(mode: AssistantWebAccessMode, action: 'search' | 'fetch', value: string): boolean {
    return mode === 'strict' || (mode === 'safe' && (action === 'search' || !this.approvedSearchUrls.has(value)))
  }
  recordSearch(mode: AssistantWebAccessMode, urls: string[]): void {
    if (mode !== 'safe') {
      return
    }
    for (const url of urls) {
      if (this.approvedSearchUrls.size >= 600) {
        break
      }
      if (/^https?:\/\//i.test(url)) {
        this.approvedSearchUrls.add(url)
      }
    }
  }
}
