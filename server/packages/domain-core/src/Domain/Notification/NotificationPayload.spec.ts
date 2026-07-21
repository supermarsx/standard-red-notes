import { Uuid } from '../Common/Uuid'
import { NotificationPayload } from './NotificationPayload'
import { NotificationPayloadIdentifierType } from './NotificationPayloadIdentifierType'
import { NotificationType } from './NotificationType'

describe('NotificationPayload', () => {
  const primaryUuid = '00000000-0000-0000-0000-000000000000'
  const secondaryUuid = '11111111-1111-1111-1111-111111111111'

  const validProps = (overrides: Record<string, unknown> = {}) => ({
    version: '1.0',
    type: NotificationType.TYPES.UserAddedToSharedVault,
    primaryIdentifier: primaryUuid,
    primaryIndentifierType: NotificationPayloadIdentifierType.TYPES.SharedVaultUuid,
    ...overrides,
  })

  describe('create', () => {
    const domainProps = (overrides: Partial<Parameters<typeof NotificationPayload.create>[0]> = {}) => ({
      version: '1.0',
      type: NotificationType.create(NotificationType.TYPES.UserAddedToSharedVault).getValue(),
      primaryIdentifier: Uuid.create(primaryUuid).getValue(),
      primaryIndentifierType: NotificationPayloadIdentifierType.create(
        NotificationPayloadIdentifierType.TYPES.SharedVaultUuid,
      ).getValue(),
      ...overrides,
    })

    it('creates a payload without a secondary identifier for a type that does not need one', () => {
      const result = NotificationPayload.create(domainProps())

      expect(result.isFailed()).toBe(false)
      expect(result.getValue().props.version).toBe('1.0')
    })

    it('requires a secondary identifier for shared_vault_item_removed', () => {
      const result = NotificationPayload.create(
        domainProps({ type: NotificationType.create(NotificationType.TYPES.SharedVaultItemRemoved).getValue() }),
      )

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Item uuid is required for shared_vault_item_removed notification type')
    })

    it('accepts shared_vault_item_removed once a secondary identifier is supplied', () => {
      const result = NotificationPayload.create(
        domainProps({
          type: NotificationType.create(NotificationType.TYPES.SharedVaultItemRemoved).getValue(),
          secondaryIdentifier: Uuid.create(secondaryUuid).getValue(),
        }),
      )

      expect(result.isFailed()).toBe(false)
    })
  })

  describe('createFromString', () => {
    it('parses a minimal payload', () => {
      const result = NotificationPayload.createFromString(JSON.stringify(validProps()))

      expect(result.isFailed()).toBe(false)
      const payload = result.getValue()
      expect(payload.props.version).toBe('1.0')
      expect(payload.props.type.value).toBe(NotificationType.TYPES.UserAddedToSharedVault)
      expect(payload.props.primaryIdentifier.value).toBe(primaryUuid)
      expect(payload.props.primaryIndentifierType.value).toBe(NotificationPayloadIdentifierType.TYPES.SharedVaultUuid)
      expect(payload.props.secondaryIdentifier).toBeUndefined()
      expect(payload.props.secondaryIdentifierType).toBeUndefined()
    })

    it('parses the optional secondary identifier and its type', () => {
      const payload = NotificationPayload.createFromString(
        JSON.stringify(
          validProps({
            secondaryIdentifier: secondaryUuid,
            secondaryIdentifierType: NotificationPayloadIdentifierType.TYPES.ItemUuid,
          }),
        ),
      ).getValue()

      expect(payload.props.secondaryIdentifier?.value).toBe(secondaryUuid)
      expect(payload.props.secondaryIdentifierType?.value).toBe(NotificationPayloadIdentifierType.TYPES.ItemUuid)
    })

    it('fails with the JSON parser error on malformed input', () => {
      const result = NotificationPayload.createFromString('not json')

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual(expect.any(String))
      expect(result.getError().length).toBeGreaterThan(0)
    })

    it('propagates an invalid notification type error', () => {
      const result = NotificationPayload.createFromString(JSON.stringify(validProps({ type: 'nope' })))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Invalid notification type: nope')
    })

    it('propagates an invalid primary identifier error', () => {
      const result = NotificationPayload.createFromString(JSON.stringify(validProps({ primaryIdentifier: 'nope' })))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Given value is not a valid uuid: nope')
    })

    it('propagates an invalid primary identifier type error', () => {
      const result = NotificationPayload.createFromString(
        JSON.stringify(validProps({ primaryIndentifierType: 'nope' })),
      )

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Invalid notification payload identifier type: nope')
    })

    it('propagates an invalid secondary identifier error', () => {
      const result = NotificationPayload.createFromString(JSON.stringify(validProps({ secondaryIdentifier: 'nope' })))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Given value is not a valid uuid: nope')
    })

    it('propagates an invalid secondary identifier type error', () => {
      const result = NotificationPayload.createFromString(
        JSON.stringify(validProps({ secondaryIdentifierType: 'nope' })),
      )

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Invalid notification payload identifier type: nope')
    })

    it('applies the create() invariant, rejecting shared_vault_item_removed with no secondary identifier', () => {
      const result = NotificationPayload.createFromString(
        JSON.stringify(validProps({ type: NotificationType.TYPES.SharedVaultItemRemoved })),
      )

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Item uuid is required for shared_vault_item_removed notification type')
    })
  })

  describe('toString', () => {
    it('serialises every field, unwrapping the value objects', () => {
      const payload = NotificationPayload.createFromString(
        JSON.stringify(
          validProps({
            secondaryIdentifier: secondaryUuid,
            secondaryIdentifierType: NotificationPayloadIdentifierType.TYPES.ItemUuid,
          }),
        ),
      ).getValue()

      expect(JSON.parse(payload.toString())).toEqual({
        version: '1.0',
        type: NotificationType.TYPES.UserAddedToSharedVault,
        primaryIdentifier: primaryUuid,
        primaryIndentifierType: NotificationPayloadIdentifierType.TYPES.SharedVaultUuid,
        secondaryIdentifier: secondaryUuid,
        secondaryIdentifierType: NotificationPayloadIdentifierType.TYPES.ItemUuid,
      })
    })

    it('omits the absent optional fields', () => {
      const payload = NotificationPayload.createFromString(JSON.stringify(validProps())).getValue()

      const serialised = JSON.parse(payload.toString())

      expect(serialised).not.toHaveProperty('secondaryIdentifier')
      expect(serialised).not.toHaveProperty('secondaryIdentifierType')
    })

    it('round-trips through createFromString without losing data', () => {
      const original = NotificationPayload.createFromString(
        JSON.stringify(
          validProps({
            secondaryIdentifier: secondaryUuid,
            secondaryIdentifierType: NotificationPayloadIdentifierType.TYPES.ItemUuid,
          }),
        ),
      ).getValue()

      const restored = NotificationPayload.createFromString(original.toString()).getValue()

      expect(restored.toString()).toBe(original.toString())
    })
  })
})
