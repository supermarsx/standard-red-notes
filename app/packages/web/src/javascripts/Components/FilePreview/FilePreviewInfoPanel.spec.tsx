/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { FileItem } from '@standardnotes/snjs'
import FilePreviewInfoPanel from './FilePreviewInfoPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('@standardnotes/filepicker', () => ({ formatSizeToReadableString: (size: number) => `${size} bytes` }))
jest.mock('@/Components/Icon/Icon', () => () => null)
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const createFile = (description?: string) =>
  ({
    uuid: 'file-1',
    mimeType: 'text/plain',
    decryptedSize: 12,
    encryptedSize: 24,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    userModifiedDate: new Date('2026-01-02T00:00:00.000Z'),
    description,
  }) as FileItem

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FilePreviewInfoPanel description', () => {
  it('renders the optional description as inert, whitespace-preserving text', () => {
    const description = 'First line\n<img src=x onerror=alert(1)>'

    act(() => root.render(createElement(FilePreviewInfoPanel, { file: createFile(description) })))

    const paragraph = container.querySelector('p')
    expect(paragraph?.textContent).toBe(description)
    expect(paragraph?.className).toContain('whitespace-pre-wrap')
    expect(container.querySelector('img')).toBeNull()
  })

  it('omits the description row for legacy files without the optional field', () => {
    act(() => root.render(createElement(FilePreviewInfoPanel, { file: createFile() })))

    expect(container.textContent).not.toContain('fileDescription')
  })
})
