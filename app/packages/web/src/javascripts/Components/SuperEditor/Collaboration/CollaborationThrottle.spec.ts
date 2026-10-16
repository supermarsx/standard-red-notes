import { addToast } from '@standardnotes/toast'
import { showCollaborationThrottle } from './CollaborationThrottle'

jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: { Regular: 'regular' } }))

it('coalesces a burst across collaboration consumers and allows a later reminder', () => {
  jest.useFakeTimers().setSystemTime(100_000)
  showCollaborationThrottle()
  showCollaborationThrottle()
  expect(addToast).toHaveBeenCalledTimes(1)
  expect(addToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('temporarily throttled') }),
  )
  jest.advanceTimersByTime(30_000)
  showCollaborationThrottle()
  expect(addToast).toHaveBeenCalledTimes(2)
  jest.useRealTimers()
})
