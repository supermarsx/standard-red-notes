import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { CheckForContentLimitDTO } from './CheckForContentLimitDTO'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemHash } from '../../../Item/ItemHash'

export class CheckForContentLimit implements UseCaseInterface<void> {
  constructor(
    private itemRepository: ItemRepositoryInterface,
    private freeUserContentLimitInBytes: number,
  ) {}

  async execute(dto: CheckForContentLimitDTO): Promise<Result<void>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    // Compute the user's total non-deleted content size with a SQL SUM aggregate
    // instead of materializing every content-size descriptor row. This keeps the
    // quota decision identical while turning an unbounded full scan into an O(1)-ish
    // aggregate for content-limited (free) users.
    const totalContentSize = await this.itemRepository.sumContentSizeForComputingTransferLimit({
      userUuid: userUuid.value,
      deleted: false,
    })

    const isContentLimitExceeded = totalContentSize > this.freeUserContentLimitInBytes

    // The decision is `limitExceeded && modificationsIncreaseSize`. If the limit is
    // not exceeded the result is always ok, so we can skip the per-item lookup below.
    if (!isContentLimitExceeded) {
      return Result.ok()
    }

    const isUserModificationsIncreasingContentSize = await this.userModificationsAreIncreasingContentSize(
      userUuid,
      dto.itemsBeingModified,
    )

    if (isUserModificationsIncreasingContentSize) {
      return Result.fail('You have exceeded your content limit. Please upgrade your account.')
    }

    return Result.ok()
  }

  private async userModificationsAreIncreasingContentSize(userUuid: Uuid, itemHashes: ItemHash[]): Promise<boolean> {
    if (itemHashes.length === 0) {
      return false
    }

    // Only the items actually being modified need their pre-modification size, so
    // fetch descriptors for just those uuids rather than the whole account.
    const contentSizeDescriptors = await this.itemRepository.findContentSizeForComputingTransferLimit({
      userUuid: userUuid.value,
      deleted: false,
      uuids: itemHashes.map((itemHash) => itemHash.props.uuid),
    })

    for (const itemHash of itemHashes) {
      const contentSizeDescriptor = contentSizeDescriptors.find(
        (descriptor) => descriptor.props.uuid.value === itemHash.props.uuid,
      )
      if (contentSizeDescriptor) {
        const afterModificationSize = itemHash.calculateContentSize()
        const beforeModificationSize = contentSizeDescriptor.props.contentSize ?? 0
        if (afterModificationSize > beforeModificationSize) {
          return true
        }
      }
    }

    return false
  }
}
