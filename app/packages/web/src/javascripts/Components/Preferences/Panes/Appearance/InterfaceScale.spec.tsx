/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import ApplicationProvider from '@/Components/ApplicationProvider'
import InterfaceScale from './InterfaceScale'
import { normalizeUiScale, UI_SCALE_KEY, useUiScale } from '@/View/uiScale'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let element: HTMLElement, root: Root, value: number
const observers = new Set<() => Promise<void>>()
const app = {
  getPreference: (_key: unknown, fallback: unknown) => value ?? fallback,
  addEventObserver: (callback: () => Promise<void>) => {
    observers.add(callback)
    return () => observers.delete(callback)
  },
  setPreference: jest.fn(async (_key: unknown, next: number) => {
    value = next
    await Promise.all([...observers].map((observer) => observer()))
  }),
} as never
function Screen() {
  useUiScale(app)
  return (
    <ApplicationProvider application={app}>
      <InterfaceScale />
      <div role="dialog">Dialog content</div>
    </ApplicationProvider>
  )
}
beforeEach(() => {
  ;(app as unknown as { setPreference: jest.Mock }).setPreference.mockImplementation(
    async (_key: unknown, next: number) => {
      value = next
      await Promise.all([...observers].map((observer) => observer()))
    },
  )
  value = 100
  observers.clear()
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  element.remove()
  document.documentElement.style.fontSize = ''
})

it('applies, saves and restores a global scale through the actual preset and reset controls', async () => {
  await act(async () => root.render(<Screen />))
  await act(async () =>
    [...element.querySelectorAll('button')].find((button) => button.textContent === '125%')!.click(),
  )
  expect(document.documentElement.style.fontSize).toBe('125%')
  expect((app as unknown as { setPreference: jest.Mock }).setPreference).toHaveBeenCalledWith(UI_SCALE_KEY, 125)
  await act(async () => root.render(null))
  expect(document.documentElement.style.fontSize).toBe('')
  await act(async () => root.render(<Screen />))
  expect(document.documentElement.style.fontSize).toBe('125%')
  await act(async () =>
    [...element.querySelectorAll('button')].find((button) => button.textContent === 'Reset to 100%')!.click(),
  )
  expect(document.documentElement.style.fontSize).toBe('100%')
})

it('previews slider input immediately and persists at the end of the gesture', async () => {
  await act(async () => root.render(<Screen />))
  const save = (app as unknown as { setPreference: jest.Mock }).setPreference
  save.mockClear()
  const input = element.querySelector<HTMLInputElement>('input[type="range"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '90')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.documentElement.style.fontSize).toBe('90%')
  expect(save).not.toHaveBeenCalled()
  await act(async () => input.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))
  expect(save).toHaveBeenCalledWith(UI_SCALE_KEY, 90)
  expect(normalizeUiScale(500)).toBe(150)
  expect(normalizeUiScale(Number.NaN)).toBe(100)
})
