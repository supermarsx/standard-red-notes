/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { DeepResearchReport } from '@/Assistant/deepResearch'
import { getDeepResearchAvailability, runDeepResearchForApplication } from '@/Assistant/deepResearchRunner'
import { getResearchModeAvailability } from '@/Assistant/researchModeRunner'
import AssistantView from './AssistantView'

jest.mock('./ConversationPanel', () => ({ __esModule: true, default: () => null }))
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
  const application = {
    identifier: 'test-app',
    sessions: {
      isSignedIn: () => true,
      getUser: () => ({ uuid: userUuid }),
    },
    protections: {
      isLocked: async () => locked,
    },
    addEventObserver: (observer: ApplicationObserver) => {
      observers.add(observer)
      return () => observers.delete(observer)
    },
  } as unknown as WebApplication

  return {
    application,
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

  it('keeps both research panels mounted while switching modes and preserves hidden work', async () => {
    const { application } = createApplication()
    await renderAssistant(root, application)

    const deepInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="e.g. What have I noted about our pricing strategy?"]',
    )
    const researchInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="e.g. An overview of the CRISPR-Cas9 mechanism"]',
    )
    expect(deepInput).not.toBeNull()
    expect(researchInput).not.toBeNull()
    expect(deepInput?.closest('.hidden')).not.toBeNull()
    expect(researchInput?.closest('.hidden')).not.toBeNull()

    click(container.querySelector('[aria-label="Deep research"]')!)
    expect(deepInput?.closest('.hidden')).toBeNull()
    typeInto(deepInput!, 'keep this background question')

    click(container.querySelector('[aria-label="Research mode"]')!)
    expect(deepInput?.closest('.hidden')).not.toBeNull()
    expect(researchInput?.closest('.hidden')).toBeNull()
    expect(deepInput?.value).toBe('keep this background question')

    click(container.querySelector('[aria-label="Research mode"]')!)
    expect(container.querySelector('textarea[placeholder^="e.g. What have I noted"]')).toBe(deepInput)
    expect(deepInput?.value).toBe('keep this background question')
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

    click(container.querySelector('[aria-label="Deep research"]')!)
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
    const newInput = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. What have I noted"]')!
    expect(newInput).not.toBe(oldInput)
    expect(newInput.value).toBe('')
    expect(newInput.closest('.hidden')).not.toBeNull()
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
})
