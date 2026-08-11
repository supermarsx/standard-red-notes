import { useApplication } from '@/Components/ApplicationProvider'
import {
  ContentType,
  DecryptedItemInterface,
  TrustedContactInterface,
  VaultListingInterface,
} from '@standardnotes/snjs'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { useStateRef } from './useStateRef'

type ItemVaultInfo = {
  vault?: VaultListingInterface
  lastEditedByContact?: TrustedContactInterface
  sharedByContact?: TrustedContactInterface
}

export const useItemVaultInfo = (item: DecryptedItemInterface | undefined): ItemVaultInfo => {
  const application = useApplication()

  const [vault, setVault] = useState<VaultListingInterface>()
  const vaultRef = useStateRef(vault)
  const [lastEditedByContact, setLastEditedByContact] = useState<TrustedContactInterface>()
  const [sharedByContact, setSharedByContact] = useState<TrustedContactInterface>()

  const updateInfo = useCallback(() => {
    if (!item || !application.featuresController.isVaultsEnabled()) {
      setVault(undefined)
      setLastEditedByContact(undefined)
      setSharedByContact(undefined)
      return
    }

    setVault(application.vaultDisplayService.getItemVault(item))
    setLastEditedByContact(application.sharedVaults.getItemLastEditedBy(item))
    setSharedByContact(application.sharedVaults.getItemSharedBy(item))
  }, [application.featuresController, application.sharedVaults, application.vaultDisplayService, item])

  useLayoutEffect(() => {
    updateInfo()
  }, [updateInfo])

  useEffect(() => {
    if (!item) {
      return
    }

    return application.items.streamItems(ContentType.TYPES.VaultListing, ({ changed, inserted }) => {
      const matchingItem = changed.concat(inserted).find((vault) => vault.uuid === vaultRef.current?.uuid)
      if (matchingItem) {
        setVault(matchingItem as VaultListingInterface)
      }
    })
  }, [application.items, item, vaultRef])

  useEffect(() => {
    if (!item) {
      return
    }

    return application.items.streamItems(ContentType.TYPES.Note, ({ changed }) => {
      const matchingItem = changed.find((note) => note.uuid === item.uuid)
      if (matchingItem) {
        updateInfo()
      }
    })
  }, [application.items, item, updateInfo])

  return {
    vault,
    lastEditedByContact,
    sharedByContact,
  }
}
