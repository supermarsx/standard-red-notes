import { HttpResponse } from '@standardnotes/snjs'
import {
  activeInviteLinkCount,
  buildCreateInviteBody,
  emptyCreateInviteForm,
  formatInviteLinkDate,
  inviteLinkAbsoluteUrl,
  inviteLinkStatusChipClass,
  inviteLinkStatusLabel,
  inviteLinkUsesLabel,
  parseCreatedInviteLink,
  parseInviteLink,
  parseSelfServeInviteState,
} from './inviteLinks'

const ok = (data: unknown): HttpResponse => ({ status: 200, data } as unknown as HttpResponse)
const err = (status: number, message = 'nope'): HttpResponse =>
  ({ status, data: { error: { message } } } as unknown as HttpResponse)

const link = (overrides: Record<string, unknown> = {}) => ({
  uuid: 'u1',
  label: 'Study group',
  maxUses: 3,
  usedCount: 1,
  remainingUses: 2,
  expiresAt: null,
  revoked: false,
  status: 'active',
  createdAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
})

describe('parseSelfServeInviteState — gating', () => {
  it('is disabled for an error response', () => {
    const state = parseSelfServeInviteState(err(403))
    expect(state.enabled).toBe(false)
    expect(state.links).toEqual([])
  })

  it('is disabled when the body has no inviteLinks array', () => {
    expect(parseSelfServeInviteState(ok({})).enabled).toBe(false)
  })

  it('is disabled when the server reports invitesPerUser: 0', () => {
    const state = parseSelfServeInviteState(ok({ inviteLinks: [], invitesPerUser: 0 }))
    expect(state.enabled).toBe(false)
    expect(state.invitesPerUser).toBe(0)
  })

  it('is enabled when invitesPerUser > 0', () => {
    const state = parseSelfServeInviteState(ok({ inviteLinks: [link()], invitesPerUser: 3 }))
    expect(state.enabled).toBe(true)
    expect(state.invitesPerUser).toBe(3)
    expect(state.links).toHaveLength(1)
  })

  it('is enabled (quota unknown) when invitesPerUser is omitted but an inviteLinks array is present', () => {
    const state = parseSelfServeInviteState(ok({ inviteLinks: [] }))
    expect(state.enabled).toBe(true)
    expect(state.invitesPerUser).toBeUndefined()
  })
})

describe('parseSelfServeInviteState — attribution', () => {
  it('uses a top-level invitedCount when present', () => {
    const state = parseSelfServeInviteState(ok({ inviteLinks: [link()], invitesPerUser: 3, invitedCount: 9 }))
    expect(state.invitedCount).toBe(9)
  })

  it('falls back to summing usedCount across links', () => {
    const state = parseSelfServeInviteState(
      ok({ inviteLinks: [link({ usedCount: 2 }), link({ uuid: 'u2', usedCount: 5 })], invitesPerUser: 3 }),
    )
    expect(state.invitedCount).toBe(7)
  })
})

describe('parseInviteLink', () => {
  it('drops records without a uuid', () => {
    expect(parseInviteLink({ maxUses: 1 })).toBeUndefined()
  })

  it('derives a status when the server omits it (revoked > expired > exhausted > active)', () => {
    expect(parseInviteLink(link({ status: undefined, revoked: true }))?.status).toBe('revoked')
    expect(
      parseInviteLink(link({ status: undefined, expiresAt: '2000-01-01T00:00:00.000Z' }))?.status,
    ).toBe('expired')
    expect(parseInviteLink(link({ status: undefined, remainingUses: 0 }))?.status).toBe('exhausted')
    expect(parseInviteLink(link({ status: undefined }))?.status).toBe('active')
  })
})

describe('parseCreatedInviteLink', () => {
  it('returns undefined for an error response', () => {
    expect(parseCreatedInviteLink(err(400))).toBeUndefined()
  })

  it('extracts the one-time token + path', () => {
    const created = parseCreatedInviteLink(
      ok({ inviteLink: { ...link(), token: 'a'.repeat(64), path: '/?invite=' + 'a'.repeat(64) } }),
    )
    expect(created?.token).toHaveLength(64)
    expect(created?.path).toBe('/?invite=' + 'a'.repeat(64))
  })

  it('returns undefined when the token/path are missing', () => {
    expect(parseCreatedInviteLink(ok({ inviteLink: link() }))).toBeUndefined()
  })
})

describe('activeInviteLinkCount', () => {
  it('counts only active links', () => {
    const state = parseSelfServeInviteState(
      ok({
        inviteLinks: [link(), link({ uuid: 'u2', status: 'revoked' }), link({ uuid: 'u3', status: 'exhausted' })],
        invitesPerUser: 5,
      }),
    )
    expect(activeInviteLinkCount(state.links)).toBe(1)
  })
})

describe('buildCreateInviteBody — self-serve (no role/domain)', () => {
  it('defaults max uses to 1 and expiry to never', () => {
    const result = buildCreateInviteBody(emptyCreateInviteForm())
    expect(result).toEqual({ ok: true, value: { maxUses: 1, expiresInHours: null, label: null } })
  })

  it('accepts a batch link with expiry and label', () => {
    const result = buildCreateInviteBody({ maxUses: '10', expiresInHours: '48', label: 'Team' })
    expect(result).toEqual({ ok: true, value: { maxUses: 10, expiresInHours: 48, label: 'Team' } })
  })

  it('rejects a non-integer / out-of-range max uses', () => {
    expect(buildCreateInviteBody({ maxUses: '0', expiresInHours: '', label: '' }).ok).toBe(false)
    expect(buildCreateInviteBody({ maxUses: '100001', expiresInHours: '', label: '' }).ok).toBe(false)
    expect(buildCreateInviteBody({ maxUses: '1.5', expiresInHours: '', label: '' }).ok).toBe(false)
  })

  it('rejects an out-of-range expiry', () => {
    expect(buildCreateInviteBody({ maxUses: '1', expiresInHours: '0', label: '' }).ok).toBe(false)
    expect(buildCreateInviteBody({ maxUses: '1', expiresInHours: '9000', label: '' }).ok).toBe(false)
  })

  it('never emits a role or domain field (privilege guard)', () => {
    const result = buildCreateInviteBody({ maxUses: '2', expiresInHours: '', label: 'x' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(['expiresInHours', 'label', 'maxUses'])
    }
  })
})

describe('display helpers', () => {
  it('labels and chips a status', () => {
    expect(inviteLinkStatusLabel('active')).toBe('Active')
    expect(inviteLinkStatusChipClass('active')).toContain('bg-success')
    expect(inviteLinkStatusChipClass('revoked')).toContain('bg-danger')
  })

  it('formats uses and the absolute URL', () => {
    expect(inviteLinkUsesLabel(1, 3)).toBe('1/3')
    expect(inviteLinkAbsoluteUrl('https://notes.example.com', '/?invite=tok')).toBe(
      'https://notes.example.com/?invite=tok',
    )
  })

  it('formats a never/blank date to the fallback', () => {
    expect(formatInviteLinkDate(null, 'Never')).toBe('Never')
    expect(formatInviteLinkDate(undefined)).toBe('—')
  })
})
