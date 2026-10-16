/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { LexicalEditor } from 'lexical'
import { UPLOAD_AND_INSERT_FILE_COMMAND } from '../Commands'
import { pasteAsImage } from './clipboardActions'
import InsertImagesButton from './InsertImagesButton'
import type { ToolbarButtonProps } from './ToolbarButton'
import { MusicStaffBlock } from '../Blocks/MusicStaff'
import { LexicalIconNameToSvgMapping } from '@/Components/Icon/LexicalIcons'

jest.mock('./clipboardActions', () => ({ pasteAsImage: jest.fn(async () => undefined) }))
jest.mock('@/Hooks/useMediaQuery', () => ({
  ...jest.requireActual('@/Hooks/useMediaQuery'),
  useMediaQuery: () => false,
}))
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
}))
jest.mock('./ToolbarButton', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(function Button(
      { name, onSelect, children },
      ref,
    ) {
      return (
        <button ref={ref} aria-label={String(name)} onClick={onSelect}>
          {children}
        </button>
      )
    }),
  }
})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let element: HTMLElement
let root: Root
let editable: boolean
const dispatchCommand = jest.fn()
const fromUrl = jest.fn()
const editor = { isEditable: () => editable, dispatchCommand } as unknown as LexicalEditor
beforeEach(async () => {
  jest.clearAllMocks()
  editable = true
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
  await act(async () => root.render(<InsertImagesButton editor={editor} fromUrl={fromUrl} />))
})
afterEach(() => {
  act(() => root.unmount())
  element.remove()
})
async function open() {
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Insert image"]')!.click())
}
async function click(label: string) {
  await act(async () =>
    [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === label)!
      .click(),
  )
}

it('labels each image insertion option and reuses the URL and clipboard actions', async () => {
  await open()
  expect([...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    'From URL',
    'From file',
    'From clipboard',
  ])
  await click('From URL')
  expect(fromUrl).toHaveBeenCalledTimes(1)
  await open()
  await click('From clipboard')
  expect(pasteAsImage).toHaveBeenCalledWith(editor)
})

it('uploads only an image through the existing encrypted file command and rechecks editability', async () => {
  const input = element.querySelector<HTMLInputElement>('input[type="file"]')!
  expect(input.accept).toBe('image/*')
  const image = new File(['image'], 'photo.png', { type: 'image/png' })
  Object.defineProperty(input, 'files', { configurable: true, value: [image] })
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
  expect(dispatchCommand).toHaveBeenCalledWith(UPLOAD_AND_INSERT_FILE_COMMAND, image)
  dispatchCommand.mockClear()
  editable = false
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
  expect(dispatchCommand).not.toHaveBeenCalled()
  editable = true
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['text'], 'note.txt', { type: 'text/plain' })],
  })
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
  expect(dispatchCommand).not.toHaveBeenCalled()
})

it('does not insert URL or clipboard content after the editor becomes read-only', async () => {
  await open()
  editable = false
  await click('From clipboard')
  expect(pasteAsImage).not.toHaveBeenCalled()
})

it('closes its menu on Escape and returns focus to the ribbon control', async () => {
  await open()
  const menu = element.querySelector('menu')!
  act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(element.querySelector('menu')).toBeNull()
  expect(document.activeElement).toBe(element.querySelector('[aria-label="Insert image"]'))
})

it('uses a dedicated staff glyph rather than a document glyph for music insertion', () => {
  expect(MusicStaffBlock.iconName).toBe('music-staff')
  expect(LexicalIconNameToSvgMapping['music-staff']).toBeDefined()
})
