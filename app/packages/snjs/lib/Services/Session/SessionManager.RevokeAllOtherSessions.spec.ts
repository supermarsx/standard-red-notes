import { SessionListEntry } from '@standardnotes/responses'

import { SessionManager } from './SessionManager'

describe('SessionManager.revokeAllOtherSessions', () => {
  let apiService: {
    setInvalidSessionObserver: jest.Mock
    getSessionsList: jest.Mock
    deleteSession: jest.Mock
  }

  const session = (uuid: string, current = false, updatedAt = '2026-07-30T12:00:00.000Z'): SessionListEntry => ({
    uuid,
    current,
    api_version: '004',
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: updatedAt,
    device_info: `${uuid} device`,
  })

  const success = (sessions: SessionListEntry[]) => ({
    status: 200,
    data: sessions,
  })

  const failure = (message: string) => ({
    status: 500,
    data: {
      error: {
        message,
      },
    },
  })

  const createSessionManager = () =>
    new SessionManager(
      {} as never,
      apiService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      '',
      {} as never,
      {} as never,
      {} as never,
    )

  beforeEach(() => {
    apiService = {
      setInvalidSessionObserver: jest.fn(),
      getSessionsList: jest.fn(),
      deleteSession: jest.fn(),
    }
  })

  it('checks every successful revocation and returns the final confirmed server session list', async () => {
    const current = session('current', true)
    const otherA = session('other-a', false, '2026-07-30T11:00:00.000Z')
    const otherB = session('other-b', false, '2026-07-30T10:00:00.000Z')
    apiService.getSessionsList.mockResolvedValue(success([current, otherA, otherB]))
    apiService.deleteSession.mockResolvedValueOnce(success([current, otherB])).mockResolvedValueOnce(success([current]))

    const result = await createSessionManager().revokeAllOtherSessions()

    expect(apiService.deleteSession.mock.calls).toEqual([['other-a'], ['other-b']])
    expect(result).toEqual({
      requestedSessionIds: ['other-a', 'other-b'],
      revokedSessionIds: ['other-a', 'other-b'],
      failures: [],
      sessions: [current],
    })
  })

  it('reports an HTTP failure without replacing the last confirmed session list', async () => {
    const current = session('current', true)
    const otherA = session('other-a', false, '2026-07-30T11:00:00.000Z')
    const otherB = session('other-b', false, '2026-07-30T10:00:00.000Z')
    const afterFirstRevoke = [current, otherB]
    apiService.getSessionsList.mockResolvedValue(success([current, otherA, otherB]))
    apiService.deleteSession
      .mockResolvedValueOnce(success(afterFirstRevoke))
      .mockResolvedValueOnce(failure('The server refused this revocation.'))

    const result = await createSessionManager().revokeAllOtherSessions()

    expect(apiService.deleteSession).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      requestedSessionIds: ['other-a', 'other-b'],
      revokedSessionIds: ['other-a'],
      failures: [
        {
          sessionId: 'other-b',
          message: 'The server refused this revocation.',
        },
      ],
      sessions: afterFirstRevoke,
    })
  })

  it('records a rejected request and continues checking the remaining revocations', async () => {
    const current = session('current', true)
    const otherA = session('other-a', false, '2026-07-30T11:00:00.000Z')
    const otherB = session('other-b', false, '2026-07-30T10:00:00.000Z')
    const confirmedAfterSecondRequest = [current, otherA]
    apiService.getSessionsList.mockResolvedValue(success([current, otherA, otherB]))
    apiService.deleteSession
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(success(confirmedAfterSecondRequest))

    const result = await createSessionManager().revokeAllOtherSessions()

    expect(apiService.deleteSession.mock.calls).toEqual([['other-a'], ['other-b']])
    expect(result).toEqual({
      requestedSessionIds: ['other-a', 'other-b'],
      revokedSessionIds: ['other-b'],
      failures: [
        {
          sessionId: 'other-a',
          message: 'Network unavailable',
        },
      ],
      sessions: confirmedAfterSecondRequest,
    })
  })

  it('never requests revocation of the current session', async () => {
    const current = session('current', true)
    const other = session('other')
    apiService.getSessionsList.mockResolvedValue(success([current, other]))
    apiService.deleteSession.mockResolvedValue(success([current]))

    const result = await createSessionManager().revokeAllOtherSessions()

    expect(apiService.deleteSession).toHaveBeenCalledTimes(1)
    expect(apiService.deleteSession).toHaveBeenCalledWith('other')
    expect(apiService.deleteSession).not.toHaveBeenCalledWith('current')
    expect(result.requestedSessionIds).toEqual(['other'])
  })
})
