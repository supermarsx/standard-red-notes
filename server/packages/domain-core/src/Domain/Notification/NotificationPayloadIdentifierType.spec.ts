import { NotificationPayloadIdentifierType } from './NotificationPayloadIdentifierType'

describe('NotificationPayloadIdentifierType', () => {
  it('declares exactly the four supported identifier types', () => {
    expect(NotificationPayloadIdentifierType.TYPES).toEqual({
      SharedVaultUuid: 'shared_vault_uuid',
      UserUuid: 'user_uuid',
      SharedVaultInviteUuid: 'shared_vault_invite_uuid',
      ItemUuid: 'item_uuid',
    })
  })

  it.each(Object.values(NotificationPayloadIdentifierType.TYPES))('accepts %s', (type) => {
    const result = NotificationPayloadIdentifierType.create(type)

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().value).toBe(type)
  })

  it('rejects an unknown type, quoting it in the error', () => {
    const result = NotificationPayloadIdentifierType.create('team_uuid')

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Invalid notification payload identifier type: team_uuid')
  })

  it('rejects the TYPES key rather than its value', () => {
    expect(NotificationPayloadIdentifierType.create('UserUuid').isFailed()).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(NotificationPayloadIdentifierType.create('').isFailed()).toBe(true)
  })

  it('treats two instances of the same type as equal', () => {
    const a = NotificationPayloadIdentifierType.create(NotificationPayloadIdentifierType.TYPES.UserUuid).getValue()
    const b = NotificationPayloadIdentifierType.create(NotificationPayloadIdentifierType.TYPES.UserUuid).getValue()

    expect(a.equals(b)).toBe(true)
  })

  it('treats instances of different types as unequal', () => {
    const a = NotificationPayloadIdentifierType.create(NotificationPayloadIdentifierType.TYPES.UserUuid).getValue()
    const b = NotificationPayloadIdentifierType.create(NotificationPayloadIdentifierType.TYPES.ItemUuid).getValue()

    expect(a.equals(b)).toBe(false)
  })
})
