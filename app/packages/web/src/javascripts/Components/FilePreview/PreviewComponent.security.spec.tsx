/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { getBase64FromBlob } from '@/Utils'
import { FileItem } from '@standardnotes/snjs'
import { act, createElement, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import PreviewComponent from './PreviewComponent'

let mockObjectUrl = 'blob:secure-preview'

jest.mock('@/Utils', () => ({
  getBase64FromBlob: jest.fn(),
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('./ImagePreview', () => ({
  __esModule: true,
  default: () => 'image-preview',
}))
jest.mock('./TextPreview', () => ({
  __esModule: true,
  default: () => 'text-preview',
}))
jest.mock('./PdfPreview', () => ({
  __esModule: true,
  default: () => 'pdf-preview',
}))
jest.mock('../Button/Button', () => ({
  __esModule: true,
  default: ({ children, onClick }: { children: import('react').ReactNode; onClick: () => void }) => {
    const React = jest.requireActual<typeof import('react')>('react')
    return React.createElement('button', { onClick }, children)
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PreviewComponent native preview security', () => {
  let container: HTMLElement
  let root: Root
  let isRootMounted: boolean

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    isRootMounted = true
    mockObjectUrl = 'blob:secure-preview'
    URL.createObjectURL = jest.fn(() => mockObjectUrl)
    URL.revokeObjectURL = jest.fn()
  })

  afterEach(() => {
    if (isRootMounted) {
      act(() => root.unmount())
    }
    container.remove()
    jest.clearAllMocks()
  })

  it('does not export converted plaintext to the OS after authorization-driven unmount', async () => {
    let finishConversion!: (value: string) => void
    jest.mocked(getBase64FromBlob).mockReturnValue(
      new Promise<string>((resolve) => {
        finishConversion = resolve
      }),
    )
    const previewFile = jest.fn()
    const application = {
      isNativeMobileWeb: jest.fn().mockReturnValue(true),
      isAuthorizedToRenderItem: jest.fn().mockReturnValue(false),
      mobileDevice: { previewFile },
    } as unknown as WebApplication
    const file = {
      uuid: 'vault-pdf',
      mimeType: 'application/pdf',
      name: 'secret.pdf',
      key_system_identifier: 'vault-key-system',
    } as FileItem

    act(() => {
      root.render(
        createElement(PreviewComponent, {
          application,
          file,
          bytes: new Uint8Array([1, 2, 3]),
          isEmbeddedInSuper: false,
        }),
      )
    })
    const button = container.querySelector('button')
    expect(button).not.toBeNull()

    act(() => button?.click())
    act(() => root.unmount())
    isRootMounted = false
    finishConversion('sensitive-base64')
    await act(async () => Promise.resolve())

    expect(previewFile).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('rejects a completed native conversion for stale inputs', async () => {
    let finishConversion!: (value: string) => void
    jest.mocked(getBase64FromBlob).mockReturnValue(
      new Promise<string>((resolve) => {
        finishConversion = resolve
      }),
    )
    const previewFile = jest.fn()
    const application = {
      isNativeMobileWeb: jest.fn().mockReturnValue(true),
      isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
      mobileDevice: { previewFile },
    } as unknown as WebApplication
    const firstFile = {
      uuid: 'first-vault-pdf',
      mimeType: 'application/pdf',
      name: 'first-secret.pdf',
      key_system_identifier: 'vault-key-system',
    } as FileItem
    const secondFile = { ...firstFile, uuid: 'second-vault-pdf', name: 'second-secret.pdf' } as FileItem

    act(() => {
      root.render(
        createElement(PreviewComponent, {
          application,
          file: firstFile,
          bytes: new Uint8Array([1, 2, 3]),
          isEmbeddedInSuper: false,
        }),
      )
    })
    act(() => container.querySelector('button')?.click())

    act(() => {
      root.render(
        createElement(PreviewComponent, {
          application,
          file: secondFile,
          bytes: new Uint8Array([4, 5, 6]),
          isEmbeddedInSuper: false,
        }),
      )
    })

    finishConversion('stale-sensitive-base64')
    await act(async () => Promise.resolve())

    expect(previewFile).not.toHaveBeenCalled()
  })

  it('owns every object URL through StrictMode setup and cleanup', async () => {
    let sequence = 0
    jest.mocked(URL.createObjectURL).mockImplementation(() => `blob:strict-${++sequence}`)
    const application = {
      isNativeMobileWeb: jest.fn().mockReturnValue(false),
    } as unknown as WebApplication
    const file = {
      uuid: 'vault-image',
      mimeType: 'image/png',
      name: 'secret.png',
      key_system_identifier: 'vault-key-system',
    } as FileItem

    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(PreviewComponent, {
            application,
            file,
            bytes: new Uint8Array([1, 2, 3]),
            isEmbeddedInSuper: false,
          }),
        ),
      )
      await Promise.resolve()
    })

    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:strict-1')

    act(() => root.unmount())
    isRootMounted = false
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:strict-2')
  })

  it('releases the binary object URL when the same component switches to a non-object preview', async () => {
    const application = {
      isNativeMobileWeb: jest.fn().mockReturnValue(false),
    } as unknown as WebApplication
    const image = {
      uuid: 'binary-file',
      mimeType: 'image/png',
      name: 'secret.png',
    } as FileItem
    const textFile = {
      ...image,
      uuid: 'text-file',
      mimeType: 'text/plain',
      name: 'safe.txt',
    } as FileItem

    await act(async () => {
      root.render(
        createElement(PreviewComponent, {
          application,
          file: image,
          bytes: new Uint8Array([1, 2, 3]),
          isEmbeddedInSuper: false,
        }),
      )
      await Promise.resolve()
    })
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(
        createElement(PreviewComponent, {
          application,
          file: textFile,
          bytes: new Uint8Array([4, 5, 6]),
          isEmbeddedInSuper: false,
        }),
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('text-preview')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:secure-preview')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('gives an embedded PDF a definite bounded viewport', async () => {
    const application = {
      isNativeMobileWeb: jest.fn().mockReturnValue(false),
    } as unknown as WebApplication
    const file = {
      uuid: 'embedded-pdf',
      mimeType: 'application/pdf',
      name: 'embedded.pdf',
      remoteIdentifier: 'remote-pdf',
    } as FileItem

    await act(async () => {
      root.render(
        createElement(PreviewComponent, {
          application,
          file,
          bytes: new Uint8Array([37, 80, 68, 70]),
          isEmbeddedInSuper: true,
        }),
      )
      await Promise.resolve()
    })

    const viewport = container.querySelector('[data-embedded-pdf-viewport="true"]')
    expect(viewport?.className).toContain('h-[clamp(20rem,65vh,48rem)]')
    expect(viewport?.textContent).toContain('pdf-preview')
  })
})
