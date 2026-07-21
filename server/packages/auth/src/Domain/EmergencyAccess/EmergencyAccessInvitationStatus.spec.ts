import { EmergencyAccessInvitationStatus } from './EmergencyAccessInvitationStatus'

describe('EmergencyAccessInvitationStatus', () => {
  it('should accept every named status', () => {
    for (const name of Object.values(EmergencyAccessInvitationStatus.NAMES)) {
      const result = EmergencyAccessInvitationStatus.create(name)

      expect(result.isFailed()).toBe(false)
      expect(result.getValue().value).toEqual(name)
    }
  })

  it('should refuse a status that is not in the catalogue', () => {
    const result = EmergencyAccessInvitationStatus.create('deleted')

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Invalid status name: deleted')
  })

  it('should be case sensitive', () => {
    const result = EmergencyAccessInvitationStatus.create('Sent')

    expect(result.isFailed()).toBe(true)
  })
})
