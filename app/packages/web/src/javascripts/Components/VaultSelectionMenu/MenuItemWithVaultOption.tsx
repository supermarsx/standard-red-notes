import { VaultListingInterface, classNames } from '@standardnotes/snjs'
import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'
import VaultOptionsMenu from './VaultOptionsMenu'
import Popover from '../Popover/Popover'

const VaultSelectMenuItemWithOptions = ({
  vault,
  children,
}: {
  vault: VaultListingInterface
  children: React.ReactNode
}) => {
  const { t } = useTranslation('sharing')
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false)
  const optionsButtonRef = useRef<HTMLButtonElement>(null)

  const toggleOptionsMenu = () => {
    setIsOptionsMenuOpen((open) => !open)
  }

  return (
    <div className="group focus-within:bg-info-backdrop flex items-center gap-3 px-3">
      {children}
      <button
        className={classNames(
          'border-border hover:bg-default focus:bg-default group-focus-within:bg-default flex-shrink-0 rounded-full border p-1',
          isOptionsMenuOpen && 'bg-default',
        )}
        onClick={toggleOptionsMenu}
        ref={optionsButtonRef}
      >
        <Icon type="more" size="small" />
      </button>
      <Popover
        title={t('vaultOptions')}
        open={isOptionsMenuOpen}
        anchorElement={optionsButtonRef}
        side="top"
        align="start"
        className="py-1"
        togglePopover={toggleOptionsMenu}
      >
        <VaultOptionsMenu vault={vault} />
      </Popover>
    </div>
  )
}

export default VaultSelectMenuItemWithOptions
