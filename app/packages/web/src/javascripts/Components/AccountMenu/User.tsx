import { observer } from 'mobx-react-lite'
import { User as UserType } from '@standardnotes/snjs'
import { useApplication } from '../ApplicationProvider'
import { useTranslation } from 'react-i18next'

const User = () => {
  const application = useApplication()
  const { t } = useTranslation('auth')

  const { server } = application.accountMenuController
  const user = application.sessions.getUser() as UserType

  return (
    <div className="sk-panel-section">
      {application.syncStatusController.errorMessage && (
        <div className="sk-notification danger">
          <div className="sk-notification-title">{t('syncUnreachable')}</div>
          <div className="sk-notification-text">
            {t('syncUnreachableMessage', { reason: application.syncStatusController.errorMessage })}
          </div>
        </div>
      )}
      <div className="sk-panel-row">
        <div className="sk-panel-column">
          <div className="sk-h1 sk-bold wrap">{user.email}</div>
          <div className="sk-subtitle neutral">{server}</div>
        </div>
      </div>
      <div className="sk-panel-row" />
    </div>
  )
}

export default observer(User)
