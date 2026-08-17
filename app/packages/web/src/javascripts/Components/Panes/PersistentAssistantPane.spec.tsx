/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import PersistentAssistantPane from './PersistentAssistantPane'

jest.mock('../Assistant/AssistantView', () => {
  const React = jest.requireActual<typeof import('react')>('react')

  return {
    __esModule: true,
    default: ({ className, id, children }: { className?: string; id: string; children?: import('react').ReactNode }) =>
      React.createElement('div', { id, className, 'data-testid': 'assistant-view' }, children),
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PersistentAssistantPane', () => {
  let container: HTMLDivElement
  let root: Root
  const application = {} as WebApplication

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const renderPane = (visible: boolean, className = 'app-pane app-pane-2') => {
    act(() => {
      root.render(createElement(PersistentAssistantPane, { application, className, visible }))
    })
  }

  it('does not mount eagerly and preserves the same assistant through dismiss and reopen', () => {
    renderPane(false)
    expect(container.querySelector('[data-testid="assistant-view"]')).toBeNull()

    renderPane(true)
    const opened = container.querySelector('[data-testid="assistant-view"]')
    expect(opened).not.toBeNull()
    expect(opened?.classList.contains('hidden')).toBe(false)

    renderPane(false)
    const dismissed = container.querySelector('[data-testid="assistant-view"]')
    expect(dismissed).toBe(opened)
    expect(dismissed?.classList.contains('hidden')).toBe(true)

    renderPane(true)
    const reopened = container.querySelector('[data-testid="assistant-view"]')
    expect(reopened).toBe(opened)
    expect(reopened?.classList.contains('hidden')).toBe(false)
  })

  it('preserves the mounted assistant when a mobile layout replacement changes its pane slot', () => {
    renderPane(true, 'app-pane app-pane-2 absolute')
    const beforeReplacement = container.querySelector('[data-testid="assistant-view"]')

    // Mobile setPaneLayout/replacePanes can omit Assistant entirely. The host is
    // retained in a hidden fallback slot rather than being removed from React.
    renderPane(false, 'app-pane app-pane-3 absolute')
    const duringReplacement = container.querySelector('[data-testid="assistant-view"]')
    expect(duringReplacement).toBe(beforeReplacement)
    expect(duringReplacement?.classList.contains('hidden')).toBe(true)
    expect(duringReplacement?.classList.contains('app-pane-3')).toBe(true)

    renderPane(true, 'app-pane app-pane-2 absolute')
    const afterReplacement = container.querySelector('[data-testid="assistant-view"]')
    expect(afterReplacement).toBe(beforeReplacement)
    expect(afterReplacement?.classList.contains('hidden')).toBe(false)
    expect(afterReplacement?.classList.contains('app-pane-2')).toBe(true)
  })
})
