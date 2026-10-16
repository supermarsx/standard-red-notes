import { assistantJsonHttpError, assistantNetworkError, assistantStreamError } from './AssistantHttpError'

it('formats decoded socket errors with the same bounded structured details and status guidance', () => {
  const message = assistantJsonHttpError(429, { error: { message: '  quota\nreached  ' } }, 'proxy')
  expect(message).toContain('Assistant server proxy returned HTTP 429.')
  expect(message).toContain('Provider message: quota reached')
  expect(assistantJsonHttpError(403, '<html>credentials</html>', 'proxy')).not.toContain('credentials')
  expect(
    assistantJsonHttpError(500, { message: 'a'.repeat(500) }, 'proxy').split('Provider message: ')[1],
  ).toHaveLength(240)
})

it('recognizes ownership loss and transport time limits without leaking raw transport text', () => {
  const controller = new AbortController()
  controller.abort(Object.assign(new Error('private internal diagnostic'), { code: 'CHAT_RUN_LEASE_LOST' }))
  expect(assistantStreamError(controller.signal.reason, 'proxy', controller.signal)).toContain('lost run ownership')
  expect(assistantNetworkError(controller.signal.reason, 'proxy', controller.signal)).not.toContain('private')
  expect(assistantNetworkError({ code: 'DEADLINE_EXCEEDED' }, 'proxy')).toContain('reached its time limit')
  expect(assistantStreamError({ code: 'SESSION_STALE' }, 'proxy')).toContain('session needs to be renewed')
})

it('keeps typed timeout and session causes when carried by an aborted signal', () => {
  for (const [code, expected] of [
    ['DEADLINE_EXCEEDED', 'time limit'],
    ['SESSION_REVOKED', 'session needs to be renewed'],
  ]) {
    const controller = new AbortController()
    controller.abort(Object.assign(new Error('hidden transport detail'), { code }))
    expect(assistantStreamError(controller.signal.reason, 'proxy', controller.signal)).toContain(expected)
  }
})
