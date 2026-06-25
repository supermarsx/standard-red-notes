import Icon from '@/Components/Icon/Icon'
import { AccountMenuController } from '@/Controllers/AccountMenu/AccountMenuController'
import { NoAccountWarningController } from '@/Controllers/NoAccountWarningController'
import { observer } from 'mobx-react-lite'
import { MouseEventHandler, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import Button from '@/Components/Button/Button'

type Props = {
  accountMenuController: AccountMenuController
  noAccountWarningController: NoAccountWarningController
}

const NoAccountWarningContent = ({ accountMenuController, noAccountWarningController }: Props) => {
  const { t } = useTranslation('auth')

  const showAccountMenu: MouseEventHandler = useCallback(
    (event) => {
      event.stopPropagation()
      accountMenuController.setShow(true)
    },
    [accountMenuController],
  )

  const hideWarning = useCallback(() => {
    noAccountWarningController.hide()
  }, [noAccountWarningController])

  return (
    <div className="mt-4 grid grid-cols-1 rounded-md border border-border p-4">
      <h1 className="sk-h3 m-0 text-base font-semibold lg:text-sm">{t('dataNotBackedUp')}</h1>
      <p className="col-start-1 col-end-3 m-0 mt-1 text-base lg:text-sm">{t('signInOrRegisterToSync')}</p>
      <Button
        primary
        small
        className="col-start-1 col-end-3 mt-3 justify-self-start uppercase"
        onClick={showAccountMenu}
      >
        {t('openAccountMenu')}
      </Button>
      <button
        onClick={hideWarning}
        title={t('ignoreWarning')}
        aria-label={t('ignoreWarning')}
        style={{ height: '20px' }}
        className="col-start-2 row-start-1 m-0 cursor-pointer rounded-md border-0 bg-transparent p-0 text-neutral hover:text-info"
      >
        <Icon type="close" className="block" />
      </button>
    </div>
  )
}

export default observer(NoAccountWarningContent)
