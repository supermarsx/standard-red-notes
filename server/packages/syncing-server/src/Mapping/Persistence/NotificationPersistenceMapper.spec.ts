import {
  NotificationPayload,
  NotificationPayloadIdentifierType,
  NotificationType,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'

import { Notification } from '../../Domain/Notifications/Notification'
import { TypeORMNotification } from '../../Infra/TypeORM/TypeORMNotification'

import { NotificationPersistenceMapper } from './NotificationPersistenceMapper'

describe('NotificationPersistenceMapper', () => {
  const notificationUuid = '00000000-0000-0000-0000-000000000001'
  const userUuid = '00000000-0000-0000-0000-000000000002'
  const sharedVaultUuid = '00000000-0000-0000-0000-000000000003'

  const createMapper = () => new NotificationPersistenceMapper()

  const payload = () =>
    NotificationPayload.create({
      primaryIdentifier: Uuid.create(sharedVaultUuid).getValue(),
      primaryIndentifierType: NotificationPayloadIdentifierType.create(
        NotificationPayloadIdentifierType.TYPES.SharedVaultUuid,
      ).getValue(),
      type: NotificationType.create(NotificationType.TYPES.SelfRemovedFromSharedVault).getValue(),
      version: '1.0',
    }).getValue()

  const createProjection = (overrides: Partial<TypeORMNotification> = {}): TypeORMNotification => {
    const typeorm = new TypeORMNotification()
    typeorm.uuid = notificationUuid
    typeorm.userUuid = userUuid
    typeorm.type = NotificationType.TYPES.SharedVaultItemRemoved
    typeorm.payload = payload().toString()
    typeorm.createdAtTimestamp = 123
    typeorm.updatedAtTimestamp = 456

    return Object.assign(typeorm, overrides)
  }

  const createDomain = () =>
    Notification.create(
      {
        userUuid: Uuid.create(userUuid).getValue(),
        type: NotificationType.create(NotificationType.TYPES.SharedVaultItemRemoved).getValue(),
        payload: payload(),
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(notificationUuid),
    ).getValue()

  it('rebuilds the notification from its persisted row', () => {
    const notification = createMapper().toDomain(createProjection())

    expect(notification.id.toString()).toEqual(notificationUuid)
    expect(notification.props.userUuid.value).toEqual(userUuid)
    expect(notification.props.type.value).toEqual(NotificationType.TYPES.SharedVaultItemRemoved)
    expect(notification.props.payload.toString()).toEqual(payload().toString())
    expect(notification.props.timestamps.createdAt).toEqual(123)
    expect(notification.props.timestamps.updatedAt).toEqual(456)
  })

  it('rejects a row with a malformed user uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ userUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create notification from projection:/,
    )
  })

  it('rejects a row whose timestamps are not numbers', () => {
    expect(() => createMapper().toDomain(createProjection({ updatedAtTimestamp: '456' as unknown as number }))).toThrow(
      /^Failed to create notification from projection:/,
    )
  })

  it('rejects a row with an unknown notification type', () => {
    expect(() => createMapper().toDomain(createProjection({ type: 'NOT-A-TYPE' }))).toThrow(
      /^Failed to create notification from projection:/,
    )
  })

  it('rejects a row with an unparsable payload', () => {
    expect(() => createMapper().toDomain(createProjection({ payload: 'not-json' }))).toThrow(
      /^Failed to create notification from projection:/,
    )
  })

  it('maps a notification onto its persisted row', () => {
    const projection = createMapper().toProjection(createDomain())

    expect(projection).toBeInstanceOf(TypeORMNotification)
    expect(projection.uuid).toEqual(notificationUuid)
    expect(projection.userUuid).toEqual(userUuid)
    expect(projection.type).toEqual(NotificationType.TYPES.SharedVaultItemRemoved)
    expect(projection.payload).toEqual(payload().toString())
    expect(projection.createdAtTimestamp).toEqual(123)
    expect(projection.updatedAtTimestamp).toEqual(456)
  })

  it('round trips a notification without altering it', () => {
    const mapper = createMapper()

    expect(mapper.toProjection(mapper.toDomain(createProjection()))).toEqual(createProjection())
  })
})
