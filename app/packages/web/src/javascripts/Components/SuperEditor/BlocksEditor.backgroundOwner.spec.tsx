/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { BlocksEditorComposer } from './BlocksEditorComposer'
import { BlocksEditor } from './BlocksEditor'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm' },
}))
jest.mock('./Plugins/CheckListPlugin', () => ({ CheckListPlugin: () => null }))
jest.mock('./Plugins/SearchPlugin/SearchPlugin', () => ({ SearchPlugin: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('background BlocksEditor owner', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('mounts no contenteditable surface and cannot steal focus', async () => {
    const focusTarget = document.createElement('button')
    document.body.append(focusTarget)
    focusTarget.focus()
    const onFocus = jest.fn()

    await act(async () => {
      root.render(
        <BlocksEditorComposer initialValue={undefined}>
          <BlocksEditor backgroundOwner onFocus={onFocus} />
        </BlocksEditorComposer>,
      )
      await Promise.resolve()
    })

    expect(container.querySelector('[contenteditable="true"]')).toBeNull()
    expect(container.querySelector('#blocks-editor')).toBeNull()
    expect(document.activeElement).toBe(focusTarget)
    expect(onFocus).not.toHaveBeenCalled()
    focusTarget.remove()
  })
})
