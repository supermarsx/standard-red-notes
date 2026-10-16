import { PrefKey } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'

/** The account preference can tighten the server's internet policy, never override it. */
export function assistantInternetAccessEnabled(application: WebApplication): boolean {
  return application.getPreference?.(PrefKey.AssistantInternetAccessEnabled, true) !== false
}
