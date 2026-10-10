import { Result, Uuid, ValueObject } from '@standardnotes/domain-core'

import { ItemHashProps } from './ItemHashProps'

export class ItemHash extends ValueObject<ItemHashProps> {
  private constructor(props: ItemHashProps) {
    super(props)
  }

  static create(props: ItemHashProps): Result<ItemHash> {
    if (props.shared_vault_uuid) {
      const sharedVaultUuidOrError = Uuid.create(props.shared_vault_uuid)
      if (sharedVaultUuidOrError.isFailed()) {
        return Result.fail<ItemHash>(sharedVaultUuidOrError.getError())
      }
    }

    /**
     * Standard Red Notes: REFUSE A TIMESTAMP THE COLUMN CANNOT GIVE BACK.
     *
     * Both save paths adopt a supplied `created_at_timestamp` verbatim (and fall
     * back to `updated_at_timestamp` for it), and the only check downstream is
     * `Timestamps.create`, which asks for a number and nothing more. A number
     * past `Number.MAX_SAFE_INTEGER` is still a number, so it is stored in a
     * BIGINT column that MySQL then hands back as a STRING — the one shape the
     * mapper cannot turn into an `Item`. A client could therefore write a row of
     * its own that no sync of its own could ever read again. A fractional value
     * is the same mistake with a different ending: the column truncates it, so
     * what comes back is not what was written.
     *
     * This is the one boundary where refusing costs nothing: the client is told,
     * in a 400 it can correct, before anything is persisted. The read paths
     * cannot refuse like this — a row already written is one an operator has to
     * be able to repair, and failing a whole account's sync over it would be a
     * denial of service, not a fix.
     *
     * Only a NUMERIC value is judged: `undefined`, `null` and every whole
     * number in range behave exactly as before, and a string timestamp from an
     * old client keeps failing downstream where it already failed rather than
     * failing somewhere new. `NaN` and `Infinity` are refused here even though
     * the save paths would have skipped them as falsy or stored them as garbage,
     * because a client that sent one asked for something this column cannot
     * hold and is better told so than quietly given the current time.
     */
    for (const [field, value] of [
      ['created_at_timestamp', props.created_at_timestamp],
      ['updated_at_timestamp', props.updated_at_timestamp],
    ] as const) {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        return Result.fail<ItemHash>(
          `Given ${field} is not a whole number this server can store and read back: ${value}`,
        )
      }
    }

    return Result.ok<ItemHash>(new ItemHash(props))
  }

  representsASharedVaultItem(): boolean {
    return this.props.shared_vault_uuid !== null
  }

  calculateContentSize(): number {
    return Buffer.byteLength(JSON.stringify(this))
  }

  get sharedVaultUuid(): Uuid | null {
    if (!this.representsASharedVaultItem()) {
      return null
    }

    return Uuid.create(this.props.shared_vault_uuid as string).getValue()
  }

  hasDedicatedKeySystemAssociation(): boolean {
    return this.props.key_system_identifier !== null
  }
}
