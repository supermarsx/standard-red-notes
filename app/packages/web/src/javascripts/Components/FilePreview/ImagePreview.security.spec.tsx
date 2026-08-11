/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import ImagePreview from './ImagePreview'

jest.mock('@/Hooks/usePreference', () => ({
  __esModule: true,
  default: () => 'left',
}))
jest.mock('./ZoomableImage', () => ({
  __esModule: true,
  default: 'div',
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ImagePreview security cleanup', () => {
  it('detaches the image loader and source on unmount', () => {
    const originalImage = globalThis.Image
    const image = {
      src: '',
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      width: 1,
      height: 1,
    }
    const ControlledImage = jest.fn(() => image)
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: ControlledImage })
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(createElement(ImagePreview, { objectUrl: 'blob:secret-image', isEmbeddedInSuper: false }))
    })
    expect(image.src).toBe('blob:secret-image')

    act(() => root.unmount())

    expect(image.onload).toBeNull()
    expect(image.onerror).toBeNull()
    expect(image.src).toBe('')
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: originalImage })
  })
})
