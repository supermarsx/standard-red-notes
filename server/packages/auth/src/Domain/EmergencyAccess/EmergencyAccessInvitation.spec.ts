import { Dates, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { EmergencyAccessInvitation } from './EmergencyAccessInvitation'
import { EmergencyAccessInvitationProps } from './EmergencyAccessInvitationProps'
import { EmergencyAccessInvitationStatus } from './EmergencyAccessInvitationStatus'

describe('EmergencyAccessInvitation', () => {
  const props = (): EmergencyAccessInvitationProps => ({
    grantorUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
    granteeUuid: Uuid.create('11111111-1111-1111-1111-111111111111').getValue(),
    status: EmergencyAccessInvitationStatus.create(EmergencyAccessInvitationStatus.NAMES.Sent).getValue(),
    expiresAt: new Date(1000),
    dates: Dates.create(new Date(1), new Date(2)).getValue(),
  })

  it('should keep the props it was created with', () => {
    const result = EmergencyAccessInvitation.create(props())

    expect(result.isFailed()).toBe(false)
    const invitation = result.getValue()
    expect(invitation.props.status.value).toEqual('sent')
    expect(invitation.props.expiresAt).toEqual(new Date(1000))
  })

  it('should keep the supplied id', () => {
    const result = EmergencyAccessInvitation.create(props(), new UniqueEntityId('invitation-1'))

    expect(result.getValue().id.toString()).toEqual('invitation-1')
  })
})
