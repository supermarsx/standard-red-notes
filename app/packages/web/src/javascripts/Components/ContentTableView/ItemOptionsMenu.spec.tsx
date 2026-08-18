/** @jest-environment jsdom */

import { FileItem } from '@standardnotes/snjs'
import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import ItemOptionsMenu from './ItemOptionsMenu'

const mockFullFileActionModel = jest.fn()
const mockMutationAction = jest.fn()

jest.mock('../Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
}))
jest.mock('../Menu/Menu', () => ({
  __esModule: true,
  default: ({ children, a11yLabel }: { children: ReactNode; a11yLabel: string }) =>
    createElement('menu', { 'aria-label': a11yLabel }, children),
}))
jest.mock('../Menu/MenuSection', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))
jest.mock('../Menu/MenuItem', () => ({
  __esModule: true,
  default: ({ children, onClick }: { children: ReactNode; onClick: () => void }) =>
    createElement('button', { type: 'button', role: 'menuitem', onClick }, children),
}))
jest.mock('../FileContextMenu/FileMenuOptions', () => ({
  __esModule: true,
  default: () => {
    mockFullFileActionModel()
    return createElement(
      'div',
      null,
      createElement('button', { onClick: mockMutationAction }, 'Detach'),
      createElement('button', { onClick: mockMutationAction }, 'Rename'),
      createElement('button', { onClick: mockMutationAction }, 'Delete permanently'),
    )
  },
}))
jest.mock('../NotesOptions/NotesOptions', () => ({ __esModule: true, default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeFile = (): FileItem => {
  const file = Object.create(FileItem.prototype) as FileItem
  Object.defineProperties(file, {
    uuid: { value: 'readonly-file' },
    name: { value: 'readonly.pdf' },
  })
  return file
}

describe('ItemOptionsMenu readonly file action model', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    jest.clearAllMocks()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders and invokes only preview/download without constructing mutation actions', () => {
    const file = makeFile()
    const previewFile = jest.fn()
    const downloadFile = jest.fn()
    const closeMenu = jest.fn()

    act(() => {
      root.render(
        <ItemOptionsMenu
          items={[file]}
          open={true}
          anchorPoint={{ x: 1, y: 2 }}
          closeMenu={closeMenu}
          readonlyFileActions={{ previewFile, downloadFile }}
        />,
      )
    })

    expect(mockFullFileActionModel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Preview')
    expect(container.textContent).toContain('Download')
    expect(container.textContent).not.toContain('Detach')
    expect(container.textContent).not.toContain('Rename')
    expect(container.textContent).not.toContain('Delete')

    const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    act(() => menuItems.find((item) => item.textContent === 'Preview')!.click())
    act(() => menuItems.find((item) => item.textContent === 'Download')!.click())

    expect(previewFile).toHaveBeenCalledWith(file)
    expect(downloadFile).toHaveBeenCalledWith(file)
    expect(closeMenu).toHaveBeenCalledTimes(2)
    expect(mockMutationAction).not.toHaveBeenCalled()
  })
})
