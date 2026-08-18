/** @jest-environment jsdom */

import { FileItem, SNNote } from '@standardnotes/snjs'
import { act, ButtonHTMLAttributes, createElement, ForwardedRef, forwardRef, Fragment, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import NoteAttachmentsList from './NoteAttachmentsList'

let mockLinks: {
  filesLinkedToItem: { item: FileItem }[]
  filesLinkingToItem: { item: FileItem }[]
}
let mockEllipsisItems: FileItem[] = []
let mockEllipsisIsAttached = false
let mockRowMenuItems: FileItem[] = []
type ReadonlyFileActions = {
  previewFile: (file: FileItem) => void
  downloadFile: (file: FileItem) => void
}
let mockEllipsisReadonlyActions: ReadonlyFileActions | undefined
let mockRowMenuReadonlyActions: ReadonlyFileActions | undefined

jest.mock('@/Hooks/useItemLinks', () => ({
  useItemLinks: () => mockLinks,
}))
jest.mock('../FilePreview/getFileIconComponent', () => ({
  getFileIconComponent: () => createElement('span', { 'data-file-icon': true }),
}))
jest.mock('../Icon/Icon', () => ({
  __esModule: true,
  default: ({ type }: { type: string }) => createElement('span', { 'data-icon': type }),
}))
jest.mock('@standardnotes/filepicker', () => ({
  formatSizeToReadableString: (size: number) => `${size} bytes`,
}))
jest.mock('../Button/RoundIconButton', () => ({
  __esModule: true,
  default: forwardRef(
    (
      {
        label,
        icon: _icon,
        iconClassName: _iconClassName,
        ...props
      }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: string; iconClassName?: string },
      ref: ForwardedRef<HTMLButtonElement>,
    ) => createElement('button', { ...props, ref, 'aria-label': label }, label),
  ),
}))
jest.mock('../Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
}))
jest.mock('../ContentTableView/ContentTableView', () => ({
  ContextMenuCell: ({
    items,
    isFileAttachedToNote,
    readonlyFileActions,
  }: {
    items: FileItem[]
    isFileAttachedToNote?: boolean
    readonlyFileActions?: ReadonlyFileActions
  }) => {
    mockEllipsisItems = items
    mockEllipsisIsAttached = !!isFileAttachedToNote
    mockEllipsisReadonlyActions = readonlyFileActions
    return createElement('button', { type: 'button', 'aria-label': `File options for ${items[0].name}` })
  },
}))
jest.mock('../ContentTableView/ItemOptionsMenu', () => ({
  __esModule: true,
  default: ({
    open,
    items,
    closeMenu,
    readonlyFileActions,
  }: {
    open: boolean
    items: FileItem[]
    closeMenu: () => void
    readonlyFileActions?: ReadonlyFileActions
  }) => {
    mockRowMenuItems = items
    mockRowMenuReadonlyActions = readonlyFileActions
    return open
      ? createElement(
          'div',
          { 'data-row-context-menu': items[0].uuid },
          readonlyFileActions
            ? createElement(
                Fragment,
                null,
                createElement(
                  'button',
                  {
                    onClick: () => {
                      readonlyFileActions.previewFile(items[0])
                      closeMenu()
                    },
                  },
                  'Preview',
                ),
                createElement(
                  'button',
                  {
                    onClick: () => {
                      readonlyFileActions.downloadFile(items[0])
                      closeMenu()
                    },
                  },
                  'Download',
                ),
              )
            : createElement(Fragment, null, 'Detach Rename Delete'),
          createElement('button', { onClick: closeMenu }, 'Close row menu'),
        )
      : null
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeFile = (uuid: string, name: string): FileItem => {
  const file = Object.create(FileItem.prototype) as FileItem
  Object.defineProperties(file, {
    uuid: { value: uuid },
    name: { value: name },
    description: { value: 'Reference notes' },
    mimeType: { value: 'text/plain' },
    decryptedSize: { value: 128 },
  })
  return file
}

describe('NoteAttachmentsList', () => {
  let container: HTMLElement
  let root: Root
  let handleFileAction: jest.Mock

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    handleFileAction = jest.fn()
    mockEllipsisItems = []
    mockEllipsisIsAttached = false
    mockRowMenuItems = []
    mockEllipsisReadonlyActions = undefined
    mockRowMenuReadonlyActions = undefined
    const file = makeFile('file-1', 'notes.txt')
    mockLinks = {
      filesLinkedToItem: [{ item: file }],
      filesLinkingToItem: [{ item: file }],
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  const render = (readonly = false) => {
    act(() => {
      root.render(
        createElement(NoteAttachmentsList, {
          note: {} as SNNote,
          filesController: { handleFileAction } as never,
          readonly,
        }),
      )
    })
  }

  it('stays closed by default and opens one deduplicated toolbar table without starting I/O', () => {
    render()

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')
    expect(toggle).not.toBeNull()
    expect(container.querySelector('table')).toBeNull()

    act(() => toggle!.click())

    expect(toggle!.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.textContent).toContain('notes.txt')
    expect(container.textContent).toContain('Reference notes')
    expect(handleFileAction).not.toHaveBeenCalled()
    expect(mockEllipsisItems).toEqual([mockLinks.filesLinkedToItem[0].item])
    expect(mockEllipsisIsAttached).toBe(true)

    act(() => toggle!.click())
    expect(toggle!.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('table')).toBeNull()
  })

  it('uses unique controlled-table ids across multiple attachment rails', () => {
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          createElement(NoteAttachmentsList, {
            key: 'first',
            note: {} as SNNote,
            filesController: { handleFileAction } as never,
          }),
          createElement(NoteAttachmentsList, {
            key: 'second',
            note: {} as SNNote,
            filesController: { handleFileAction } as never,
          }),
        ),
      )
    })

    const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-controls]'))
    expect(toggles).toHaveLength(2)
    const controlledIds = toggles.map((toggle) => toggle.getAttribute('aria-controls'))
    expect(new Set(controlledIds).size).toBe(2)

    act(() => toggles.forEach((toggle) => toggle.click()))
    for (const controlledId of controlledIds) {
      expect(controlledId).not.toBeNull()
      expect(container.contains(document.getElementById(controlledId!))).toBe(true)
    }
  })

  it('only starts preview or download after an explicit row action', () => {
    render()
    act(() => container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click())

    act(() => container.querySelector<HTMLButtonElement>('button[title="Preview notes.txt"]')!.click())
    expect(handleFileAction).toHaveBeenLastCalledWith({
      type: FileItemActionType.PreviewFile,
      payload: { file: mockLinks.filesLinkedToItem[0].item, otherFiles: [mockLinks.filesLinkedToItem[0].item] },
    })

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Download notes.txt"]')!.click())
    expect(handleFileAction).toHaveBeenLastCalledWith({
      type: FileItemActionType.DownloadFile,
      payload: { file: mockLinks.filesLinkedToItem[0].item },
    })
  })

  it.each([
    ['right-click', () => new MouseEvent('contextmenu', { bubbles: true, cancelable: true })],
    ['Shift+F10', () => new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })],
    ['ContextMenu key', () => new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })],
  ])('opens the same row action model from %s without previewing', (_label, makeEvent) => {
    render()
    act(() => container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click())
    const row = container.querySelector('tbody tr') as HTMLTableRowElement

    act(() => row.dispatchEvent(makeEvent()))

    expect(container.querySelector('[data-row-context-menu="file-1"]')).not.toBeNull()
    expect(mockRowMenuItems).toEqual(mockEllipsisItems)
    expect(handleFileAction).not.toHaveBeenCalled()
  })

  it('returns focus to the row when its context menu closes', () => {
    render()
    act(() => container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click())
    const row = container.querySelector('tbody tr') as HTMLTableRowElement
    act(() => row.focus())
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })))

    act(() => container.querySelector<HTMLButtonElement>('[data-row-context-menu] button')!.click())

    expect(document.activeElement).toBe(row)
    expect(container.querySelector('[data-row-context-menu]')).toBeNull()
  })

  it('uses only preview/download action callbacks for readonly attachments', () => {
    render(true)
    act(() => container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click())

    expect(mockEllipsisIsAttached).toBe(false)
    expect(mockEllipsisReadonlyActions).toBeDefined()

    const row = container.querySelector('tbody tr') as HTMLTableRowElement
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })))

    expect(mockRowMenuReadonlyActions).toBeDefined()
    expect(container.textContent).toContain('Preview')
    expect(container.textContent).toContain('Download')
    expect(container.textContent).not.toContain('Detach')
    expect(container.textContent).not.toContain('Rename')
    expect(container.textContent).not.toContain('Delete')

    act(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-row-context-menu] button'))
        .find((button) => button.textContent === 'Preview')!
        .click(),
    )
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })))
    act(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-row-context-menu] button'))
        .find((button) => button.textContent === 'Download')!
        .click(),
    )

    expect(handleFileAction.mock.calls.map(([action]) => action.type)).toEqual([
      FileItemActionType.PreviewFile,
      FileItemActionType.DownloadFile,
    ])
  })

  it('clears an open row menu on header close and does not resurrect it after reopening', () => {
    render()
    const toolbarButton = container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!
    act(() => toolbarButton.click())
    const row = container.querySelector('tbody tr') as HTMLTableRowElement
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })))
    expect(container.querySelector('[data-row-context-menu]')).not.toBeNull()

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close attachments"]')!.click())
    expect(container.querySelector('table')).toBeNull()
    expect(document.activeElement).toBe(toolbarButton)

    act(() => toolbarButton.click())
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('[data-row-context-menu]')).toBeNull()
  })

  it('renders nothing when there are no attachments', () => {
    mockLinks = { filesLinkedToItem: [], filesLinkingToItem: [] }
    render()
    expect(container.querySelector('[aria-label="Attachments"]')).toBeNull()
  })
})
