/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ServerManagedAssistantConfiguration } from './ServerManagedAssistantConfiguration'
import { ServerManagedAssistantConfig } from './useServerManagedAssistantConfig'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const assignedConfig: ServerManagedAssistantConfig = {
  providers: ['openai'],
  defaultProvider: 'openai',
  defaultModel: 'assigned-model',
  profileConfigured: true,
  effectiveProfile: {
    id: 'assigned-profile',
    name: 'Writing team',
    provider: 'openai-compatible',
    model: 'assigned-model',
  },
}

describe('ServerManagedAssistantConfiguration', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = async (config: ServerManagedAssistantConfig | null, loadError: string | null = null) => {
    await act(async () => {
      root.render(createElement(ServerManagedAssistantConfiguration, { config, loadError }))
    })
  }

  it('renders the authenticated effective assignment as read-only provider/model information', async () => {
    await render(assignedConfig)

    expect(container.textContent).toContain('Writing team')
    expect(container.textContent).toContain('openai-compatible')
    expect(container.textContent).toContain('assigned-model')
    expect(container.textContent).toContain('Direct-mode provider and model preferences on this device are not used')
    expect(container.querySelectorAll('input, select, button')).toHaveLength(0)
  })

  it('shows an actionable unconfigured state', async () => {
    await render({
      providers: [],
      defaultProvider: '',
      defaultModel: '',
      profileConfigured: false,
      effectiveProfile: null,
    })

    expect(container.textContent).toContain('No assistant profile is assigned')
    expect(container.textContent).toContain('Preferences → Admin → AI')
  })

  it('shows an actionable authenticated-config load error', async () => {
    await render(null, 'Assistant server proxy returned HTTP 401.')

    expect(container.textContent).toContain('Could not load your server-assigned assistant')
    expect(container.textContent).toContain('Sign in again')
  })
})
