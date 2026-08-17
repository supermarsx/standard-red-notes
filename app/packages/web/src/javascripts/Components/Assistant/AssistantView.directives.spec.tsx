/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import { ApplicationEvent } from '@standardnotes/snjs'
import { publishAssistantDirective, resetAssistantDirectivesForTests } from '@/Assistant/assistantDirectives'
import ConversationPanel from './ConversationPanel'
import AssistantView from './AssistantView'

jest.mock('./ConversationPanel', () => ({ __esModule: true, default: jest.fn(() => null) }))
jest.mock('./DeepResearchPanel', () => ({ __esModule: true, default: () => null }))
jest.mock('./ResearchModePanel', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('../Panes/ResponsivePaneProvider', () => ({
  useResponsiveAppPane: () => ({ dismissLastPane: jest.fn(), presentPane: jest.fn() }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const conversationPanelMock = jest.mocked(ConversationPanel)

type ApplicationObserver = (event: ApplicationEvent) => Promise<void>

const createApplicationHarness = () => {
  const values = new Map<string, unknown>()
  const observers = new Set<ApplicationObserver>()
  let checkLocked = async () => false
  const application = {
    identifier: 'directive-test-app',
    sessions: { getUser: () => ({ uuid: 'account-a' }) },
    storage: {
      getValue: (key: string) => values.get(key),
      setValue: (key: string, value: unknown) => void values.set(key, value),
      removeValue: async (key: string) => void values.delete(key),
    },
    protections: { isLocked: () => checkLocked() },
    addEventObserver: (observer: ApplicationObserver) => {
      observers.add(observer)
      return () => observers.delete(observer)
    },
  } as unknown as WebApplication
  return {
    application,
    setLockCheck: (check: () => Promise<boolean>) => {
      checkLocked = check
    },
    emit: async (event: ApplicationEvent) => {
      await Promise.all([...observers].map((observer) => observer(event)))
    },
  }
}

const createApplication = () => createApplicationHarness().application

const latestDirectiveProps = () =>
  conversationPanelMock.mock.calls
    .map(([props]) => props)
    .filter((props) => props.directive !== undefined)
    .at(-1)

describe('AssistantView editor directive routing', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    resetAssistantDirectivesForTests()
    conversationPanelMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    resetAssistantDirectivesForTests()
  })

  it('delivers queued directives FIFO to the tab active when each directive was published', async () => {
    const application = createApplication()
    const first = publishAssistantDirective({
      accountScope: 'account-a',
      noteUuid: 'note-a',
      instruction: 'Explain in depth',
      selectedText: 'first private selection',
    })!

    await act(async () => {
      root.render(createElement(AssistantView, { application, id: 'assistant' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const firstProps = latestDirectiveProps()
    expect(firstProps?.directive).toMatchObject({
      id: first.id,
      noteUuid: 'note-a',
      instruction: 'Explain in depth',
      selectedText: 'first private selection',
    })
    const firstTabId = firstProps?.tabId

    let second!: NonNullable<ReturnType<typeof publishAssistantDirective>>
    await act(async () => {
      second = publishAssistantDirective({
        accountScope: 'account-a',
        noteUuid: 'note-a',
        instruction: 'Ask about this',
        selectedText: 'second selection',
      })!
    })
    expect(latestDirectiveProps()?.directive?.id).toBe(first.id)

    await act(async () => firstProps?.onDirectiveConsumed?.(first.id))
    const secondProps = latestDirectiveProps()
    expect(secondProps?.directive?.id).toBe(second.id)
    expect(secondProps?.tabId).toBe(firstTabId)
    await act(async () => secondProps?.onDirectiveConsumed?.(second.id))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')?.click()
    })
    let third!: NonNullable<ReturnType<typeof publishAssistantDirective>>
    await act(async () => {
      third = publishAssistantDirective({
        accountScope: 'account-a',
        noteUuid: 'note-b',
        instruction: 'Explain this',
        selectedText: 'third selection',
      })!
    })

    const thirdProps = latestDirectiveProps()
    expect(thirdProps?.directive?.id).toBe(third.id)
    expect(thirdProps?.tabId).not.toBe(firstTabId)
  })

  it('drops selected plaintext published while a key transition is awaiting lock verification', async () => {
    const harness = createApplicationHarness()
    let resolveLockCheck!: (locked: boolean) => void
    harness.setLockCheck(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLockCheck = resolve
        }),
    )
    await act(async () =>
      root.render(createElement(AssistantView, { application: harness.application, id: 'assistant' })),
    )
    conversationPanelMock.mockClear()

    let boundary!: Promise<void>
    await act(async () => {
      boundary = harness.emit(ApplicationEvent.KeyStatusChanged)
      await Promise.resolve()
    })
    await act(async () => {
      publishAssistantDirective({
        accountScope: 'account-a',
        noteUuid: 'note-private',
        instruction: 'Explain this',
        selectedText: 'must be purged at the key boundary',
      })
    })
    await act(async () => {
      resolveLockCheck(false)
      await boundary
    })

    expect(conversationPanelMock.mock.calls.some(([props]) => props.directive !== undefined)).toBe(false)
  })
})
