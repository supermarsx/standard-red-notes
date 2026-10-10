import { ContentFilter } from '../SaveRule/ContentFilter'
import { ContentTypeFilter } from '../SaveRule/ContentTypeFilter'
import { OwnershipFilter } from '../SaveRule/OwnershipFilter'
import { SharedVaultFilter } from '../SaveRule/SharedVaultFilter'
import { SharedVaultSnjsFilter } from '../SaveRule/SharedVaultSnjsFilter'
import { TimeDifferenceFilter } from '../SaveRule/TimeDifferenceFilter'
import { ItemSaveValidator } from './ItemSaveValidator'

export type ItemSaveRuleSet = {
  ownershipFilter: OwnershipFilter
  sharedVaultFilter: SharedVaultFilter
  timeDifferenceFilter: TimeDifferenceFilter
  contentTypeFilter: ContentTypeFilter
  contentFilter: ContentFilter
  sharedVaultSnjsFilter: SharedVaultSnjsFilter
}

/**
 * The production save-rule ORDER, in one place a test can reach.
 *
 * `ItemSaveValidator` stops at the FIRST rule that fails and reports that
 * rule's conflict, so the order does not decide whether a save is allowed --
 * every rule still has to pass -- but it does decide WHICH REASON the client is
 * given when a save breaks more than one rule at once.
 *
 * AUTHORIZATION BEFORE FRESHNESS. `TimeDifferenceFilter` used to run before
 * `SharedVaultFilter`, so a read-only shared-vault member whose local copy was
 * also stale was told `sync_conflict` instead of
 * `shared_vault_insufficient_permissions_error`. The save was refused either
 * way -- it fails safe, and this is a message-accuracy change, not a security
 * one -- but "conflicting data" sends a client into conflict resolution and a
 * human into the wrong half of the system. It cost exactly that: a live
 * collaboration probe scored a read-only member "refused" for the wrong reason
 * and had to start echoing the server's `updated_at_timestamp` to stop the
 * time rule answering the permission question.
 *
 * Reordering is SAFE in the only direction that matters: because the validator
 * requires every rule to pass, moving a rule earlier can never turn a refusal
 * into an acceptance. It can only change which of several simultaneous
 * violations is named, and "you do not have permission" is the more useful and
 * more accurate of the two -- a stale revision is a consequence of not being
 * allowed to write, not the reason.
 *
 * `OwnershipFilter` stays first and already defers to `SharedVaultFilter` for
 * anything vault-associated, so the two authorization rules now sit together,
 * ahead of the freshness and shape rules. `SharedVaultSnjsFilter` stays last:
 * it is a client-capability refusal, the least specific answer of the six.
 */
export const ITEM_SAVE_RULE_ORDER: ReadonlyArray<keyof ItemSaveRuleSet> = [
  'ownershipFilter',
  'sharedVaultFilter',
  'timeDifferenceFilter',
  'contentTypeFilter',
  'contentFilter',
  'sharedVaultSnjsFilter',
]

/**
 * Built FROM `ITEM_SAVE_RULE_ORDER`, not alongside it, so the list a test
 * asserts and the list the server runs cannot drift apart.
 */
export function createItemSaveValidator(rules: ItemSaveRuleSet): ItemSaveValidator {
  return new ItemSaveValidator(ITEM_SAVE_RULE_ORDER.map((name) => rules[name]))
}
