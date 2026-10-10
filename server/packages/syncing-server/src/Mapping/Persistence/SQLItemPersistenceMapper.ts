import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { Item } from '../../Domain/Item/Item'

import { SQLItem } from '../../Infra/TypeORM/SQLItem'
import { parseItemProjection } from './SQLItemProjectionParser'

export class SQLItemPersistenceMapper implements MapperInterface<Item, SQLItem> {
  toDomain(projection: SQLItem): Item {
    const partsOrError = parseItemProjection(projection)
    if (partsOrError.isFailed()) {
      throw new Error(`Failed to create item from projection: ${partsOrError.getError()}`)
    }
    const parts = partsOrError.getValue()

    // Every rule that can REJECT a row lives in the parser above, which is the
    // same function the integrity reporting path consults, so that path can no
    // longer report a row this mapper would refuse to produce. `Item.create`
    // validates nothing and cannot fail; `getValue()` throws if that ever
    // changes, and every caller of this mapper already treats a throw as "this
    // row cannot be delivered".
    return Item.create(
      {
        duplicateOf: parts.duplicateOf,
        itemsKeyId: projection.itemsKeyId,
        content: projection.content,
        contentType: parts.contentType,
        contentSize: projection.contentSize ?? undefined,
        encItemKey: projection.encItemKey,
        authHash: projection.authHash,
        userUuid: parts.userUuid,
        deleted: !!projection.deleted,
        dates: parts.dates,
        timestamps: parts.timestamps,
        updatedWithSession: parts.updatedWithSession,
        sharedVaultAssociation: parts.sharedVaultAssociation,
        keySystemAssociation: parts.keySystemAssociation,
      },
      new UniqueEntityId(parts.uuid.value),
    ).getValue()
  }

  toProjection(domain: Item): SQLItem {
    const typeorm = new SQLItem()

    typeorm.uuid = domain.id.toString()
    typeorm.duplicateOf = domain.props.duplicateOf ? domain.props.duplicateOf.value : null
    typeorm.itemsKeyId = domain.props.itemsKeyId
    typeorm.content = domain.props.content
    typeorm.contentType = domain.props.contentType.value
    typeorm.contentSize = domain.props.contentSize ?? null
    typeorm.encItemKey = domain.props.encItemKey
    typeorm.authHash = domain.props.authHash
    typeorm.userUuid = domain.props.userUuid.value
    typeorm.deleted = !!domain.props.deleted
    typeorm.createdAt = domain.props.dates.createdAt
    typeorm.updatedAt = domain.props.dates.updatedAt
    typeorm.createdAtTimestamp = domain.props.timestamps.createdAt
    typeorm.updatedAtTimestamp = domain.props.timestamps.updatedAt
    typeorm.updatedWithSession = domain.props.updatedWithSession ? domain.props.updatedWithSession.value : null
    typeorm.lastEditedBy = domain.props.sharedVaultAssociation
      ? domain.props.sharedVaultAssociation.props.lastEditedBy.value
      : null
    typeorm.sharedVaultUuid = domain.props.sharedVaultAssociation
      ? domain.props.sharedVaultAssociation.props.sharedVaultUuid.value
      : null
    typeorm.keySystemIdentifier = domain.props.keySystemAssociation
      ? domain.props.keySystemAssociation.props.keySystemIdentifier
      : null

    return typeorm
  }
}
