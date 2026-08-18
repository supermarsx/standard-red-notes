/** @jest-environment jsdom */

import { FileItem, SNNote } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import NoteAttachmentsList from './NoteAttachmentsList'

let mockLinks: {
  filesLinkedToItem: { item: FileItem }[]
  filesLinkingToItem: { item: FileItem }[]
}

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

  const render = () => {
    act(() => {
      root.render(
        createElement(NoteAttachmentsList, {
          note: {} as SNNote,
          filesController: { handleFileAction } as never,
        }),
      )
    })
  }

  it('stays fully collapsed by default and expands to one deduplicated table row', () => {
    render()

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
    expect(toggle).not.toBeNull()
    expect(container.querySelector('table')).toBeNull()

    act(() => toggle!.click())

    expect(toggle!.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.textContent).toContain('notes.txt')
    expect(container.textContent).toContain('Reference notes')
    expect(handleFileAction).not.toHaveBeenCalled()

    act(() => toggle!.click())
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')
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
    act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click())

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

  it('renders nothing when there are no attachments', () => {
    mockLinks = { filesLinkedToItem: [], filesLinkingToItem: [] }
    render()
    expect(container.querySelector('[aria-label="Attachments"]')).toBeNull()
  })
})
