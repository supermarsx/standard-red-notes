import {
  NotificationPayload,
  NotificationPayloadIdentifierType,
  NotificationType,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'

import { Notification } from '../../Domain/Notifications/Notification'

import { NotificationHttpMapper } from './NotificationHttpMapper'

describe('NotificationHttpMapper', () => {
  const notificationUuid = '00000000-0000-0000-0000-000000000001'
  const userUuid = '00000000-0000-0000-0000-000000000002'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000003'

  const createMapper = () => new NotificationHttpMapper()

  const payload = () =>
    NotificationPayload.create({
      primaryIdentifier: Uuid.create(sharedVaultUuid).getValue(),
      primaryIndentifierType: NotificationPayloadIdentifierType.create(
        NotificationPayloadIdentifierType.TYPES.SharedVaultUuid,
      ).getValue(),
      type: NotificationType.create(NotificationType.TYPES.SelfRemovedFromSharedVault).getValue(),
      version: '1.0',
    }).getValue()

  const createNotification = () =>
    Notification.create(
      {
        userUuid: Uuid.create(userUuid).getValue(),
        type: NotificationType.create(NotificationType.TYPES.SharedVaultItemRemoved).getValue(),
        payload: payload(),
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(notificationUuid),
    ).getValue()

  it('maps a notification onto its http representation', () => {
    expect(createMapper().toProjection(createNotification())).toEqual({
      uuid: notificationUuid,
      user_uuid: userUuid,
      type: NotificationType.TYPES.SharedVaultItemRemoved,
      payload: payload().toString(),
      created_at_timestamp: 123,
      updated_at_timestamp: 456,
    })
  })

  it('serialises the payload to a string rather than an object', () => {
    expect(typeof createMapper().toProjection(createNotification()).payload).toEqual('string')
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})
