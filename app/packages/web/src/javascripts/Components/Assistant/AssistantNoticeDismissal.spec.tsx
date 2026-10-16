/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantNoticeDismissal } from './AssistantNoticeDismissal'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm' },
}))
jest.mock('@/Hooks/useSafeAreaPadding', () => ({ useAvailableSafeAreaPadding: () => ({}) }))
jest.mock('../Modal/useModalAnimation', () => ({ useModalAnimation: () => [true, () => {}] }))
jest.mock('../Modal/ModalAndroidBackHandler', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function mount() {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const onSelect = jest.fn()
  const onClose = jest.fn()
  await act(async () => root.render(<AssistantNoticeDismissal onSelect={onSelect} onClose={onClose} />))
  return {
    onSelect,
    onClose,
    close: async () => {
      await act(async () => root.unmount())
      element.remove()
    },
  }
}

it.each([
  ['Just this time', 'once'],
  ['Remind me in 15 days', '15-days'],
  ['Don’t remind me again', 'never'],
] as const)('selects %s explicitly and closes the themed dialog', async (label, mode) => {
  const view = await mount()
  try {
    const dialog = document.querySelector('[role="dialog"][aria-label="Hide AI privacy reminder"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    const button = [...dialog!.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
    await act(async () => button.click())
    expect(view.onSelect).toHaveBeenCalledTimes(1)
    expect(view.onSelect).toHaveBeenCalledWith(mode)
    expect(view.onClose).toHaveBeenCalledTimes(1)
  } finally {
    await view.close()
  }
})

it('cancels without selecting or changing a reminder policy', async () => {
  const view = await mount()
  try {
    const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
    await act(async () => cancel.click())
    expect(view.onSelect).not.toHaveBeenCalled()
    expect(view.onClose).toHaveBeenCalledTimes(1)
  } finally {
    await view.close()
  }
})
