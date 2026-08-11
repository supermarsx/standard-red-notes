import { WebApplication } from '@/Application/WebApplication'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../../Icon/Icon'
import { classNames } from '@standardnotes/utils'
import Popover from '@/Components/Popover/Popover'
import DisplayOptionsMenu from './DisplayOptionsMenu'
import { NavigationMenuButton } from '@/Components/NavigationMenu/NavigationMenu'
import { ApplicationEvent, isTag, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import RoundIconButton from '@/Components/Button/RoundIconButton'
import { AnyTag } from '@/Controllers/Navigation/AnyTagType'
import { MediaQueryBreakpoints, MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import AddItemMenuButton from './AddItemMenuButton'
import { FilesController } from '@/Controllers/FilesController'
import SearchButton from './SearchButton'
import { ItemListController } from '@/Controllers/ItemList/ItemListController'
import { PaneController } from '@/Controllers/PaneController/PaneController'
import ListItemVaultInfo from '../ListItemVaultInfo'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import PaneCollapseButton from '@/Components/Panes/PaneCollapseButton'
import useIsTabletOrMobileScreen from '@/Hooks/useIsTabletOrMobileScreen'

export const getNavigationControlVisibility = (
  isNavigationPaneCollapsed: boolean,
  isTabletOrMobile: boolean,
  usesTabletLayout: boolean,
) => {
  const showNavigationMenu = isTabletOrMobile || usesTabletLayout

  return {
    showNavigationMenu,
    showCollapsedNavigationExpander: isNavigationPaneCollapsed && !showNavigationMenu,
  }
}

type Props = {
  application: WebApplication
  panelTitle: string
  icon?: VectorIconNameOrEmoji
  addButtonLabel: string
  addNewItem: () => void
  uploadFolder?: () => void
  isFilesSmartView: boolean
  isTableViewEnabled: boolean
  optionsSubtitle?: string
  selectedTag: AnyTag
  filesController: FilesController
  itemListController: ItemListController
  paneController: PaneController
}

const ContentListHeader = ({
  application,
  panelTitle,
  icon,
  addButtonLabel,
  addNewItem,
  uploadFolder,
  isFilesSmartView,
  isTableViewEnabled,
  optionsSubtitle,
  selectedTag,
  filesController,
  itemListController,
  paneController,
}: Props) => {
  const { t } = useTranslation('notes')
  const displayOptionsContainerRef = useRef<HTMLDivElement>(null)
  const displayOptionsButtonRef = useRef<HTMLButtonElement>(null)
  const isDailyEntry = isTag(selectedTag) && selectedTag.isDailyEntry

  const isMobileScreen = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
  const matchesMd = useMediaQuery(MediaQueryBreakpoints.md)
  const isTouchScreen = !useMediaQuery(MediaQueryBreakpoints.pointerFine)
  const isTablet = matchesMd && isTouchScreen
  const { isTabletOrMobile } = useIsTabletOrMobileScreen()

  const { isNavigationPaneCollapsed, toggleNavigationPane, toggleListPane } = useResponsiveAppPane()
  const { showNavigationMenu, showCollapsedNavigationExpander } = getNavigationControlVisibility(
    isNavigationPaneCollapsed,
    isTabletOrMobile,
    isTablet,
  )

  const [syncSubtitle, setSyncSubtitle] = useState('')
  const [outOfSync, setOutOfSync] = useState(false)
  const showSyncSubtitle = isMobileScreen && (!!syncSubtitle || outOfSync)

  useEffect(() => {
    return application.addEventObserver(async (event) => {
      if (event === ApplicationEvent.CompletedInitialSync) {
        setSyncSubtitle('')
        return
      }

      if (event === ApplicationEvent.EnteredOutOfSync) {
        setOutOfSync(true)
        return
      }

      if (event === ApplicationEvent.ExitedOutOfSync) {
        setOutOfSync(false)
        return
      }

      const syncStatus = application.sync.getSyncStatus()
      const { localDataDone, localDataCurrent, localDataTotal } = syncStatus.getStats()

      if (event === ApplicationEvent.SyncStatusChanged) {
        setSyncSubtitle(
          syncStatus.syncInProgress && !application.sync.completedOnlineDownloadFirstSync ? t('syncing') : '',
        )
        return
      }

      if (event === ApplicationEvent.LocalDataIncrementalLoad || event === ApplicationEvent.LocalDataLoaded) {
        if (localDataDone) {
          setSyncSubtitle('')
          return
        }

        setSyncSubtitle(t('loadingItemsProgress', { current: localDataCurrent, total: localDataTotal }))
        return
      }
    })
  }, [application, t])

  const [showDisplayOptionsMenu, setShowDisplayOptionsMenu] = useState(false)

  const toggleDisplayOptionsMenu = useCallback(() => {
    setShowDisplayOptionsMenu((show) => !show)
  }, [])

  useEffect(
    () =>
      application.commands.add(
        'open-display-opts-menu',
        'Open display options menu',
        toggleDisplayOptionsMenu,
        'sort-descending',
      ),
    [application.commands, toggleDisplayOptionsMenu],
  )

  const OptionsMenu = useMemo(() => {
    return (
      <div className="flex">
        <div className="relative" ref={displayOptionsContainerRef}>
          <RoundIconButton
            className={classNames(showDisplayOptionsMenu ? 'bg-contrast' : undefined)}
            onClick={toggleDisplayOptionsMenu}
            ref={displayOptionsButtonRef}
            icon="sort-descending"
            label={t('displayOptionsMenu')}
          />
          <Popover
            open={showDisplayOptionsMenu}
            anchorElement={displayOptionsButtonRef}
            togglePopover={toggleDisplayOptionsMenu}
            align="start"
            className="py-2"
            title={t('displayOptions')}
          >
            <DisplayOptionsMenu
              application={application}
              isFilesSmartView={isFilesSmartView}
              selectedTag={selectedTag}
              paneController={paneController}
            />
          </Popover>
        </div>
      </div>
    )
  }, [showDisplayOptionsMenu, toggleDisplayOptionsMenu, application, isFilesSmartView, selectedTag, paneController, t])

  const AddButton = useMemo(() => {
    return (
      <AddItemMenuButton
        isInFilesSmartView={isFilesSmartView}
        isDailyEntry={isDailyEntry}
        addButtonLabel={addButtonLabel}
        addNewItem={addNewItem}
        uploadFolder={uploadFolder}
        filesController={filesController}
      />
    )
  }, [addButtonLabel, addNewItem, uploadFolder, filesController, isDailyEntry, isFilesSmartView])

  const SearchBarButton = useMemo(() => {
    if (!isTableViewEnabled || isMobileScreen) {
      return null
    }

    return <SearchButton itemListController={itemListController} />
  }, [isTableViewEnabled, isMobileScreen, itemListController])

  const FolderName = useMemo(() => {
    return (
      <div className="flex min-w-0 flex-grow flex-col pt-1 break-words lg:pt-0">
        <div
          className={classNames('flex min-w-0 flex-grow', !optionsSubtitle && !showSyncSubtitle ? 'items-center' : '')}
        >
          {icon && (
            <Icon
              type={icon}
              size="custom"
              className={classNames(
                'text-neutral mr-2 ml-0.5 h-7 w-7 flex-shrink-0 text-2xl lg:h-6 lg:w-6 lg:text-lg',
                optionsSubtitle && 'md:mt-0.5',
              )}
            />
          )}
          <div className="mr-2 flex min-w-0 flex-col break-words">
            <div className="text-text text-2xl font-semibold md:text-lg">{panelTitle}</div>
            {showSyncSubtitle && (
              <div className={classNames('-mt-1 text-xs md:mt-0', outOfSync ? 'text-warning' : 'text-passive-0')}>
                {outOfSync ? t('potentiallyOutOfSync') : syncSubtitle}
              </div>
            )}
            {optionsSubtitle && <div className="text-passive-0 text-xs">{optionsSubtitle}</div>}
            <ListItemVaultInfo className="mt-1" item={selectedTag} />
          </div>
        </div>
      </div>
    )
  }, [optionsSubtitle, showSyncSubtitle, icon, panelTitle, outOfSync, syncSubtitle, selectedTag, t])

  const PhoneAndDesktopLayout = useMemo(() => {
    return (
      <div className={'flex w-full justify-between md:flex'}>
        <NavigationMenuButton isVisible={showNavigationMenu} />
        {showCollapsedNavigationExpander && (
          <PaneCollapseButton
            onClick={toggleNavigationPane}
            label={t('expandTopicsPanel')}
            icon="menu-variant"
            expanded={false}
            className="mt-1 mr-2 lg:mt-0"
          />
        )}
        {FolderName}
        <div className="flex items-start gap-3 md:items-center">
          {SearchBarButton}
          {OptionsMenu}
          {AddButton}
          <PaneCollapseButton
            onClick={toggleListPane}
            label={t('collapseNotesPanel')}
            icon="menu-close"
            expanded={true}
            className="mt-1 lg:mt-0"
          />
        </div>
      </div>
    )
  }, [
    FolderName,
    SearchBarButton,
    OptionsMenu,
    AddButton,
    showNavigationMenu,
    showCollapsedNavigationExpander,
    toggleNavigationPane,
    toggleListPane,
    t,
  ])

  const TabletLayout = useMemo(() => {
    return (
      <div className={'w-full flex-col'}>
        <div className="mb-2 flex justify-between">
          <NavigationMenuButton isVisible={showNavigationMenu} />
          <div className="flex">
            {OptionsMenu}
            {AddButton}
          </div>
        </div>
        {FolderName}
      </div>
    )
  }, [OptionsMenu, AddButton, FolderName, showNavigationMenu])

  return (
    <div className="section-title-bar-header items-start gap-1">
      {!isTablet && PhoneAndDesktopLayout}
      {isTablet && TabletLayout}
    </div>
  )
}

export default memo(ContentListHeader)
