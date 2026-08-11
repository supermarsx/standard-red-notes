/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { ServerManagedAssistantConfig, useServerManagedAssistantConfig } from './useServerManagedAssistantConfig'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const config = (name: string): ServerManagedAssistantConfig => ({
  providers: ['openai'],
  defaultProvider: 'openai',
  defaultModel: `${name}-model`,
  profileConfigured: true,
  effectiveProfile: {
    id: `${name}-id`,
    name,
    provider: 'openai-compatible',
    model: `${name}-model`,
  },
})

type Observer = (event: ApplicationEvent) => Promise<void>

describe('useServerManagedAssistantConfig identity transitions', () => {
  let container: HTMLElement
  let root: Root
  let signedIn: boolean
  let observers: Observer[]
  let assistantConfigRequest: jest.Mock
  let application: WebApplication

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    signedIn = true
    observers = []
    assistantConfigRequest = jest.fn()
    application = {
      sessions: { isSignedIn: () => signedIn },
      assistantConfigRequest,
      addEventObserver: (observer: Observer) => {
        observers.push(observer)
        return () => {
          observers = observers.filter((candidate) => candidate !== observer)
        }
      },
    } as unknown as WebApplication
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const Harness = () => {
    const { config, loadError } = useServerManagedAssistantConfig(application, true)
    return createElement('div', null, `${config?.effectiveProfile?.name ?? 'no-profile'}|${loadError ?? 'no-error'}`)
  }

  const render = async () => {
    await act(async () => {
      root.render(createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const emit = async (event: ApplicationEvent) => {
    await act(async () => {
      for (const observer of [...observers]) {
        await observer(event)
      }
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('clears the previous principal immediately and reloads the new principal while proxy mode stays mounted', async () => {
    assistantConfigRequest.mockResolvedValueOnce(config('Principal A')).mockResolvedValueOnce(config('Principal B'))
    await render()
    expect(container.textContent).toBe('Principal A|no-error')

    signedIn = false
    await emit(ApplicationEvent.SignedOut)
    expect(container.textContent).toBe('no-profile|no-error')

    signedIn = true
    await emit(ApplicationEvent.SignedIn)
    expect(container.textContent).toBe('Principal B|no-error')
    expect(assistantConfigRequest).toHaveBeenCalledTimes(2)
  })

  it('does not let an old principal in-flight response repopulate state after sign-out', async () => {
    let resolveStale: (value: ServerManagedAssistantConfig) => void = () => undefined
    assistantConfigRequest
      .mockResolvedValueOnce(config('Principal A'))
      .mockImplementationOnce(() => new Promise<ServerManagedAssistantConfig>((resolve) => (resolveStale = resolve)))
    await render()
    expect(container.textContent).toBe('Principal A|no-error')

    await emit(ApplicationEvent.UserRolesChanged)
    expect(container.textContent).toBe('no-profile|no-error')

    signedIn = false
    await emit(ApplicationEvent.SignedOut)
    await act(async () => {
      resolveStale(config('Stale Principal A'))
      await Promise.resolve()
    })
    expect(container.textContent).toBe('no-profile|no-error')
  })

  it('clears an authenticated config error on sign-out', async () => {
    assistantConfigRequest.mockRejectedValueOnce(new Error('Principal A config failed'))
    await render()
    expect(container.textContent).toBe('no-profile|Principal A config failed')

    signedIn = false
    await emit(ApplicationEvent.SignedOut)
    expect(container.textContent).toBe('no-profile|no-error')
  })
})
