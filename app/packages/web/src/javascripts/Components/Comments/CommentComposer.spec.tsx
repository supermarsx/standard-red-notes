/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorControlsProvider } from '@/Components/SuperEditor/EditorControlsContext'
import CommentComposer from './CommentComposer'

jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('uses the shared-comment default until overridden and submits the same choice by keyboard or button', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const identity = {}
  const onSubmit = jest.fn()
  const render = (notify: boolean, shared = true) =>
    root.render(
      <EditorControlsProvider identity={identity}>
        <CommentComposer candidates={[]} showNotifyOthers={shared} defaultNotifyOthers={notify} onSubmit={onSubmit} />
      </EditorControlsProvider>,
    )
  const type = async () =>
    act(async () => {
      const textarea = container.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  await act(async () => render(false))
  expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(false)
  await act(async () => render(true))
  expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(true)
  await type()
  await act(async () =>
    container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  expect(onSubmit).toHaveBeenLastCalledWith('Hello', true)
  await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click())
  await act(async () => render(true))
  await type()
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(onSubmit).toHaveBeenLastCalledWith('Hello', false)
  await act(async () => render(true, false))
  expect(container.querySelector('[type="checkbox"]')).toBeNull()
  await type()
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(onSubmit).toHaveBeenLastCalledWith('Hello', false)
  await act(async () => root.unmount())
  container.remove()
})
