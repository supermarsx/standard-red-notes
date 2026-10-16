import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantInternetAccessSetting from './AssistantInternetAccessSetting'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})
it('shows the actual server policy, saves a boolean, and offers an explicit reset', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const onChange = jest.fn()
  const onReset = jest.fn()
  act(() =>
    root.render(<AssistantInternetAccessSetting enabled={false} busy={false} onChange={onChange} onReset={onReset} />),
  )
  const checkbox = host.querySelector('input')!
  expect(checkbox.checked).toBe(false)
  act(() => checkbox.click())
  expect(onChange).toHaveBeenCalledWith(true)
  act(() => host.querySelector('button')!.click())
  expect(onReset).toHaveBeenCalledTimes(1)
  act(() =>
    root.render(
      <AssistantInternetAccessSetting enabled={undefined} busy={false} onChange={onChange} onReset={onReset} />,
    ),
  )
  expect(host.querySelector('input')).toBeNull()
  expect(host.textContent).toContain('not reported')
  act(() => root.unmount())
})
