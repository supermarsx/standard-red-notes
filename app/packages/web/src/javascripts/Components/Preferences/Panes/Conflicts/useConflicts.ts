import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ContentType,
  ConflictResolutionStrategyValue,
  isErrorResponse,
  NoteMutator,
  PrefKey,
  SNNote,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

// The raw server-setting name for the conflict-resolution default. This is a
// string literal (not SettingName.NAMES) because the published @standardnotes/
// domain-core bundle the web client consumes does not carry Standard Red Notes'
// added setting names; it must match the server's SettingName.NAMES value exactly.
// See the same pattern in Components/Preferences/Panes/Admin/Admin.tsx.
const CONFLICT_RESOLUTION_STRATEGY_SETTING = 'CONFLICT_RESOLUTION_STRATEGY'

/**
 * A single sync-conflict pair: the original note and the conflicted copy that
 * the sync layer created (the copy carries `conflictOf === original.uuid`).
 *
 * "local" is the conflicted copy that was created on THIS device's last sync
 * (`conflictOf` set); "remote"/original is the surviving item. In Standard
 * Notes the duplicate is the locally-divergent content, so we treat the copy as
 * the local version and the original as the remote/server version for diffing.
 */
export type ConflictPair = {
  /** Stable identity for list keys: the conflicted copy uuid. */
  id: string
  original: SNNote
  conflictedCopy: SNNote
}

export type ConflictResolutionController = {
  pairs: ConflictPair[]
  count: number
  /** The raw stored client preference (what the strategy control should display). */
  clientStrategy: ConflictResolutionStrategyValue
  /** Effective default strategy: client pref wins, else server default, else 'ask'. */
  effectiveStrategy: ConflictResolutionStrategyValue
  serverDefaultStrategy: ConflictResolutionStrategyValue | undefined
  autoResolveEnabled: boolean
  setStrategy: (value: ConflictResolutionStrategyValue) => void
  setAutoResolveEnabled: (value: boolean) => void
  /** Keep the conflicted copy, delete the original. */
  keepLocal: (pair: ConflictPair) => Promise<void>
  /** Keep the original, delete the conflicted copy. */
  keepRemote: (pair: ConflictPair) => Promise<void>
  /** Leave both notes; just clear the conflict relationship on the copy. */
  keepBoth: (pair: ConflictPair) => Promise<void>
  /** Save merged title/text onto the original and delete the conflicted copy. */
  saveMerged: (pair: ConflictPair, mergedTitle: string, mergedText: string) => Promise<void>
}

const isStrategyValue = (value: string | undefined): value is ConflictResolutionStrategyValue =>
  value === 'ask' || value === 'keepBoth' || value === 'keepLocal' || value === 'keepRemote'

export const useConflicts = (application: WebApplication): ConflictResolutionController => {
  const [version, setVersion] = useState(0)
  const [serverDefaultStrategy, setServerDefaultStrategy] = useState<
    ConflictResolutionStrategyValue | undefined
  >(undefined)

  // Recompute the pair list whenever items change (e.g. after a resolution or a sync).
  useEffect(() => {
    const removeObserver = application.items.addObserver<SNNote>(ContentType.TYPES.Note, () => {
      setVersion((current) => current + 1)
    })
    return () => {
      removeObserver()
    }
  }, [application])

  // Read the server-provided default once. Failure is non-fatal: we simply fall
  // back to the client default ('ask'). We read it through the raw-string
  // getSetting path because the new setting name is not in the published
  // domain-core bundle's SettingName.NAMES (same constraint as Admin.tsx).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const user = application.sessions.getUser()
        if (!user) {
          return
        }
        const response = await application.legacyApi.getSetting(
          user.uuid,
          CONFLICT_RESOLUTION_STRATEGY_SETTING,
        )
        if (isErrorResponse(response)) {
          return
        }
        const value = (response as { data?: { setting?: { value?: string | null } } }).data?.setting?.value
        if (!cancelled && isStrategyValue(value ?? undefined)) {
          setServerDefaultStrategy(value as ConflictResolutionStrategyValue)
        }
      } catch {
        /* server default is optional; ignore */
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [application])

  const pairs = useMemo<ConflictPair[]>(() => {
    void version
    const notes = application.items.getItems<SNNote>(ContentType.TYPES.Note)
    const result: ConflictPair[] = []
    for (const note of notes) {
      if (!note.conflictOf) {
        continue
      }
      const original = application.items.findItem<SNNote>(note.conflictOf)
      if (!original) {
        // The original was deleted; there is nothing to compare against, so just
        // surface the copy paired with itself would be meaningless. Skip it.
        continue
      }
      result.push({ id: note.uuid, original, conflictedCopy: note })
    }
    return result
  }, [application, version])

  const clientStrategy = application.getPreference(
    PrefKey.ConflictResolutionStrategy,
    'ask',
  ) as ConflictResolutionStrategyValue

  // Precedence: an explicit client preference always wins. 'ask' is the neutral
  // default, so when the client pref is 'ask' we defer to the server default if
  // the server provided one; otherwise we keep 'ask'.
  const effectiveStrategy: ConflictResolutionStrategyValue =
    clientStrategy !== 'ask' ? clientStrategy : (serverDefaultStrategy ?? 'ask')

  const autoResolveEnabled = application.getPreference(PrefKey.ConflictResolutionAutoResolve, false)

  const setStrategy = useCallback(
    (value: ConflictResolutionStrategyValue) => {
      void application.setPreference(PrefKey.ConflictResolutionStrategy, value)
    },
    [application],
  )

  const setAutoResolveEnabled = useCallback(
    (value: boolean) => {
      void application.setPreference(PrefKey.ConflictResolutionAutoResolve, value)
    },
    [application],
  )

  const clearConflictRelationship = useCallback(
    async (copy: SNNote) => {
      await application.mutator.changeItem(copy, (mutator) => {
        mutator.conflictOf = undefined
      })
    },
    [application],
  )

  const keepLocal = useCallback(
    async (pair: ConflictPair) => {
      // Keep the conflicted copy as the survivor; clear its conflict flag and
      // delete the original.
      await clearConflictRelationship(pair.conflictedCopy)
      await application.mutator.deleteItem(pair.original)
      await application.sync.sync()
    },
    [application, clearConflictRelationship],
  )

  const keepRemote = useCallback(
    async (pair: ConflictPair) => {
      // Keep the original; delete the conflicted copy.
      await application.mutator.deleteItem(pair.conflictedCopy)
      await application.sync.sync()
    },
    [application],
  )

  const keepBoth = useCallback(
    async (pair: ConflictPair) => {
      // Leave both notes in place; just drop the conflict relationship so the
      // copy is no longer flagged as a "Conflicted Copy".
      await clearConflictRelationship(pair.conflictedCopy)
      await application.sync.sync()
    },
    [application, clearConflictRelationship],
  )

  const saveMerged = useCallback(
    async (pair: ConflictPair, mergedTitle: string, mergedText: string) => {
      // Write the merged content onto the original note, then delete the copy.
      await application.mutator.changeItem<NoteMutator, SNNote>(pair.original, (mutator) => {
        mutator.title = mergedTitle
        mutator.text = mergedText
      })
      await application.mutator.deleteItem(pair.conflictedCopy)
      await application.sync.sync()
    },
    [application],
  )

  return {
    pairs,
    count: pairs.length,
    clientStrategy,
    effectiveStrategy,
    serverDefaultStrategy,
    autoResolveEnabled,
    setStrategy,
    setAutoResolveEnabled,
    keepLocal,
    keepRemote,
    keepBoth,
    saveMerged,
  }
}
