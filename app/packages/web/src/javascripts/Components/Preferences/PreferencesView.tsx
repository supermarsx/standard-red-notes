import RoundIconButton from '@/Components/Button/RoundIconButton'
import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { PreferencesSessionController } from './Controller/PreferencesSessionController'
import PreferencesCanvas from './PreferencesCanvas'
import { PreferencesProps } from './PreferencesProps'
import { useAndroidBackHandler } from '@/NativeMobileWeb/useAndroidBackHandler'
import Modal, { ModalAction } from '../Modal/Modal'
import { classNames } from '@standardnotes/snjs'
import { useAvailableSafeAreaPadding } from '@/Hooks/useSafeAreaPadding'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import Icon from '../Icon/Icon'

const PreferencesView: FunctionComponent<PreferencesProps> = ({ application, closePreferences }) => {
  const menu = useMemo(
    () => new PreferencesSessionController(application, application.enableUnfinishedFeatures),
    [application],
  )

  useEffect(() => {
    menu.selectPane(application.preferencesController.currentPane)
  }, [menu, application.preferencesController.currentPane])

  const isMobileScreen = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  // Phone-only single-column flow: false shows the menu list, true shows the
  // selected pane's content. The desktop two-column layout ignores this entirely.
  const [mobileShowContent, setMobileShowContent] = useState(false)

  // Returning to the menu list resets the drill-in state. When not on a phone
  // this is effectively a no-op since both columns are always visible.
  useEffect(() => {
    if (!isMobileScreen) {
      setMobileShowContent(false)
    }
  }, [isMobileScreen])

  const showContent = useCallback(() => setMobileShowContent(true), [])
  const showMenu = useCallback(() => setMobileShowContent(false), [])

  const addAndroidBackHandler = useAndroidBackHandler()

  useEffect(() => {
    const removeListener = addAndroidBackHandler(() => {
      // On a phone, the hardware back button first returns from a pane's content
      // to the menu list before closing the whole preferences view.
      if (isMobileScreen && mobileShowContent) {
        setMobileShowContent(false)
        return true
      }
      closePreferences()
      return true
    })
    return () => {
      if (removeListener) {
        removeListener()
      }
    }
  }, [addAndroidBackHandler, closePreferences, isMobileScreen, mobileShowContent])

  const { hasTopInset } = useAvailableSafeAreaPadding()

  // On mobile the modal header's left action doubles as a "back" control: from a
  // pane it returns to the menu list; from the menu it closes preferences.
  const mobileBackAction = mobileShowContent ? showMenu : closePreferences
  const mobileTitle = mobileShowContent ? menu.selectedMenuItem?.label ?? 'Preferences' : 'Preferences'

  const modalActions = useMemo(
    (): ModalAction[] => [
      {
        label: (
          <span className="flex items-center">
            <Icon type="chevron-left" size="large" />
            {mobileShowContent ? 'Menu' : 'Back'}
          </span>
        ),
        type: 'primary',
        mobileSlot: 'left',
        onClick: mobileBackAction,
      },
    ],
    [mobileBackAction, mobileShowContent],
  )

  return (
    <Modal
      close={closePreferences}
      title={mobileTitle}
      className="flex flex-col"
      customHeader={
        <div
          className={classNames(
            'flex w-full flex-row items-center justify-between border-b border-solid border-border bg-default px-3 pb-2 md:p-3',
            hasTopInset ? 'pt-safe-top' : 'pt-2',
          )}
          data-preferences-header
        >
          <div className="hidden h-8 w-8 md:block" />
          <h1 className="text-base font-bold md:text-lg">Your preferences for Standard Red Notes</h1>
          <RoundIconButton
            onClick={() => {
              closePreferences()
            }}
            icon="close"
            label="Close preferences"
          />
        </div>
      }
      disableCustomHeader={isMobileScreen}
      actions={modalActions}
      customFooter={<></>}
    >
      <PreferencesCanvas
        menu={menu}
        application={application}
        closePreferences={closePreferences}
        mobileShowContent={mobileShowContent}
        onSelectPane={showContent}
      />
    </Modal>
  )
}

export default observer(PreferencesView)
