import { FunctionComponent } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'
import { VaultListingInterface } from '@standardnotes/snjs'

type Props = {
  vault: VaultListingInterface
}

const VaultNameBadge: FunctionComponent<Props> = ({ vault }) => {
  const { t } = useTranslation('sharing')
  return (
    <div title={t('vaultName')} className="border-passive-2 flex items-center rounded border px-1.5 py-1 select-none">
      <Icon ariaLabel={t('sharedInVault')} type={vault.iconString} className="mr-1" size="medium" emojiSize="small" />
      <span className="mr-auto overflow-hidden text-sm font-semibold text-ellipsis lg:text-xs">{vault.name}</span>
    </div>
  )
}

export default VaultNameBadge
