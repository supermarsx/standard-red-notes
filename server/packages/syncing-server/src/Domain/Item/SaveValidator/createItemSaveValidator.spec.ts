import {
  ContentType,
  Dates,
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'
import { ConflictType } from '@standardnotes/responses'
import { TimerInterface } from '@standardnotes/time'

import { Item } from '../Item'
import { ItemHash } from '../ItemHash'
import { SharedVaultAssociation } from '../../SharedVault/SharedVaultAssociation'
import { SharedVaultOperationOnItem } from '../../SharedVault/SharedVaultOperationOnItem'
import { SharedVaultUserRepositoryInterface } from '../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { DetermineSharedVaultOperationOnItem } from '../../UseCase/SharedVaults/DetermineSharedVaultOperationOnItem/DetermineSharedVaultOperationOnItem'
import { ContentFilter } from '../SaveRule/ContentFilter'
import { ContentTypeFilter } from '../SaveRule/ContentTypeFilter'
import { OwnershipFilter } from '../SaveRule/OwnershipFilter'
import { SharedVaultFilter } from '../SaveRule/SharedVaultFilter'
import { SharedVaultSnjsFilter } from '../SaveRule/SharedVaultSnjsFilter'
import { TimeDifferenceFilter } from '../SaveRule/TimeDifferenceFilter'
import { ItemSaveValidator } from './ItemSaveValidator'
import { ITEM_SAVE_RULE_ORDER, createItemSaveValidator } from './createItemSaveValidator'

// ---------------------------------------------------------------------------
// WHICH REFUSAL A READ-ONLY MEMBER IS TOLD.
//
// `TimeDifferenceFilter` ran before `SharedVaultFilter`, so a read-only
// shared-vault member whose local copy was also stale was answered
// `sync_conflict` -- "conflicting data", which sends a client into conflict
// resolution and a human looking for a sync bug -- instead of
// `shared_vault_insufficient_permissions_error`. The save was refused either
// way, so this is message accuracy and not a security hole; it is also exactly
// the kind of wrong signpost that makes a plumbing problem look like a
// permission setting, which is the whole reason this lane is being audited.
//
// These run the REAL six filters through the REAL production order, so the
// assertion is about the composition and not about a mock.
// ---------------------------------------------------------------------------

const OWNER = '00000000-0000-0000-0000-000000000000'
const MEMBER = '11111111-1111-1111-1111-111111111111'
const VAULT = '22222222-2222-2222-2222-222222222222'
const SERVER_REVISION = 1_616_164_633_241_311
const STALE_REVISION = 1_000_000_000_000_000

function timer(): TimerInterface {
  return {
    convertStringDateToMicroseconds: jest.fn(() => 0),
  } as unknown as TimerInterface
}

function vaultItem(): Item {
  return Item.create(
    {
      userUuid: Uuid.create(OWNER).getValue(),
      updatedWithSession: null,
      content: 'foobar',
      contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
      encItemKey: null,
      authHash: null,
      itemsKeyId: null,
      duplicateOf: null,
      deleted: false,
      dates: Dates.create(new Date(SERVER_REVISION), new Date(SERVER_REVISION)).getValue(),
      timestamps: Timestamps.create(SERVER_REVISION, SERVER_REVISION).getValue(),
      sharedVaultAssociation: SharedVaultAssociation.create({
        lastEditedBy: Uuid.create(OWNER).getValue(),
        sharedVaultUuid: Uuid.create(VAULT).getValue(),
      }).getValue(),
    },
    new UniqueEntityId(OWNER),
  ).getValue()
}

/** An incoming save whose `updated_at_timestamp` is OLDER than the server's. */
function staleVaultSave(): ItemHash {
  return ItemHash.create({
    uuid: '33333333-3333-3333-3333-333333333333',
    content_type: ContentType.TYPES.Note,
    user_uuid: MEMBER,
    content: 'new content',
    created_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-01T00:00:00.000Z',
    created_at_timestamp: STALE_REVISION,
    updated_at_timestamp: STALE_REVISION,
    key_system_identifier: 'key-system-identifier',
    shared_vault_uuid: VAULT,
  }).getValue()
}

function harness(permission: string) {
  const existingItem = vaultItem()
  const itemHash = staleVaultSave()

  const determineSharedVaultOperationOnItem = {
    execute: jest.fn(async () =>
      Result.ok(
        SharedVaultOperationOnItem.create({
          type: SharedVaultOperationOnItem.TYPES.SaveToSharedVault,
          userUuid: Uuid.create(MEMBER).getValue(),
          sharedVaultUuid: Uuid.create(VAULT).getValue(),
          incomingItemHash: itemHash,
          existingItem,
        }).getValue(),
      ),
    ),
  } as unknown as DetermineSharedVaultOperationOnItem

  const sharedVaultUserRepository = {
    findByUserUuidAndSharedVaultUuid: jest.fn(async () =>
      SharedVaultUser.create({
        permission: SharedVaultUserPermission.create(permission).getValue(),
        sharedVaultUuid: Uuid.create(VAULT).getValue(),
        userUuid: Uuid.create(MEMBER).getValue(),
        timestamps: Timestamps.create(123, 123).getValue(),
        isDesignatedSurvivor: false,
      }).getValue(),
    ),
    findBySharedVaultUuid: jest.fn(async () => []),
  } as unknown as SharedVaultUserRepositoryInterface

  const sharedVaultFilter = new SharedVaultFilter(determineSharedVaultOperationOnItem, sharedVaultUserRepository)
  const validator = createItemSaveValidator({
    ownershipFilter: new OwnershipFilter(),
    sharedVaultFilter,
    timeDifferenceFilter: new TimeDifferenceFilter(timer()),
    contentTypeFilter: new ContentTypeFilter(),
    contentFilter: new ContentFilter(),
    sharedVaultSnjsFilter: new SharedVaultSnjsFilter(),
  })

  return {
    validator,
    sharedVaultFilter,
    dto: {
      apiVersion: '20200115',
      userUuid: MEMBER,
      itemHash,
      existingItem,
      snjsVersion: '2.200.0',
    },
  }
}

describe('createItemSaveValidator', () => {
  it('names the authorization rules before the freshness rule', () => {
    // The order is data, so the invariant can be stated without six
    // collaborators. `createItemSaveValidator` is BUILT from this list, so the
    // list and the server cannot disagree.
    expect(ITEM_SAVE_RULE_ORDER.indexOf('sharedVaultFilter')).toBeLessThan(
      ITEM_SAVE_RULE_ORDER.indexOf('timeDifferenceFilter'),
    )
    expect(ITEM_SAVE_RULE_ORDER).toEqual([
      'ownershipFilter',
      'sharedVaultFilter',
      'timeDifferenceFilter',
      'contentTypeFilter',
      'contentFilter',
      'sharedVaultSnjsFilter',
    ])
  })

  it('builds the validator from that exact order', async () => {
    const calls: string[] = []
    const rule = (name: string, passed: boolean) => ({
      check: jest.fn(async () => {
        calls.push(name)
        return { passed }
      }),
    })
    const validator = createItemSaveValidator({
      ownershipFilter: rule('ownershipFilter', true) as unknown as OwnershipFilter,
      sharedVaultFilter: rule('sharedVaultFilter', true) as unknown as SharedVaultFilter,
      timeDifferenceFilter: rule('timeDifferenceFilter', true) as unknown as TimeDifferenceFilter,
      contentTypeFilter: rule('contentTypeFilter', true) as unknown as ContentTypeFilter,
      contentFilter: rule('contentFilter', true) as unknown as ContentFilter,
      sharedVaultSnjsFilter: rule('sharedVaultSnjsFilter', true) as unknown as SharedVaultSnjsFilter,
    })

    await validator.validate(harness(SharedVaultUserPermission.PERMISSIONS.Write).dto)

    expect(calls).toEqual([...ITEM_SAVE_RULE_ORDER])
  })

  it('tells a READ-ONLY member with a STALE copy that it has no permission, not that the data conflicts', async () => {
    const { validator, dto } = harness(SharedVaultUserPermission.PERMISSIONS.Read)

    const result = await validator.validate(dto)

    expect(result.passed).toBe(false)
    expect(result.conflict?.type).toBe(ConflictType.SharedVaultInsufficientPermissionsError)
    // The regression, stated as the thing that must NOT happen.
    expect(result.conflict?.type).not.toBe(ConflictType.ConflictingData)
  })

  it('CONTROL: the same stale save by a WRITE member still answers sync_conflict', async () => {
    // Without this, the assertion above would pass just as happily on a
    // validator that had stopped running the time rule at all.
    const { validator, dto } = harness(SharedVaultUserPermission.PERMISSIONS.Write)

    const result = await validator.validate(dto)

    expect(result.passed).toBe(false)
    expect(result.conflict?.type).toBe(ConflictType.ConflictingData)
  })

  it('CONTROL: a FRESH read-only save is still refused for permission', async () => {
    // Proves the permission refusal is not an artifact of the staleness.
    const { validator, dto } = harness(SharedVaultUserPermission.PERMISSIONS.Read)
    const fresh = ItemHash.create({
      ...dto.itemHash.props,
      updated_at_timestamp: SERVER_REVISION,
    }).getValue()

    const result = await validator.validate({ ...dto, itemHash: fresh })

    expect(result.passed).toBe(false)
    expect(result.conflict?.type).toBe(ConflictType.SharedVaultInsufficientPermissionsError)
  })

  it('CONTROL: a FRESH write save passes every rule', async () => {
    // The positive control for the whole composition: without it, every
    // refusal above could be a validator that refuses everything.
    const { validator, dto } = harness(SharedVaultUserPermission.PERMISSIONS.Write)
    const fresh = ItemHash.create({
      ...dto.itemHash.props,
      updated_at_timestamp: SERVER_REVISION,
    }).getValue()

    const result = await validator.validate({ ...dto, itemHash: fresh })

    expect(result).toEqual({ passed: true })
  })

  it('reordering changes WHICH refusal is named and nothing about WHETHER a save is allowed', async () => {
    // The safety argument for the reorder, asserted rather than claimed.
    // `ItemSaveValidator` returns at the FIRST failing rule and requires all of
    // them to pass, so under any permutation the pass/fail verdict is identical
    // and only the named conflict moves. Both orders are built here -- the
    // production one and the one it replaced -- and compared on the same four
    // inputs.
    const inputs: Array<[string, string, boolean]> = [
      ['stale read-only', SharedVaultUserPermission.PERMISSIONS.Read, true],
      ['fresh read-only', SharedVaultUserPermission.PERMISSIONS.Read, false],
      ['stale write', SharedVaultUserPermission.PERMISSIONS.Write, true],
      ['fresh write', SharedVaultUserPermission.PERMISSIONS.Write, false],
    ]
    const build = (permission: string, authorizationFirst: boolean) => {
      const { dto } = harness(permission)
      const shared = harness(permission)
      const set = {
        ownershipFilter: new OwnershipFilter(),
        sharedVaultFilter: shared.sharedVaultFilter,
        timeDifferenceFilter: new TimeDifferenceFilter(timer()),
        contentTypeFilter: new ContentTypeFilter(),
        contentFilter: new ContentFilter(),
        sharedVaultSnjsFilter: new SharedVaultSnjsFilter(),
      }
      return {
        dto,
        validator: authorizationFirst
          ? createItemSaveValidator(set)
          : // The ORDER THIS REPLACED, assembled directly.
            new ItemSaveValidator([
              set.ownershipFilter,
              set.timeDifferenceFilter,
              set.contentTypeFilter,
              set.contentFilter,
              set.sharedVaultFilter,
              set.sharedVaultSnjsFilter,
            ]),
      }
    }

    for (const [label, permission, stale] of inputs) {
      const now = build(permission, true)
      const before = build(permission, false)
      const itemHash = stale
        ? now.dto.itemHash
        : ItemHash.create({ ...now.dto.itemHash.props, updated_at_timestamp: SERVER_REVISION }).getValue()

      const after = await now.validator.validate({ ...now.dto, itemHash })
      const previously = await before.validator.validate({ ...before.dto, itemHash })

      expect([label, after.passed]).toEqual([label, previously.passed])
    }

    // And the one input whose NAMED refusal the reorder is for.
    const now = build(SharedVaultUserPermission.PERMISSIONS.Read, true)
    const before = build(SharedVaultUserPermission.PERMISSIONS.Read, false)
    expect((await now.validator.validate(now.dto)).conflict?.type).toBe(
      ConflictType.SharedVaultInsufficientPermissionsError,
    )
    expect((await before.validator.validate(before.dto)).conflict?.type).toBe(ConflictType.ConflictingData)
  })
})
