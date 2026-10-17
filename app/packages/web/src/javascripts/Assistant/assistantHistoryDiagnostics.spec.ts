import { AssistantChatStorageError } from './assistantSyncedChats'
import {
  reportAssistantHistoryFailure,
  reportAssistantHistoryRecovery,
  readAssistantHistoryDiagnostics,
  subscribeAssistantHistoryDiagnostics,
} from './assistantHistoryDiagnostics'

describe('Assistant history diagnostic ledger', () => {
  let warning: jest.SpyInstance
  let recovery: jest.SpyInstance
  beforeEach(() => {
    warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    recovery = jest.spyOn(console, 'info').mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())
  it('deduplicates closed logs and never exports scope, source or arbitrary exception content', () => {
    const owner = {},
      source = {},
      scope = 'private-account-id'
    const error = new Error('SECRET chat text and https://credentials.example')
    reportAssistantHistoryFailure(owner, scope, error, source)
    reportAssistantHistoryFailure(owner, scope, error, source)
    expect(warning).toHaveBeenCalledTimes(1)
    const snapshot = readAssistantHistoryDiagnostics(owner, scope)
    expect(snapshot).toEqual({
      failures: 2,
      recoveries: 0,
      active: true,
      latest: { code: 'UNKNOWN_FAILURE', stage: 'checkpoint', cause: 'unknown' },
    })
    expect(JSON.stringify([snapshot, warning.mock.calls])).not.toMatch(/SECRET|private-account-id|credentials/)
    reportAssistantHistoryRecovery(owner, scope, source)
    expect(recovery).toHaveBeenCalledTimes(1)
    reportAssistantHistoryFailure(owner, scope, error, source)
    expect(warning).toHaveBeenCalledTimes(2)
  })
  it('a successful different chat cannot clear unresolved failures, and scopes/applications stay separate', () => {
    const owner = {},
      first = {},
      second = {}
    reportAssistantHistoryFailure(owner, 'account-a', new AssistantChatStorageError('QUOTA_EXCEEDED', 'write'), first)
    reportAssistantHistoryRecovery(owner, 'account-a', second)
    expect(readAssistantHistoryDiagnostics(owner, 'account-a').active).toBe(true)
    expect(readAssistantHistoryDiagnostics(owner, 'account-b').failures).toBe(0)
    expect(readAssistantHistoryDiagnostics({}, 'account-a').failures).toBe(0)
    reportAssistantHistoryRecovery(owner, 'account-a', first)
    expect(readAssistantHistoryDiagnostics(owner, 'account-a')).toMatchObject({ active: false, recoveries: 1 })
  })
  it('retains the latest unresolved reason after another chat recovers', () => {
    const owner = {}
    reportAssistantHistoryFailure(owner, 'a', new AssistantChatStorageError('QUOTA_EXCEEDED', 'write'), 'view-chat-a')
    reportAssistantHistoryFailure(owner, 'a', new AssistantChatStorageError('READ_ONLY', 'access'), 'view-chat-b')
    reportAssistantHistoryRecovery(owner, 'a', 'view-chat-b')
    expect(readAssistantHistoryDiagnostics(owner, 'a')).toMatchObject({
      active: true,
      latest: { code: 'QUOTA_EXCEEDED' },
    })
    reportAssistantHistoryRecovery(owner, 'a', 'view-chat-a')
    expect(readAssistantHistoryDiagnostics(owner, 'a').active).toBe(false)
  })
  it('notifies subscribers safely and returns detached snapshots', () => {
    const owner = {},
      source = {},
      listener = jest.fn()
    const unsubscribe = subscribeAssistantHistoryDiagnostics(owner, listener)
    subscribeAssistantHistoryDiagnostics(owner, () => {
      throw new Error('observer failure')
    })
    reportAssistantHistoryFailure(owner, 'a', new AssistantChatStorageError('WRITE_FAILED', 'write'), source)
    const snapshot = readAssistantHistoryDiagnostics(owner, 'a')
    snapshot.latest!.code = 'QUOTA_EXCEEDED'
    expect(readAssistantHistoryDiagnostics(owner, 'a').latest?.code).toBe('WRITE_FAILED')
    unsubscribe()
    reportAssistantHistoryRecovery(owner, 'a', source)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
