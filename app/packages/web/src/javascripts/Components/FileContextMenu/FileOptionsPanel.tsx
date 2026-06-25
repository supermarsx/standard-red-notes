import { useCallback, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import FileMenuOptions from './FileMenuOptions'
import Popover from '../Popover/Popover'
import RoundIconButton from '../Button/RoundIconButton'
import Menu from '../Menu/Menu'
import { ItemListController } from '@/Controllers/ItemList/ItemListController'
import { useTranslation } from 'react-i18next'

type Props = {
  itemListController: ItemListController
}

const FilesOptionsPanel = ({ itemListController }: Props) => {
  const { t } = useTranslation('files')
  const [isOpen, setIsOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const toggleMenu = useCallback(() => setIsOpen((isOpen) => !isOpen), [])

  return (
    <>
      <RoundIconButton label={t('fileOptionsMenu')} onClick={toggleMenu} ref={buttonRef} icon="more" />
      <Popover
        title={t('fileOptions')}
        togglePopover={toggleMenu}
        anchorElement={buttonRef}
        open={isOpen}
        className="md:pb-2"
      >
        <Menu a11yLabel={t('fileOptionsPanel')}>
          <FileMenuOptions
            selectedFiles={itemListController.selectedFiles}
            closeMenu={() => {
              setIsOpen(false)
            }}
            shouldShowAttachOption={false}
            shouldShowRenameOption={false}
          />
        </Menu>
      </Popover>
    </>
  )
}

export default observer(FilesOptionsPanel)
