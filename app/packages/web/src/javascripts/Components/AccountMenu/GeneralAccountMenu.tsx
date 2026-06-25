import { observer } from 'mobx-react-lite'
import Icon from '@/Components/Icon/Icon'
import Avatar from '@/Avatar/Avatar'
import { SyncQueueStrategy } from '@standardnotes/snjs'
import { STRING_GENERIC_SYNC_ERROR } from '@/Constants/Strings'
import { useCallback, useMemo, useState, FunctionComponent } from 'react'
import { AccountMenuPane } from './AccountMenuPane'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import WorkspaceSwitcherOption from './WorkspaceSwitcher/WorkspaceSwitcherOption'
import { WebApplicationGroup } from '@/Application/WebApplicationGroup'
import { formatLastSyncDate } from '@/Utils/DateUtils'
import Spinner from '@/Components/Spinner/Spinner'
import { MenuItemIconSize } from '@/Constants/TailwindClassNames'
import { useApplication } from '../ApplicationProvider'
import MenuSection from '../Menu/MenuSection'
import { TOGGLE_COMMAND_PALETTE, TOGGLE_KEYBOARD_SHORTCUTS_MODAL, isMobilePlatform } from '@standardnotes/ui-services'
import { KeyboardShortcutIndicator } from '../KeyboardShortcutIndicator/KeyboardShortcutIndicator'
import { useTranslation } from 'react-i18next'

type Props = {
  mainApplicationGroup: WebApplicationGroup
  setMenuPane: (pane: AccountMenuPane) => void
  closeMenu: () => void
}

const iconClassName = `text-neutral mr-2 ${MenuItemIconSize}`

const GeneralAccountMenu: FunctionComponent<Props> = ({ setMenuPane, closeMenu, mainApplicationGroup }) => {
  const application = useApplication()
  const { t } = useTranslation('auth')

  const [isSyncingInProgress, setIsSyncingInProgress] = useState(false)
  const [lastSyncDate, setLastSyncDate] = useState(formatLastSyncDate(application.sync.getLastSyncDate() as Date))

  const doSynchronization = useCallback(async () => {
    setIsSyncingInProgress(true)

    application.sync
      .sync({
        queueStrategy: SyncQueueStrategy.ForceSpawnNew,
        checkIntegrity: true,
      })
      .then((res) => {
        if (res && (res as { error?: unknown }).error) {
          throw new Error()
        } else {
          setLastSyncDate(formatLastSyncDate(application.sync.getLastSyncDate() as Date))
        }
      })
      .catch(() => {
        application.alerts.alert(STRING_GENERIC_SYNC_ERROR()).catch(console.error)
      })
      .finally(() => {
        setIsSyncingInProgress(false)
      })
  }, [application])

  const user = useMemo(() => application.sessions.getUser(), [application])

  const openPreferences = useCallback(() => {
    application.accountMenuController.closeAccountMenu()
    application.preferencesController.setCurrentPane('account')
    application.preferencesController.openPreferences()
  }, [application])

  const openHelp = useCallback(() => {
    application.accountMenuController.closeAccountMenu()
    application.preferencesController.setCurrentPane('help-feedback')
    application.preferencesController.openPreferences()
  }, [application])

  const signOut = useCallback(() => {
    application.accountMenuController.setSigningOut(true)
  }, [application])

  const activateRegisterPane = useCallback(() => {
    setMenuPane(AccountMenuPane.Register)
  }, [setMenuPane])

  const activateSignInPane = useCallback(() => {
    setMenuPane(AccountMenuPane.SignIn)
  }, [setMenuPane])

  const CREATE_ACCOUNT_INDEX = 1
  const SWITCHER_INDEX = 0

  const keyboardShortcutsHelpShortcut = useMemo(() => {
    return application.keyboardService.keyboardShortcutForCommand(TOGGLE_KEYBOARD_SHORTCUTS_MODAL)
  }, [application.keyboardService])
  const commandPaletteShortcut = useMemo(() => {
    return application.keyboardService.keyboardShortcutForCommand(TOGGLE_COMMAND_PALETTE)
  }, [application.keyboardService])

  return (
    <>
      <div className="mb-1 mt-1 hidden items-center justify-between px-4 md:flex md:px-3">
        <div className="text-lg font-bold lg:text-base">{t('account:account')}</div>
        <div className="flex cursor-pointer" onClick={closeMenu}>
          <Icon type="close" className="text-neutral" />
        </div>
      </div>
      {user ? (
        <>
          <div className="mb-3 flex items-center gap-3 px-4 text-lg text-foreground md:px-3 lg:text-sm">
            <Avatar email={user.email} size={40} />
            <div className="min-w-0">
              <div>{t('signedInAs')}</div>
              <div className="wrap my-0.5 font-bold">{user.email}</div>
              <span className="text-neutral">{application.getHost.execute().getValue()}</span>
            </div>
          </div>
          <div className="mb-2 flex items-start justify-between px-4 text-mobile-menu-item md:px-3 md:text-tablet-menu-item lg:text-menu-item">
            {isSyncingInProgress ? (
              <div className="flex items-center font-semibold text-info">
                <Spinner className="mr-2 h-5 w-5" />
                {t('syncing')}
              </div>
            ) : (
              <div className="flex items-start">
                <Icon type="check-circle" className={`mr-2 text-success ${MenuItemIconSize}`} />
                <div>
                  <div className="font-semibold text-success">{t('lastSynced')}</div>
                  <div className="text-text">{lastSyncDate}</div>
                </div>
              </div>
            )}
            <div className="flex cursor-pointer text-passive-1" onClick={doSynchronization}>
              <Icon type="sync" className={`${MenuItemIconSize}`} />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="mb-1 px-4 md:px-3">
            <div className="mb-3 text-base text-foreground lg:text-sm">
              {t('offlineSignInPrompt')}
            </div>
            <div className="flex items-center text-passive-1">
              <Icon type="cloud-off" className={`mr-2 ${MenuItemIconSize}`} />
              <span className="text-lg font-semibold lg:text-sm">{t('offline')}</span>
            </div>
          </div>
        </>
      )}
      <Menu
        a11yLabel={t('generalAccountMenuLabel')}
        closeMenu={closeMenu}
        initialFocus={!application.hasAccount() ? CREATE_ACCOUNT_INDEX : SWITCHER_INDEX}
      >
        <MenuSection className="md:border-t md:pt-2">
          <WorkspaceSwitcherOption mainApplicationGroup={mainApplicationGroup} />
        </MenuSection>
        <MenuSection>
          {user ? (
            <MenuItem onClick={openPreferences}>
              <Icon type="user" className={iconClassName} />
              {t('accountSettings')}
            </MenuItem>
          ) : (
            <>
              <MenuItem onClick={activateRegisterPane}>
                <Icon type="user" className={iconClassName} />
                {t('createFreeAccount')}
              </MenuItem>
              <MenuItem onClick={activateSignInPane}>
                <Icon type="signIn" className={iconClassName} />
                {t('account:signIn')}
              </MenuItem>
            </>
          )}
          <MenuItem
            onClick={() => {
              application.exportModalController.setIsVisible(true)
              application.accountMenuController.closeAccountMenu()
            }}
          >
            <Icon type="download" className={iconClassName} />
            {t('common:export')}
          </MenuItem>
          <MenuItem
            onClick={() => {
              application.importModalController.setIsVisible(true)
              application.accountMenuController.closeAccountMenu()
            }}
          >
            <Icon type="archive" className={iconClassName} />
            {t('common:import')}
          </MenuItem>
          <MenuItem className="justify-between" onClick={openHelp}>
            <div className="flex items-center">
              <Icon type="help" className={iconClassName} />
              {t('documentation')}
            </div>
            <span className="text-neutral">v{application.version}</span>
          </MenuItem>
          {!isMobilePlatform(application.platform) && (
            <>
              <MenuItem
                onClick={() => {
                  application.keyboardService.triggerCommand(TOGGLE_KEYBOARD_SHORTCUTS_MODAL)
                }}
              >
                <Icon type="keyboard" className={iconClassName} />
                {t('keyboardShortcuts')}
                {keyboardShortcutsHelpShortcut && (
                  <KeyboardShortcutIndicator shortcut={keyboardShortcutsHelpShortcut} className="ml-auto" />
                )}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  application.keyboardService.triggerCommand(TOGGLE_COMMAND_PALETTE)
                }}
              >
                <Icon type="info" className={iconClassName} />
                {t('commandPalette')}
                {commandPaletteShortcut && (
                  <KeyboardShortcutIndicator shortcut={commandPaletteShortcut} className="ml-auto" />
                )}
              </MenuItem>
            </>
          )}
        </MenuSection>
        {user ? (
          <MenuSection>
            <MenuItem onClick={signOut}>
              <Icon type="signOut" className={iconClassName} />
              {t('signOutWorkspace')}
            </MenuItem>
          </MenuSection>
        ) : null}
      </Menu>
    </>
  )
}

export default observer(GeneralAccountMenu)
