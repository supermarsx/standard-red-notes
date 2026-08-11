import { WebApplication } from '@/Application/WebApplication'
import {
  ApplicationEvent,
  ContentType,
  DecryptedItem,
  VaultListingInterface,
  VaultLockServiceEvent,
} from '@standardnotes/snjs'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * Keeps render authorization live across both UI-protection sessions and vault
 * lifecycle boundaries. A removed item is denied directly: resolving its stale
 * key-system identifier to a still-existing listing must not keep cached content
 * visible while controller cleanup catches up.
 */
export function useItemAuthorization(application: WebApplication, item: DecryptedItem | undefined): boolean {
  const getSnapshot = useCallback(
    () => (item ? application.isAuthorizedToRenderItem(item) : false),
    [application, item],
  )
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const disposeApplicationEvents = application.addEventObserver(async (event) => {
        if (
          event === ApplicationEvent.UnprotectedSessionBegan ||
          event === ApplicationEvent.UnprotectedSessionExpired
        ) {
          onStoreChange()
        }
      })
      const disposeVaultLocks = application.vaultLocks.addEventObserver((event) => {
        if (event === VaultLockServiceEvent.VaultLocked || event === VaultLockServiceEvent.VaultUnlocked) {
          onStoreChange()
        }
      })
      const disposeVaultListings = application.items.streamItems<VaultListingInterface>(
        ContentType.TYPES.VaultListing,
        ({ changed, inserted, removed }) => {
          if (changed.length > 0 || inserted.length > 0 || removed.length > 0) {
            onStoreChange()
          }
        },
      )
      const disposeItem = item
        ? application.items.streamItems<DecryptedItem>(item.content_type, ({ changed, inserted, removed }) => {
            if ([...changed, ...inserted, ...removed].some((candidate) => candidate.uuid === item.uuid)) {
              onStoreChange()
            }
          })
        : undefined

      return () => {
        disposeApplicationEvents()
        disposeVaultLocks()
        disposeVaultListings()
        disposeItem?.()
      }
    },
    [application, item],
  )

  // React re-reads the authoritative snapshot immediately after subscribing,
  // closing the render-to-effect window in which a lock/removal could be missed.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
