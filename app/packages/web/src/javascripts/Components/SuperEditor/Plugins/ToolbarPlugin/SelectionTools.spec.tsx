/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { PrefKey } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import SelectionTools from './SelectionTools'
import { captureSelectionSnapshot } from './SelectionReplacement'
import { publishAssistantDirective } from '@/Assistant/assistantDirectives'

jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: { Error: 'error' } }))
jest.mock('./SelectionReplacement', () => ({ captureSelectionSnapshot: jest.fn(() => ({ text: 'exact selection' })) }))
jest.mock('@/Assistant/assistantDirectives', () => ({
  publishAssistantDirective: jest.fn(() => ({ id: 'published' })),
}))
jest.mock('lexical', () => ({
  ...jest.requireActual('lexical'),
  $getRoot: () => ({ getTextContent: () => 'whole note text' }),
}))

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: jest.fn() }))
jest.mock('@/Components/Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))
jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: ({ type }: { type: string }) => <span data-icon={type} />,
}))
jest.mock('@/Components/Popover/Popover', () => ({ __esModule: true, default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const application = {
  addEventObserver: jest.fn(() => () => undefined),
  getPreference: jest.fn((key: PrefKey, fallback: unknown) => {
    return key === PrefKey.AssistantConnectionMode ? 'proxy' : fallback
  }),
  hasAccount: jest.fn(() => true),
  identifier: 'app',
  sessions: { getUser: () => ({ uuid: 'account' }) },
  items: { findItem: () => ({ uuid: 'note-1' }) },
  isAuthorizedToRenderItem: jest.fn(() => true),
}

describe('SelectionTools AI action subtabs', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    application.getPreference.mockImplementation((key: PrefKey, fallback: unknown) => {
      return key === PrefKey.AssistantConnectionMode ? 'proxy' : fallback
    })
    application.hasAccount.mockReturnValue(true)
    application.isAuthorizedToRenderItem.mockReturnValue(true)
    jest.mocked(captureSelectionSnapshot).mockReturnValue({ text: 'exact selection' } as never)
    jest.mocked(publishAssistantDirective).mockReturnValue({ id: 'published' } as never)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    jest.mocked(useApplication).mockReturnValue(application as never)
    jest.mocked(useResponsiveAppPane).mockReturnValue({ presentPane: jest.fn() } as never)
    act(() => {
      // The only thing this spec's subject reads off the editor is `getRootElement`, used to
      // resolve the action popover's own `#super-editor`. Rendered outside any Super editor,
      // null is the honest answer and the popover falls back to `document.body`.
      root.render(<SelectionTools editor={{ getRootElement: () => null } as never} hasSelection noteUuid="note-1" />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  const actionLabels = () =>
    Array.from(container.querySelectorAll('[role="tabpanel"] button')).map((button) => button.textContent)

  const selectTab = (label: string) => {
    const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (candidate) => candidate.textContent === label,
    )
    expect(tab).toBeDefined()
    act(() => tab!.click())
  }

  it('renders icon-and-label subtabs with text review actions in the requested line order', () => {
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Text review', 'Transforms', 'Assistant', 'Checklist'])
    expect(tabs.map((tab) => tab.querySelector('[data-icon]')?.getAttribute('data-icon'))).toEqual([
      'pencil-filled',
      'arrows-sort-down',
      'assistant',
      'list-check',
    ])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(actionLabels()).toEqual(['Refine', 'Expand', 'Summarize'])
  })

  it('switches to transforms and assistant directives without mixing groups', () => {
    selectTab('Transforms')
    expect(actionLabels()).toEqual(['Translate…', 'Organize'])

    selectTab('Assistant')
    expect(actionLabels()).toEqual(['Ask AI…', 'Explain in-depth'])
  })
  it('routes replacement and checklist actions into chat without changing editor text', async () => {
    const refine = container.querySelector<HTMLButtonElement>('[aria-label="Refine"]')!
    await act(async () => refine.click())
    expect(publishAssistantDirective).toHaveBeenCalledWith(
      expect.objectContaining({ noteUuid: 'note-1', selectedText: 'exact selection', contextKind: 'selection' }),
    )
    selectTab('Checklist')
    expect(actionLabels()).toEqual(['Organize checklist', 'Categorize items', 'Improve tasks', 'Split tasks'])
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Categorize items"]')!.click())
    expect(publishAssistantDirective).toHaveBeenLastCalledWith(
      expect.objectContaining({ instruction: expect.stringContaining('categories') }),
    )
  })

  it('uses this editor’s note when no text is selected, and rechecks read access before publishing', async () => {
    jest.mocked(captureSelectionSnapshot).mockReturnValueOnce(null)
    act(() =>
      root.render(
        <SelectionTools
          editor={{ getRootElement: () => null, getEditorState: () => ({ read: (fn: () => string) => fn() }) } as never}
          hasSelection={false}
          noteUuid="note-1"
        />,
      ),
    )
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refine"]')!.click())
    expect(publishAssistantDirective).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedText: 'whole note text', contextKind: 'note' }),
    )
    const count = jest.mocked(publishAssistantDirective).mock.calls.length
    application.isAuthorizedToRenderItem.mockReturnValueOnce(false)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refine"]')!.click())
    expect(publishAssistantDirective).toHaveBeenCalledTimes(count)
  })
})
