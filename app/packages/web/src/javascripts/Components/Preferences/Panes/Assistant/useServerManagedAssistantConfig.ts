import { useEffect, useState } from 'react'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

export type ServerManagedAssistantConfig = {
  /** Retained for compatibility with older clients; the current UI never offers overrides. */
  providers: string[]
  defaultProvider: string
  defaultModel: string
  profileConfigured: boolean
  effectiveProfile: {
    id: string
    name: string
    provider: string
    model: string
  } | null
}

/**
 * Loads the authenticated effective assistant profile and invalidates it on
 * every identity transition. A generation guard prevents an old principal's
 * in-flight response from repopulating state after sign-out/account switch.
 */
export function useServerManagedAssistantConfig(application: WebApplication, enabled: boolean) {
  const [config, setConfig] = useState<ServerManagedAssistantConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let generation = 0

    const clear = () => {
      setConfig(null)
      setLoadError(null)
    }

    const invalidate = () => {
      generation += 1
      clear()
    }

    const load = async () => {
      const requestGeneration = ++generation
      clear()
      if (!application.sessions.isSignedIn()) {
        return
      }

      try {
        const result = await application.assistantConfigRequest<ServerManagedAssistantConfig>('/v1/assistant/config')
        if (active && requestGeneration === generation) {
          setConfig(result)
        }
      } catch (error) {
        if (active && requestGeneration === generation) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }
    }

    if (!enabled) {
      invalidate()
      return () => {
        active = false
        generation += 1
      }
    }

    void load()
    const removeObserver = application.addEventObserver(async (event) => {
      switch (event) {
        case ApplicationEvent.SignedOut:
          invalidate()
          break
        case ApplicationEvent.Launched:
        case ApplicationEvent.SignedIn:
        case ApplicationEvent.UserRolesChanged:
          void load()
          break
        default:
          break
      }
    })

    return () => {
      active = false
      generation += 1
      removeObserver()
    }
  }, [application, enabled])

  return { config, loadError }
}
