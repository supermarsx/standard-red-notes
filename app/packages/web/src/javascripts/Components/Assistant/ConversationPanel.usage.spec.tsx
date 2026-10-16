/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ApplicationEvent, PrefKey } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import ConversationPanel from './ConversationPanel'

jest.mock('@/Assistant/assistantContextSource', () => ({
  ...jest.requireActual('@/Assistant/assistantContextSource'),
  buildContextForSelection: () => ({
    scope: 'current-note',
    noteCount: 0,
    characters: 0,
    truncated: false,
    noteTitles: [],
  }),
  resolveContextNoteUuids: () => [],
}))
jest.mock('@/Assistant/selectionActions', () => ({ getSelectionAIAvailability: () => ({ available: false }) }))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: () => ({ presentPane: jest.fn() }) }))
jest.mock('./ContextSelector', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
HTMLElement.prototype.scrollTo = jest.fn()

it('keeps the token strip below the composer and ignores the previous account’s delayed usage response', async () => {
  let userUuid = 'account-a'
  let observer: ((event: ApplicationEvent) => Promise<void>) | undefined
  let resolveUsage!: (value: unknown) => void
  const application = {
    identifier: 'usage-test',
    storage: {},
    sessions: { isSignedIn: () => true, getUser: () => ({ uuid: userUuid }) },
    getPreference: (key: PrefKey, fallback: unknown) => (key === PrefKey.AssistantConnectionMode ? 'proxy' : fallback),
    addEventObserver: (callback: typeof observer) => {
      observer = callback
      return () => undefined
    },
    assistantConfigRequest: jest.fn(
      () =>
        new Promise((resolve) => {
          resolveUsage = resolve
        }),
    ),
    items: { addObserver: () => () => undefined },
    itemListController: { selectedItemsCount: 0 },
    itemControllerGroup: { itemControllers: [], addActiveControllerChangeObserver: () => () => undefined },
  } as unknown as WebApplication
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        createElement(ConversationPanel, {
          application,
          tabId: 'usage-chat',
          accountScope: 'account:account-a',
          persistenceAllowed: false,
        }),
      ),
    )
    const input = container.querySelector('textarea')!
    const meter = container.querySelector('[aria-label="Chat token usage"]')!
    expect(input.compareDocumentPosition(meter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => {
      userUuid = 'account-b'
      await observer?.(ApplicationEvent.SignedIn)
      resolveUsage({ tokens: { fiveHour: { usedTokens: 987, limitTokens: 1000, resetsAt: '' } } })
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="5-hour AI token usage"]')).toBeNull()
    expect(container.textContent).toContain('Last call · In not reported · Out not reported')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
