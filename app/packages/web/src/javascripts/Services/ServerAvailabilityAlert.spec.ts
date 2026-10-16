import { addToast } from '@standardnotes/toast'
import { ServerAvailabilityAlert, fetchWithServerAvailability } from './ServerAvailabilityAlert'
import { showCollaborationThrottle } from '@/Components/SuperEditor/Collaboration/CollaborationThrottle'
jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: { Error: 'error', Regular: 'regular' } }))

it('shows a bounded 502 outage toast once across concurrent requests, then allows a reminder', () => {
  let now = 0
  const alert = new ServerAvailabilityAlert(() => now)
  alert.observeStatus(200)
  alert.observeStatus(403)
  expect(addToast).not.toHaveBeenCalled()
  for (let i = 0; i < 10; i++) alert.observeStatus(502)
  expect(addToast).toHaveBeenCalledTimes(1)
  expect(addToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: expect.stringContaining('may be offline or restarting') }),
  )
  now = 30_000
  alert.observeStatus(502)
  expect(addToast).toHaveBeenCalledTimes(2)
})
it('retains the original fetch response and does not turn network exceptions into a 502', async () => {
  const original = globalThis.fetch
  const observeStatus = jest.fn()
  const response = { status: 502 } as Response
  try {
    globalThis.fetch = jest.fn().mockResolvedValue(response)
    await expect(
      fetchWithServerAvailability({ observeStatus } as unknown as ServerAvailabilityAlert, '/v1/test'),
    ).resolves.toBe(response)
    expect(observeStatus).toHaveBeenCalledWith(502)
    const failure = new Error('Network failed')
    globalThis.fetch = jest.fn().mockRejectedValue(failure)
    await expect(fetchWithServerAvailability(undefined, '/v1/test')).rejects.toBe(failure)
  } finally {
    globalThis.fetch = original
  }
})

it('coalesces rate-limit notices with collaboration notices without calling throttling a block', () => {
  jest.mocked(addToast).mockClear()
  const alert = new ServerAvailabilityAlert()
  alert.observeStatus(429)
  alert.observeStatus(429)
  showCollaborationThrottle()
  expect(addToast).toHaveBeenCalledTimes(1)
  expect(addToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: expect.stringContaining('temporarily rate-limited') }),
  )
})
