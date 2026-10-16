/** @jest-environment jsdom */
import { acquireAssistantChatRun } from './assistantChatRunLease'
import { WebApplication } from '@/Application/WebApplication'
beforeEach(() => jest.useFakeTimers({ now: 100000 }))
afterEach(() => jest.useRealTimers())
function app() {
  const request = jest.fn()
  return {
    request,
    application: {
      sessions: { getUser: () => ({ uuid: 'account' }) },
      serverJsonRequest: request,
    } as unknown as WebApplication,
  }
}
it('refuses a second device without fabricating ownership', async () => {
  const h = app()
  h.request.mockResolvedValue({ ok: true, data: { acquired: false, retryAfterMs: 30000 } })
  await expect(acquireAssistantChatRun(h.application, 'chat', new AbortController())).rejects.toThrow('another device')
})
it('renews through the socket-aware helper and releases its exact fenced proof', async () => {
  const h = app()
  h.request
    .mockResolvedValueOnce({ ok: true, data: { acquired: true, leaseId: 'lease', fence: 2, expiresAt: 130000 } })
    .mockResolvedValueOnce({ ok: true, data: { renewed: true, expiresAt: 140000 } })
    .mockResolvedValue({ ok: true, data: { released: true } })
  const controller = new AbortController()
  const guard = await acquireAssistantChatRun(h.application, 'chat', controller)
  await jest.advanceTimersByTimeAsync(10000)
  expect(guard.isCurrent()).toBe(true)
  expect(h.request.mock.calls[1][0]).toContain('/renew')
  expect(h.request.mock.calls[1][1]).toEqual(guard.proof)
  await guard.release()
  expect(h.request.mock.calls.at(-1)[0]).toContain('/release')
  expect(guard.isCurrent()).toBe(false)
})
it('aborts a suspended/hung renewal at lease expiry, never extending locally', async () => {
  const h = app()
  h.request
    .mockResolvedValueOnce({ ok: true, data: { acquired: true, leaseId: 'lease', fence: 1, expiresAt: 130000 } })
    .mockImplementation(() => new Promise(() => undefined))
  const controller = new AbortController()
  const guard = await acquireAssistantChatRun(h.application, 'chat', controller)
  await jest.advanceTimersByTimeAsync(29500)
  expect(controller.signal.aborted).toBe(true)
  expect(guard.isCurrent()).toBe(false)
})
it('fails closed when server renewal refuses ownership', async () => {
  const h = app()
  h.request
    .mockResolvedValueOnce({ ok: true, data: { acquired: true, leaseId: 'lease', fence: 1, expiresAt: 130000 } })
    .mockResolvedValue({ ok: true, data: { renewed: false } })
  const controller = new AbortController()
  await acquireAssistantChatRun(h.application, 'chat', controller)
  await jest.advanceTimersByTimeAsync(10000)
  expect(controller.signal.aborted).toBe(true)
})
