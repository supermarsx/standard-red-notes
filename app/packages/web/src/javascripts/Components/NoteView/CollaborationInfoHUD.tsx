import { FunctionComponent } from 'react'
import { SNNote } from '@standardnotes/snjs'
import VaultNameBadge from '../Vaults/VaultNameBadge'
import LastEditedByBadge from '../Vaults/LastEditedByBadge'
import { useItemVaultInfo } from '@/Hooks/useItemVaultInfo'

type Props = {
  item: SNNote
}

/**
 * The note's vault and last editor, as badges under the title on small screens
 * (wider screens show the same two badges in the linked-items row).
 *
 * Who is in the note, and who it is shared with, is NOT here: that is the
 * collaboration control in the title bar's status row, on every screen size.
 */
const CollaborationInfoHUD: FunctionComponent<Props> = ({ item }) => {
  const { vault, lastEditedByContact } = useItemVaultInfo(item)

  if (!vault) {
    return null
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      <VaultNameBadge vault={vault} />
      {(vault.sharing || lastEditedByContact) && <LastEditedByBadge contact={lastEditedByContact} />}
    </div>
  )
}

export default CollaborationInfoHUD
