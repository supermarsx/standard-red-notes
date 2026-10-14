import { countSessionDevices, presentSessionActivity, presentActivity } from './sessionPresentation'
import type { SessionListEntry } from '@standardnotes/responses'

const session = (extra: Partial<SessionListEntry> = {}): SessionListEntry => ({
  uuid: 's1',
  current: true,
  api_version: '1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2099-01-01T00:00:00Z',
  device_info: 'Firefox',
  ...extra,
})

describe('session activity presentation', () => {
  it('never fabricates last seen from a metadata update or current session flag', () => {
    expect(presentSessionActivity(session(), 10)).toMatchObject({
      active: false,
      statusLabel: 'Activity unavailable',
      lastSeenText: 'Activity unavailable',
    })
    expect(presentSessionActivity(session({ last_seen_at: null }), 10).lastSeenText).toBe('Not yet observed')
  })
  it('ages a server-clock snapshot even when the client clock is years ahead', () => {
    const snapshot = session({
      last_seen_at: '2026-01-01T00:00:00Z',
      activity_checked_at: '2026-01-01T00:00:30Z',
      active: true,
    })
    const received = Date.parse('2099-01-01T00:00:00Z')
    expect(presentSessionActivity(snapshot, received, received).statusLabel).toBe('Active recently')
    expect(presentSessionActivity(snapshot, received + 90_001, received).statusLabel).toBe('Inactive')
  })
  it('does not infer activity when the backend explicitly marks inactive or returns invalid dates', () => {
    expect(
      presentActivity({ last_seen_at: '2026-01-01', activity_checked_at: '2026-01-01', active: false }, 0).active,
    ).toBe(false)
    expect(
      presentActivity({ last_seen_at: 'not-a-date', activity_checked_at: '2026-01-01', active: true }, 0).active,
    ).toBe(false)
  })
  it('counts exact profile identities across sessions without merging equal user-agent labels', () => {
    const device = (device_id: string) => ({ device_id, last_seen_at: '2026-01-01', active: true })
    expect(
      countSessionDevices([
        session({ devices: [device('a'), device('b')] }),
        session({ uuid: 's2', devices: [device('a')] }),
      ]),
    ).toBe(2)
    expect(countSessionDevices([session()])).toBe(0)
  })
})
