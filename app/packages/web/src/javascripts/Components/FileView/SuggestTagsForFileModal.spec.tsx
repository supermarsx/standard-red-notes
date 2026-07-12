/**
 * @jest-environment jsdom
 *
 * UI-render + confirm-flow guard for the file AI tag-suggestion feature (task t63).
 * This repo has twice shipped tsc-green components that never rendered (MEMORY:
 * "verify UI render paths"), so we render the REAL modal end-to-end and assert:
 *  - the file-tailored exposure warning + "Suggest topics" button render,
 *  - generating yields checkbox rows (existing vs new),
 *  - NOTHING is applied until the explicit "Add N topics" confirm, and applying
 *    goes through findOrCreateTag + addTagToItem(tag, file, false) + one sync,
 *  - the FileViewWithoutProtection title bar actually mounts the "Suggest topics"
 *    trigger (the surface that opens this modal).
 * The assistant call + on-device extraction are mocked (no network / no OCR).
 */
import { createElement, act } from 'react'
import { createRoot, Root } from 'react-dom/client'

// --- Mocks (hoisted) --------------------------------------------------------
jest.mock('@standardnotes/filepicker', () => ({ formatSizeToReadableString: () => '2 KB' }))

const addToastMock = jest.fn()
jest.mock('@standardnotes/toast', () => ({
  addToast: (...args: unknown[]) => addToastMock(...args),
  ToastType: { Success: 'success', Error: 'error', Regular: 'regular' },
}))

const availabilityMock = jest.fn(() => ({ available: true }) as { available: boolean; reason?: string })
jest.mock('@/Assistant/selectionActions', () => ({ getSelectionAIAvailability: () => availabilityMock() }))

const suggestTagsForFileMock = jest.fn()
jest.mock('@/Assistant/tagSuggestions', () => ({
  suggestTagsForFile: (...args: unknown[]) => suggestTagsForFileMock(...args),
}))

const extractFileTextForTagsMock = jest.fn()
jest.mock('@/Components/FilePreview/fileTextExtraction', () => ({
  extractFileTextForTags: (...args: unknown[]) => extractFileTextForTagsMock(...args),
}))

// Heavy siblings of the file view — stubbed so the title-bar render test is focused.
jest.mock('@/Components/FilePreview/FilePreview', () => () => null)
jest.mock('@/Components/FileContextMenu/FileOptionsPanel', () => () => null)
jest.mock('@/Components/LinkedItems/LinkedItemsButton', () => () => null)
jest.mock('@/Components/LinkedItems/LinkedItemBubblesContainer', () => () => null)
jest.mock('@/Components/Popover/Popover', () => () => null)
jest.mock('@/Components/NoteGroupView/MobileItemsListButton', () => () => null)
jest.mock('@/Components/FileDragNDropProvider', () => ({
  useFileDragNDrop: () => ({ addDragTarget: () => undefined, removeDragTarget: () => undefined }),
}))
jest.mock('@/Hooks/useItemVaultInfo', () => ({ useItemVaultInfo: () => ({ vault: undefined }) }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import SuggestTagsForFileModal from './SuggestTagsForFileModal'
import FileViewWithoutProtection from './FileViewWithoutProtection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const file = {
  name: 'invoice.txt',
  mimeType: 'text/plain',
  decryptedSize: 2048,
  uuid: 'file-1',
  remoteIdentifier: 'remote-1',
  protected: false,
} as never

const findOrCreateTagMock = jest.fn(async (name: string) => ({ title: name, uuid: `tag-${name}` }))
const addTagToItemMock = jest.fn(async (_tag: unknown, _item: unknown, _sync: boolean) => undefined)
const syncMock = jest.fn(async () => undefined)

const makeApp = (existingTags: { title: string }[] = []) =>
  ({
    items: { getDisplayableTags: () => existingTags },
    mutator: { findOrCreateTag: findOrCreateTagMock },
    linkingController: { addTagToItem: addTagToItemMock },
    sync: { sync: syncMock },
    // FileViewWithoutProtection deps
    vaultUsers: {
      isCurrentUserReadonlyVaultMember: () => false,
      addEventObserver: () => () => undefined,
    },
    // AndroidBackHandler deps (Modal uses them via the back handler)
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
  }) as never

let container: HTMLElement
let root: Root
let originalAnimate: typeof Element.prototype.animate

beforeEach(() => {
  jest.clearAllMocks()
  availabilityMock.mockReturnValue({ available: true })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  originalAnimate = Element.prototype.animate
  Element.prototype.animate = function () {
    return {
      finished: Promise.resolve(),
      cancel: () => undefined,
      finish: () => undefined,
      currentTime: 0,
    } as unknown as Animation
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.querySelectorAll('[data-dialog-portal]').forEach((el) => el.remove())
  Element.prototype.animate = originalAnimate
})

const withProviders = (app: never, child: ReturnType<typeof createElement>) =>
  createElement(ApplicationProvider, {
    application: app,
    children: createElement(AndroidBackHandlerProvider, { application: app, children: child }),
  })

const renderModal = (app = makeApp()) => {
  act(() => {
    root.render(
      withProviders(
        app,
        createElement(SuggestTagsForFileModal, { application: app, file, isOpen: true, close: () => undefined }),
      ),
    )
  })
}

// Exact (trimmed) text match so "Add" (the custom-topic button) is not shadowed by
// the "Add N topics" primary action.
const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === label) as
    | HTMLButtonElement
    | undefined

/** Set a controlled input's value the way React's onChange listener will observe. */
const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SuggestTagsForFileModal', () => {
  it('renders the file-tailored exposure warning and the Suggest topics button', () => {
    renderModal()
    expect(document.body.textContent).toContain('Suggesting topics sends this file')
    expect(document.body.textContent).toContain('never sent')
    expect(findButton('Suggest topics')).toBeDefined()
    // Nothing applied on mount.
    expect(findOrCreateTagMock).not.toHaveBeenCalled()
    expect(addTagToItemMock).not.toHaveBeenCalled()
  })

  it('generates suggestions as checkbox rows and applies ONLY on confirm', async () => {
    extractFileTextForTagsMock.mockResolvedValue({ text: 'quarterly figures', onlyMetadataAvailable: false })
    suggestTagsForFileMock.mockResolvedValue(['invoices', '2024'])
    renderModal()

    await act(async () => {
      findButton('Suggest topics')!.click()
    })

    // Checkbox rows rendered for each suggestion; nothing applied yet.
    const checkboxes = document.body.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes.length).toBe(2)
    expect(document.body.textContent).toContain('invoices')
    expect(document.body.textContent).toContain('2024')
    expect(document.body.textContent).toContain('(new tag)')
    expect(findOrCreateTagMock).not.toHaveBeenCalled()
    expect(addTagToItemMock).not.toHaveBeenCalled()

    // Confirm.
    await act(async () => {
      findButton('Add 2 topics')!.click()
    })

    expect(findOrCreateTagMock).toHaveBeenCalledTimes(2)
    expect(addTagToItemMock).toHaveBeenCalledTimes(2)
    // Linked to the FILE, without a per-tag sync.
    expect(addTagToItemMock.mock.calls[0][1]).toBe(file)
    expect(addTagToItemMock.mock.calls[0][2]).toBe(false)
    expect(syncMock).toHaveBeenCalledTimes(1)
  })

  it('marks a suggestion that matches an existing tag as existing (reuse, not new)', async () => {
    extractFileTextForTagsMock.mockResolvedValue({ text: '', onlyMetadataAvailable: true })
    suggestTagsForFileMock.mockResolvedValue(['Work'])
    renderModal(makeApp([{ title: 'Work' }]))

    await act(async () => {
      findButton('Suggest topics')!.click()
    })

    expect(document.body.textContent).toContain('(existing tag)')
    // Exposure copy reflects that only metadata was sent for this file.
    expect(document.body.textContent).toContain('only its name and type were sent')
  })

  it('lets the user add their own topic, applied only on confirm', async () => {
    renderModal()
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => {
      setInputValue(input, 'personal')
    })
    await act(async () => {
      findButton('Add')!.click()
    })
    expect(document.body.textContent).toContain('personal')
    // Still not applied until the primary confirm.
    expect(findOrCreateTagMock).not.toHaveBeenCalled()

    await act(async () => {
      findButton('Add 1 topic')!.click()
    })
    expect(findOrCreateTagMock).toHaveBeenCalledWith('personal')
    expect(addTagToItemMock).toHaveBeenCalledTimes(1)
  })
})

describe('FileViewWithoutProtection trigger', () => {
  it('mounts the "Suggest topics" trigger in the title bar (render-path guard)', () => {
    const app = makeApp()
    act(() => {
      root.render(withProviders(app, createElement(FileViewWithoutProtection, { application: app, file })))
    })
    // The RoundIconButton uses its label as aria-label.
    const trigger = document.body.querySelector('button[aria-label="Suggest topics"]')
    expect(trigger).toBeTruthy()
  })
})
