import SmartViewsSection from '@/Components/Tags/SmartViewsSection'
import TagsSection from '@/Components/Tags/TagsSection'
import { WebApplication } from '@/Application/WebApplication'
import { ApplicationEvent, PrefKey, WebAppEvent } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { forwardRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { classNames } from '@standardnotes/utils'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import RoundIconButton from '../Button/RoundIconButton'
import { PanelResizedData } from '@/Types/PanelResizedData'
import { PANEL_NAME_NAVIGATION } from '@/Constants/Constants'
import { PaneLayout } from '@/Controllers/PaneController/PaneLayout'
import { usePaneSwipeGesture } from '../Panes/usePaneGesture'
import { mergeRefs } from '@/Hooks/mergeRefs'
import { useAvailableSafeAreaPadding } from '@/Hooks/useSafeAreaPadding'
import QuickSettingsButton from '../Footer/QuickSettingsButton'
import VaultSelectionButton from '../Footer/VaultSelectionButton'
import PreferencesButton from '../Footer/PreferencesButton'
import TagSearchBar from './TagSearchBar'
import DashboardSectionButton from '../Dashboard/DashboardSectionButton'
import HomeSectionButton from '../Home/HomeSectionButton'
import NotificationsSectionButton from '../Notifications/NotificationsSectionButton'
import AggregateViewSectionButtons from '../AggregateViews/AggregateViewSectionButtons'
import ResearchSectionButton from '../Research/ResearchSectionButton'
import BookmarksSectionButton from '../Bookmarks/BookmarksSectionButton'
import TemplatesSectionButton from '../Templates/TemplatesSectionButton'
import FilesSectionButton from '../FilesView/FilesSectionButton'
import WorkflowsSectionButton from '../Workflows/WorkflowsSectionButton'
import { useLocalPreference } from '@/Hooks/usePreference'
import useIsTabletOrMobileScreen from '@/Hooks/useIsTabletOrMobileScreen'
import {
  NAVIGATION_MINI_CONTAINER_CLASS,
  NAVIGATION_MINI_DATA_ATTR,
  NAVIGATION_PANE_MINI_PREF_KEY,
  NavigationMiniContext,
} from './navigationMini'

type Props = {
  application: WebApplication
  className?: string
  children?: React.ReactNode
  id: string
}

const Navigation = forwardRef<HTMLDivElement, Props>(({ application, className, children, id }, ref) => {
  const { setPaneLayout, presentPane } = useResponsiveAppPane()
  const { t } = useTranslation('navigation')

  const [hasPasscode, setHasPasscode] = useState(() => application.hasPasscode())
  useEffect(() => {
    const removeObserver = application.addEventObserver(async () => {
      setHasPasscode(application.hasPasscode())
    }, ApplicationEvent.KeyStatusChanged)

    return removeObserver
  }, [application])

  useEffect(() => {
    return application.addWebEventObserver((event, data) => {
      if (event === WebAppEvent.PanelResized) {
        const { panel, width } = data as PanelResizedData
        if (panel === PANEL_NAME_NAVIGATION) {
          application.setPreference(PrefKey.TagsPanelWidth, width).catch(console.error)
        }
      }
    })
  }, [application])

  const [setElement] = usePaneSwipeGesture(
    'left',
    (element) => {
      setPaneLayout(PaneLayout.ItemSelection)
      element.style.left = '0'
    },
    {
      gesture: 'swipe',
    },
  )

  const { hasBottomInset } = useAvailableSafeAreaPadding()

  /**
   * Standard Red Notes: mini ("icon rail") mode. A device-local preference,
   * default OFF — see `navigationMini.ts` for why this is a preference and not a
   * role gate.
   *
   * Suppressed below the desktop breakpoint: on tablet and mobile the Navigation
   * pane is presented full-width (and on tablet it is removed from the pane stack
   * altogether), so a 48px icon rail there would be a strip of glyphs floating in
   * a 100%-wide column. The toggle that sets this preference is itself desktop-only
   * for the same reason.
   */
  const [miniPreference] = useLocalPreference(NAVIGATION_PANE_MINI_PREF_KEY)
  const { isTabletOrMobile } = useIsTabletOrMobileScreen()
  const isMini = miniPreference === true && !isTabletOrMobile

  /**
   * A text input is unusable at rail width, so the search bar is not rendered in
   * mini — except while a search is actually running, because hiding it then
   * would strand the user with a filtered tag list and no way to clear it.
   */
  const isSearchingTags = application.navigationController.isSearching

  return (
    <div
      id={id}
      className={classNames(
        className,
        'sn-component section pb-[50px] md:pb-0',
        'pt-safe-top h-full max-h-full overflow-hidden md:h-full md:max-h-full md:min-h-0',
        isMini && NAVIGATION_MINI_CONTAINER_CLASS,
      )}
      {...{ [NAVIGATION_MINI_DATA_ATTR]: isMini ? 'true' : 'false' }}
      ref={mergeRefs([ref, setElement])}
    >
      <NavigationMiniContext.Provider value={isMini}>
        <div id="navigation-content" className="flex-grow overflow-x-hidden overflow-y-auto">
          {(!isMini || isSearchingTags) && <TagSearchBar navigationController={application.navigationController} />}
          <HomeSectionButton application={application} />
          <NotificationsSectionButton application={application} />
          <DashboardSectionButton application={application} />
          <AggregateViewSectionButtons
            application={application}
            remindersLabel="Reminders"
            calendarLabel="Calendar"
            todosLabel="Todos"
          />
          <ResearchSectionButton application={application} />
          <BookmarksSectionButton application={application} />
          <TemplatesSectionButton application={application} />
          <FilesSectionButton application={application} />
          <WorkflowsSectionButton application={application} />
          <SmartViewsSection
            application={application}
            featuresController={application.featuresController}
            navigationController={application.navigationController}
          />
          <TagsSection />
        </div>
      </NavigationMiniContext.Provider>
      <div
        className={classNames(
          'border-border bg-contrast fixed bottom-0 flex min-h-[50px] w-full items-center border-t',
          'px-3.5 pt-2.5 md:hidden',
          hasBottomInset ? 'pb-safe-bottom' : 'pb-2.5',
        )}
      >
        <RoundIconButton
          className="bg-default mr-auto"
          onClick={() => {
            setPaneLayout(PaneLayout.ItemSelection)
          }}
          label={t('goToItemsList')}
          icon="chevron-left"
        />
        <RoundIconButton
          className="bg-default ml-2.5"
          onClick={() => {
            application.accountMenuController.toggleShow()
          }}
          label={t('goToAccountMenu')}
          icon="account-circle"
        />
        {hasPasscode && (
          <RoundIconButton
            id="lock-item"
            onClick={() => application.lock()}
            label="Locks application and wipes unencrypted data from memory."
            className="bg-default ml-2.5"
            icon="lock-filled"
          />
        )}
        <RoundIconButton
          className="bg-default ml-2.5"
          onClick={() => presentPane(AppPaneId.Assistant)}
          label="Open AI assistant"
          icon="dashboard"
        />
        <PreferencesButton openPreferences={() => application.preferencesController.openPreferences()} />
        <QuickSettingsButton application={application} isMobileNavigation />
        {application.featuresController.isVaultsEnabled() && <VaultSelectionButton isMobileNavigation />}
      </div>
      {children}
    </div>
  )
})

export default observer(Navigation)
