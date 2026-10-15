import { useApplication } from '@/Components/ApplicationProvider'
import {
  ContentType,
  DecryptedItemInterface,
  TrustedContactInterface,
  VaultListingInterface,
} from '@standardnotes/snjs'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const confirmedEditor = useRef<{ scope: string; contact: TrustedContactInterface } | undefined>(undefined)

  const updateInfo = useCallback(
    (current = item) => {
      if (!current || !application.featuresController.isVaultsEnabled()) {
        confirmedEditor.current = undefined
        setVault(undefined)
        setLastEditedByContact(undefined)
        setSharedByContact(undefined)
        return
      }

      const nextVault = application.vaultDisplayService.getItemVault(current)
      const scope = JSON.stringify([
        current.uuid,
        nextVault?.uuid,
        current.shared_vault_uuid,
        current.key_system_identifier,
        current.user_uuid,
      ])
      let editor = application.sharedVaults.getItemLastEditedBy(current)
      if (editor) {
        confirmedEditor.current = { scope, contact: editor }
      } else if (current.dirty && !current.last_edited_by_uuid && confirmedEditor.current?.scope === scope) {
        // Dirtying mutations intentionally clear server attribution until the
        // acknowledgement arrives. Keep the last CONFIRMED editor during that gap.
        editor = confirmedEditor.current.contact
      } else {
        confirmedEditor.current = undefined
      }
      setVault(nextVault)
      setLastEditedByContact(editor)
      setSharedByContact(application.sharedVaults.getItemSharedBy(current))
    },
    [application.featuresController, application.sharedVaults, application.vaultDisplayService, item],
  )

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
        updateInfo(matchingItem)
      }
    })
  }, [application.items, item, updateInfo])

  return {
    vault,
    lastEditedByContact,
    sharedByContact,
  }
}
