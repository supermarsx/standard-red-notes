import { VaultListingInterface } from '@standardnotes/snjs'
import Menu from '../Menu/Menu'
import MenuItem from '../Menu/MenuItem'
import Icon from '../Icon/Icon'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import EditVaultModal from '../Preferences/Panes/Vaults/Vaults/VaultModal/EditVaultModal'
import { useVault } from '@/Hooks/useVault'

type Props = {
  vault: VaultListingInterface
}

const VaultOptionsMenu = ({ vault }: Props) => {
  const { t } = useTranslation('sharing')
  const { canShowLockOption, isLocked, toggleLock, ensureVaultIsUnlocked } = useVault(vault)

  const [isVaultModalOpen, setIsVaultModalOpen] = useState(false)
  const openEditModal = useCallback(async () => {
    if (!(await ensureVaultIsUnlocked())) {
      return
    }

    setIsVaultModalOpen(true)
  }, [ensureVaultIsUnlocked])

  return (
    <>
      <Menu a11yLabel={t('vaultOptionsMenu')}>
        <MenuItem onClick={openEditModal}>
          <Icon type="pencil-filled" className="mr-2" />
          {t('editVault')}
        </MenuItem>
        {canShowLockOption && (
          <MenuItem onClick={toggleLock}>
            <Icon type="lock" className="mr-2" />
            {isLocked ? t('unlockVault') : t('lockVault')}
          </MenuItem>
        )}
      </Menu>
      <EditVaultModal
        vault={vault}
        isVaultModalOpen={isVaultModalOpen}
        closeVaultModal={() => setIsVaultModalOpen(false)}
      />
    </>
  )
}

export default VaultOptionsMenu
