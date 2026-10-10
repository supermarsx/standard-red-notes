import { ContentType, Dates, Result, Timestamps, Uuid } from '@standardnotes/domain-core'

import { KeySystemAssociation } from '../../Domain/KeySystem/KeySystemAssociation'
import { SharedVaultAssociation } from '../../Domain/SharedVault/SharedVaultAssociation'
import { SQLItem } from '../../Infra/TypeORM/SQLItem'

/**
 * Standard Red Notes: THE ONE AUTHORITY ON WHETHER A PERSISTED ROW CAN BECOME AN
 * ITEM, and it exists because two paths used to answer that question differently.
 *
 * The fetch paths (`findAll`, `findByUuid`, `findByUuidAndUserUuid`) have always
 * decided it by calling the mapper and catching its throw. The integrity
 * reporting path decided it by never asking: it read three columns of raw SQL,
 * so a row the mapper refuses was reported as present on the server and then
 * never delivered by any sync. A client cannot leave that state — it is told it
 * diverges, asks, receives nothing, recomputes, and is told again — so the two
 * must share one decision rather than hold two.
 *
 * Sharing it is why this is a parser and not a validator: it returns the built
 * value objects, so `toDomain` consumes the same result it would otherwise have
 * recomputed, and there is no second copy of these rules to drift.
 *
 * *** THE COLUMN LIST IS THE TYPE. *** `MappableItemProjection` is derived from
 * `ITEM_MAPPABILITY_COLUMNS`, so a reader that selects that list can satisfy
 * this function and a field this function wants but the list omits is a
 * compile error rather than a row that silently parses as broken. Getting that
 * backwards is the dangerous direction: a forgotten column would make EVERY row
 * look unmappable and quietly empty the integrity report for whole accounts.
 *
 * `content`, `enc_item_key`, `auth_hash` and `items_key_id` are deliberately
 * absent: no validation reads them (`Item.create` only computes a size), so a
 * reader deciding mappability never has to pull an account's ciphertext —
 * `content` is a mediumtext and reading it per integrity check is the cost the
 * raw three-column select was avoiding in the first place.
 */
export const ITEM_MAPPABILITY_COLUMNS = [
  'uuid',
  'duplicateOf',
  'contentType',
  'userUuid',
  'createdAt',
  'updatedAt',
  'createdAtTimestamp',
  'updatedAtTimestamp',
  'updatedWithSession',
  'sharedVaultUuid',
  'lastEditedBy',
  'keySystemIdentifier',
] as const

export type MappableItemProjection = Pick<SQLItem, (typeof ITEM_MAPPABILITY_COLUMNS)[number]>

export type ItemProjectionParts = {
  uuid: Uuid
  duplicateOf: Uuid | null
  contentType: ContentType
  userUuid: Uuid
  dates: Dates
  timestamps: Timestamps
  updatedWithSession: Uuid | null
  sharedVaultAssociation: SharedVaultAssociation | undefined
  keySystemAssociation: KeySystemAssociation | undefined
}

export function parseItemProjection(projection: MappableItemProjection): Result<ItemProjectionParts> {
  const uuidOrError = Uuid.create(projection.uuid)
  if (uuidOrError.isFailed()) {
    return Result.fail(uuidOrError.getError())
  }

  let duplicateOf = null
  if (projection.duplicateOf) {
    const duplicateOfOrError = Uuid.create(projection.duplicateOf)
    if (duplicateOfOrError.isFailed()) {
      return Result.fail(duplicateOfOrError.getError())
    }
    duplicateOf = duplicateOfOrError.getValue()
  }

  const contentTypeOrError = ContentType.create(projection.contentType)
  if (contentTypeOrError.isFailed()) {
    return Result.fail(contentTypeOrError.getError())
  }

  const userUuidOrError = Uuid.create(projection.userUuid)
  if (userUuidOrError.isFailed()) {
    return Result.fail(userUuidOrError.getError())
  }

  const datesOrError = Dates.create(projection.createdAt, projection.updatedAt)
  if (datesOrError.isFailed()) {
    return Result.fail(datesOrError.getError())
  }

  const timestampsOrError = Timestamps.create(projection.createdAtTimestamp, projection.updatedAtTimestamp)
  if (timestampsOrError.isFailed()) {
    return Result.fail(timestampsOrError.getError())
  }

  let updatedWithSession = null
  if (projection.updatedWithSession) {
    const updatedWithSessionOrError = Uuid.create(projection.updatedWithSession)
    if (updatedWithSessionOrError.isFailed()) {
      return Result.fail(updatedWithSessionOrError.getError())
    }
    updatedWithSession = updatedWithSessionOrError.getValue()
  }

  // Both halves or neither: a row carrying only one of them keeps its item
  // mappable and simply has no association, which is the pre-existing
  // behaviour and not something this parser may start refusing.
  let sharedVaultAssociation: SharedVaultAssociation | undefined = undefined
  if (projection.sharedVaultUuid && projection.lastEditedBy) {
    const sharedVaultUuidOrError = Uuid.create(projection.sharedVaultUuid)
    if (sharedVaultUuidOrError.isFailed()) {
      return Result.fail(sharedVaultUuidOrError.getError())
    }

    const lastEditedByOrError = Uuid.create(projection.lastEditedBy)
    if (lastEditedByOrError.isFailed()) {
      return Result.fail(lastEditedByOrError.getError())
    }

    // No `isFailed()` arm: `SharedVaultAssociation.create` returns `Result.ok`
    // unconditionally, so an arm here would be a branch that cannot be taken —
    // the shape this pane refuses, and one a mutation would survive. `getValue()`
    // throws if that ever stops being true, which every fetch caller already
    // treats as "this row cannot be delivered".
    sharedVaultAssociation = SharedVaultAssociation.create({
      sharedVaultUuid: sharedVaultUuidOrError.getValue(),
      lastEditedBy: lastEditedByOrError.getValue(),
    }).getValue()
  }

  let keySystemAssociation: KeySystemAssociation | undefined = undefined
  if (projection.keySystemIdentifier) {
    const keySystemAssociationOrError = KeySystemAssociation.create(projection.keySystemIdentifier)
    if (keySystemAssociationOrError.isFailed()) {
      return Result.fail(keySystemAssociationOrError.getError())
    }
    keySystemAssociation = keySystemAssociationOrError.getValue()
  }

  return Result.ok({
    uuid: uuidOrError.getValue(),
    duplicateOf,
    contentType: contentTypeOrError.getValue(),
    userUuid: userUuidOrError.getValue(),
    dates: datesOrError.getValue(),
    timestamps: timestampsOrError.getValue(),
    updatedWithSession,
    sharedVaultAssociation,
    keySystemAssociation,
  })
}
