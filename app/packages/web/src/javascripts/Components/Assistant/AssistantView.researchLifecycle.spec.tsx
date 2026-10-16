/** @jest-environment jsdom */

import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { DeepResearchReport } from '@/Assistant/deepResearch'
import { getDeepResearchAvailability, runDeepResearchForApplication } from '@/Assistant/deepResearchRunner'
import { getResearchModeAvailability } from '@/Assistant/researchModeRunner'
import AssistantView from './AssistantView'
import { assistantWorkspaceRetention } from '@/Assistant/assistantWorkspaceRetention'

jest.mock('./ConversationPanel', () => ({
  __esModule: true,
  default: ({
    recentChats,
    onFirstUserMessage,
    isActive,
  }: {
    recentChats?: ReactNode
    onFirstUserMessage: (text: string) => void
    isActive: boolean
  }) => (
    <div data-chat-active={String(isActive)}>
      {recentChats}
      <button aria-label="Seed conversation title" onClick={() => onFirstUserMessage('Saved project')}>
        Seed title
      </button>
    </div>
  ),
}))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('../Panes/ResponsivePaneProvider', () => ({
  useResponsiveAppPane: () => ({ dismissLastPane: jest.fn(), presentPane: jest.fn() }),
}))
jest.mock('@/Assistant/deepResearchRunner', () => ({
  getDeepResearchAvailability: jest.fn(),
  runDeepResearchForApplication: jest.fn(),
}))
jest.mock('@/Assistant/researchModeRunner', () => ({
  getResearchModeAvailability: jest.fn(),
  runResearchModeForApplication: jest.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deepAvailabilityMock = jest.mocked(getDeepResearchAvailability)
const researchAvailabilityMock = jest.mocked(getResearchModeAvailability)
const runDeepResearchMock = jest.mocked(runDeepResearchForApplication)

type ApplicationObserver = (event: ApplicationEvent) => Promise<void>

const createApplication = () => {
  let userUuid = 'account-a'
  let locked = false
  const observers = new Set<ApplicationObserver>()
  const values = new Map<string, unknown>()
  const application = {
    identifier: 'test-app',
    sessions: {
      isSignedIn: () => true,
      getUser: () => ({ uuid: userUuid }),
    },
    protections: {
      isLocked: async () => locked,
    },
    storage: {
      getValue: (key: string) => values.get(key),
      setValue: (key: string, value: unknown) => {
        values.set(key, value)
      },
      setValueAndAwaitPersist: async (key: string, value: unknown) => {
        values.set(key, value)
      },
      removeValue: async (key: string) => {
        values.delete(key)
      },
    },
    addEventObserver: (observer: ApplicationObserver) => {
      observers.add(observer)
      return () => observers.delete(observer)
    },
  } as unknown as WebApplication

  return {
    application,
    values,
    setUserUuid: (next: string) => {
      userUuid = next
    },
    setLocked: (next: boolean) => {
      locked = next
    },
    emit: async (event: ApplicationEvent) => {
      await Promise.all([...observers].map((observer) => observer(event)))
    },
  }
}

const click = (element: Element) => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const typeInto = (textarea: HTMLTextAreaElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const buttonWithText = (container: HTMLElement, label: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
  if (!button) {
    throw new Error(`Missing button: ${label}`)
  }
  return button
}

const renderAssistant = async (root: Root, application: WebApplication) => {
  await act(async () => {
    root.render(createElement(AssistantView, { application, id: 'assistant' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('AssistantView research background lifecycle', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    deepAvailabilityMock.mockReturnValue({ available: true })
    researchAvailabilityMock.mockReturnValue({ available: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('creates independent typed research tabs and preserves hidden work while switching and reopening them', async () => {
    const { application } = createApplication()
    await renderAssistant(root, application)

    expect(container.querySelector('textarea')).toBeNull()
    click(container.querySelector('[aria-label="Deep research"]')!)
    const deepInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="e.g. What have I noted about our pricing strategy?"]',
    )
    expect(deepInput).not.toBeNull()
    typeInto(deepInput!, 'keep this background question')
    click(container.querySelector('[aria-label="Research mode"]')!)
    const researchInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="e.g. An overview of the CRISPR-Cas9 mechanism"]',
    )
    expect(deepInput).not.toBeNull()
    expect(researchInput).not.toBeNull()
    expect(deepInput?.closest('.hidden')).not.toBeNull()
    expect(researchInput?.closest('.hidden')).toBeNull()
    expect(deepInput?.value).toBe('keep this background question')

    click(container.querySelector('[aria-label="Deep research"]')!)
    const deepInputs = container.querySelectorAll<HTMLTextAreaElement>(
      'textarea[placeholder^="e.g. What have I noted"]',
    )
    expect(deepInputs).toHaveLength(2)
    expect(deepInputs[1].value).toBe('')
    typeInto(deepInputs[1], 'second investigation')
    const firstTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.title === 'Keep this background question',
    )!
    click(firstTab)
    expect(deepInput?.closest('.hidden')).toBeNull()
    click(firstTab.querySelector('[aria-label="Close chat"]')!)
    expect(deepInput?.closest('.hidden')).not.toBeNull()
    click(container.querySelector('[aria-label="Chat history"]')!)
    click(container.querySelector('[aria-label="Resume Keep this background question"]')!)
    expect(container.querySelector('textarea[placeholder^="e.g. What have I noted"]')).toBe(deepInput)
    expect(deepInput?.value).toBe('keep this background question')
    expect(deepInput?.closest('.hidden')).toBeNull()
  })

  it('lets an active research run finish while its mounted panel is hidden', async () => {
    const harness = createApplication()
    let resolveRun!: (result: DeepResearchReport | null) => void
    let runSignal: AbortSignal | undefined
    runDeepResearchMock.mockImplementation((_application, _question, options) => {
      runSignal = options?.signal
      return new Promise((resolve) => {
        resolveRun = resolve
      })
    })
    await renderAssistant(root, harness.application)

    click(container.querySelector('[aria-label="Deep research"]')!)
    typeInto(
      container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!,
      'background question',
    )
    click(buttonWithText(container, 'Run deep research'))
    click(container.querySelector('[aria-label="Research mode"]')!)

    expect(runSignal?.aborted).toBe(false)
    await act(async () => harness.emit(ApplicationEvent.SignedIn))
    expect(runSignal?.aborted).toBe(false)
    await act(async () => {
      resolveRun({
        question: 'background question',
        report: 'Background result arrived',
        sources: [],
        rounds: 1,
        stopReason: 'model-finished',
      })
    })
    expect(runSignal?.aborted).toBe(false)

    click(
      [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.title === 'Background question')!,
    )
    expect(container.textContent).toContain('Background result arrived')
  })

  it('aborts and resets account-keyed research work on an account transition', async () => {
    const harness = createApplication()
    let runSignal: AbortSignal | undefined
    runDeepResearchMock.mockImplementation((_application, _question, options) => {
      runSignal = options?.signal
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(null), { once: true })
      })
    })
    await renderAssistant(root, harness.application)

    click(container.querySelector('[aria-label="Deep research"]')!)
    const oldInput = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!
    typeInto(oldInput, 'account-a private question')
    click(buttonWithText(container, 'Run deep research'))
    expect(runSignal?.aborted).toBe(false)

    harness.setUserUuid('account-b')
    await act(async () => harness.emit(ApplicationEvent.SignedIn))

    expect(runSignal?.aborted).toBe(true)
    expect(container.querySelector('textarea[placeholder^="e.g. What have I noted"]')).toBeNull()
    click(container.querySelector('[aria-label="Deep research"]')!)
    const newInput = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!
    expect(newInput).not.toBe(oldInput)
    expect(newInput.value).toBe('')
    expect(newInput.closest('.hidden')).toBeNull()
  })

  it('aborts background research when the root-key status changes', async () => {
    const harness = createApplication()
    let runSignal: AbortSignal | undefined
    runDeepResearchMock.mockImplementation((_application, _question, options) => {
      runSignal = options?.signal
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(null), { once: true })
      })
    })
    await renderAssistant(root, harness.application)

    click(container.querySelector('[aria-label="Deep research"]')!)
    typeInto(
      container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!,
      'private background question',
    )
    click(buttonWithText(container, 'Run deep research'))
    expect(runSignal?.aborted).toBe(false)

    harness.setLocked(true)
    await act(async () => harness.emit(ApplicationEvent.KeyStatusChanged))

    expect(runSignal?.aborted).toBe(true)
    expect(container.textContent).toContain('Assistant workspace locked')
    expect(container.textContent).not.toContain('private background question')

    harness.setLocked(false)
    await act(async () => harness.emit(ApplicationEvent.KeyStatusChanged))
    expect(container.textContent).not.toContain('Assistant workspace locked')
  })

  it('refreshes hidden-panel availability after assistant configuration changes', async () => {
    const harness = createApplication()
    deepAvailabilityMock.mockReturnValue({ available: false, reason: 'Configure the provider.' })
    await renderAssistant(root, harness.application)

    click(container.querySelector('[aria-label="Deep research"]')!)

    const input = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!
    expect(input.disabled).toBe(true)
    expect(container.textContent).toContain('Configure the provider.')

    deepAvailabilityMock.mockReturnValue({ available: true })
    await act(async () => harness.emit(ApplicationEvent.PreferencesChanged))

    expect(input.disabled).toBe(false)
    expect(container.textContent).not.toContain('Configure the provider.')
  })

  it('aborts background research on full assistant unmount', async () => {
    const { application } = createApplication()
    let runSignal: AbortSignal | undefined
    runDeepResearchMock.mockImplementation((_application, _question, options) => {
      runSignal = options?.signal
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(null), { once: true })
      })
    })
    await renderAssistant(root, application)

    click(container.querySelector('[aria-label="Deep research"]')!)
    typeInto(
      container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!,
      'pending work',
    )
    click(buttonWithText(container, 'Run deep research'))

    act(() => root.unmount())
    expect(runSignal?.aborted).toBe(true)
    root = createRoot(container)
  })

  it('keeps a closed investigation running, resumes its same state from History, and aborts it only on delete', async () => {
    const harness = createApplication()
    let signal: AbortSignal | undefined
    runDeepResearchMock.mockImplementation((_application, _question, options) => {
      signal = options?.signal
      return new Promise((resolve) => options?.signal?.addEventListener('abort', () => resolve(null), { once: true }))
    })
    await renderAssistant(root, harness.application)
    const history = container.querySelector('[aria-label="Chat history"]')!
    expect(history.nextElementSibling?.getAttribute('aria-label')).toBe('Deep research')
    click(container.querySelector('[aria-label="Deep research"]')!)
    const input = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!
    typeInto(input, 'saved investigation')
    click(buttonWithText(container, 'Run deep research'))
    const tab = container.querySelector('[role="tab"][aria-label="Saved investigation"]')!
    click(tab.querySelector('[aria-label="Close chat"]')!)
    expect(signal?.aborted).toBe(false)
    click(history)
    click(container.querySelector('[aria-label="Resume Saved investigation"]')!)
    expect(input.closest('.hidden')).toBeNull()
    expect(input.value).toBe('saved investigation')
    click(container.querySelector('[role="tab"][aria-label="Saved investigation"] [aria-label="Chat options"]')!)
    await act(async () => buttonWithText(container, 'Delete chat').click())
    expect(signal?.aborted).toBe(true)
    expect(container.querySelector('textarea[placeholder^="e.g. What have I noted"]')).toBeNull()
  })

  it('offers recent named chats on an empty chat and resumes hidden entries without transcript previews', async () => {
    const { application } = createApplication()
    await renderAssistant(root, application)
    click(container.querySelector('[data-chat-active="true"] [aria-label="Seed conversation title"]')!)
    click(container.querySelector('[aria-label="New chat"]')!)
    const prior = container.querySelector('[role="tab"][aria-label="Saved project"]')!
    click(prior.querySelector('[aria-label="Close chat"]')!)
    const recent = container.querySelector('[data-chat-active="true"] [aria-label="Recent chats"]')!
    expect(recent).not.toBeNull()
    expect(recent.textContent).toContain('Saved project')
    expect(recent.textContent).not.toContain('New chat')
    click(recent.querySelector('button')!)
    expect(container.querySelector('[role="tab"][aria-label="Saved project"]')?.getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(JSON.stringify(localStorage)).not.toContain('Saved project')
  })

  it('reopens a visible fallback when History closes or the only visible investigation is deleted', async () => {
    const { application } = createApplication()
    await renderAssistant(root, application)
    click(container.querySelector('[aria-label="Research mode"]')!)
    const input = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. An overview"]')!
    typeInto(input, 'first investigation')
    click(container.querySelector('[role="tab"][aria-label="New chat"] [aria-label="Chat options"]')!)
    await act(async () => buttonWithText(container, 'Delete chat').click())
    click(container.querySelector('[role="tab"][aria-label="First investigation"] [aria-label="Close chat"]')!)
    expect(container.querySelector('[role="tab"][aria-label="History"]')?.getAttribute('aria-selected')).toBe('true')
    click(container.querySelector('[aria-label="Close history"]')!)
    expect(
      container.querySelector('[role="tab"][aria-label="First investigation"]')?.getAttribute('aria-selected'),
    ).toBe('true')
    expect(input.closest('.hidden')).toBeNull()
    click(container.querySelector('[aria-label="Deep research"]')!)
    click(container.querySelector('[role="tab"][aria-label="First investigation"] [aria-label="Close chat"]')!)
    const active = container.querySelector('[role="tab"][aria-selected="true"]')!
    click(active.querySelector('[aria-label="Chat options"]')!)
    await act(async () => buttonWithText(container, 'Delete chat').click())
    expect(
      container.querySelector('[role="tab"][aria-label="First investigation"]')?.getAttribute('aria-selected'),
    ).toBe('true')
    expect(input.closest('.hidden')).toBeNull()
  })

  it('restores encrypted typed labels after reload without claiming that an old research job resumed', async () => {
    // Retention's cross-window lock behavior has its own integration suite;
    // this host test isolates the encrypted manifest restore contract.
    jest.spyOn(assistantWorkspaceRetention, 'claimWorkspace').mockImplementation(async () => ({
      durable: true,
      retired: false,
      trackedTabIds: [],
      runPersistence: async (operation) => {
        await operation()
        return true
      },
      retirePersistence: async (_id, cleanup) => {
        await cleanup()
        return true
      },
      registerFinalizer: () => () => {},
      updateTabIds: async () => true,
      touch: async () => true,
      release: async () => {},
    }))
    const { application, values } = createApplication()
    await renderAssistant(root, application)
    click(container.querySelector('[aria-label="Deep research"]')!)
    typeInto(container.querySelector('textarea[placeholder^="e.g. What have I noted"]')!, 'retained research title')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect([...values.values()].some((value) => JSON.stringify(value).includes('"kind":"deep-research"'))).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    await renderAssistant(root, application)
    const restored = container.querySelector('[role="tab"][aria-label="Retained research title"]')!
    expect(restored).not.toBeNull()
    click(restored)
    const input = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!
    expect(input.value).toBe('')
    expect(runDeepResearchMock).not.toHaveBeenCalled()
    click(container.querySelector('[aria-label="Chat history"]')!)
    expect(container.querySelector('[aria-label="Assistant history"]')?.textContent).toContain(
      'only while this app stays open',
    )
  })
})
