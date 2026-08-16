import { PANEL_NAME_NAVIGATION, PANEL_NAME_NOTES } from '@/Constants/Constants'
import { ElementIds } from '@/Constants/ElementIDs'
import useIsTabletOrMobileScreen from '@/Hooks/useIsTabletOrMobileScreen'
import { ErrorBoundary } from '@/Utils/ErrorBoundary'
import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'
import { addToast, ToastType } from '@standardnotes/toast'
import { ApplicationEvent, classNames, PrefKey } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePrevious } from '../ContentListView/Calendar/usePrevious'
import ContentListView from '../ContentListView/ContentListView'
import PanelResizer, { PanelResizeType, PanelSide, ResizeFinishCallback } from '../PanelResizer/PanelResizer'
import { AppPaneId, AppPaneIdToDivId } from './AppPaneMetadata'
import { useResponsiveAppPane } from './ResponsivePaneProvider'
import Navigation from '../Tags/Navigation'
import { useApplication } from '../ApplicationProvider'
import {
  animatePaneEntranceTransitionFromOffscreenToTheRight,
  animatePaneExitTransitionOffscreenToTheRight,
} from '@/Components/Panes/PaneAnimator'
import { isPanesChangeLeafDismiss, isPanesChangePush } from '@/Controllers/PaneController/panesForLayout'
import { log, LoggingDomain } from '@/Logging'
import { useMediaQuery } from '@/Hooks/useMediaQuery'
import EditorPane from '../NoteGroupView/EditorPane'
import AssistantView from '../Assistant/AssistantView'
import ConstellationView from '../Constellation/ConstellationView'
import DashboardView from '../Dashboard/DashboardView'
import HomeView from '../Home/HomeView'
import RemindersView from '../RemindersAggregate/RemindersView'
import CalendarAggregateView from '../CalendarAggregate/CalendarAggregateView'
import TodoView from '../TodoAggregate/TodoView'
import { TodoChecklistEditorOwnerHost } from '../TodoAggregate/TodoChecklistEditorOwner'
import ResearchView from '../Research/ResearchView'
import BookmarksView from '../Bookmarks/BookmarksView'
import usePreference from '@/Hooks/usePreference'
import {
  ASSISTANT_PANEL_DEFAULT_WIDTH,
  ASSISTANT_PANEL_MIN_WIDTH,
  clampAssistantPanelWidth,
  dockAssistantPaneToRight,
  maximumAssistantPanelWidth,
} from '@/Controllers/PaneController/assistantPaneLayout'

const NAVIGATION_PANEL_MIN_WIDTH = 48
const ITEMS_PANEL_MIN_WIDTH = 200
const NAVIGATION_PANEL_DEFAULT_WIDTH = 220
const ITEMS_PANEL_DEFAULT_WIDTH = 400
const ASSISTANT_RESIZE_KEYBOARD_STEP = 24
const ASSISTANT_RESIZE_KEYBOARD_LARGE_STEP = 64

const PanesSystemComponent = () => {
  const application = useApplication()
  const isTabletOrMobileScreenWrapped = useIsTabletOrMobileScreen()
  const { isTabletOrMobile, isTablet, isMobile } = isTabletOrMobileScreenWrapped
  const previousIsTabletOrMobileWrapped = usePrevious(isTabletOrMobileScreenWrapped)

  const paneController = useResponsiveAppPane()
  const previousPaneController = usePrevious(paneController)
  const [renderPanes, setRenderPanes] = useState<AppPaneId[]>([])
  const [panesPendingEntrance, setPanesPendingEntrance] = useState<AppPaneId[]>([])
  const [panesPendingExit, setPanesPendingExit] = useState<AppPaneId[]>([])

  const [navigationPanelWidth, setNavigationPanelWidth] = useState<number>(
    application.getPreference(PrefKey.TagsPanelWidth, NAVIGATION_PANEL_DEFAULT_WIDTH),
  )
  const [navigationRef, setNavigationRef] = useState<HTMLDivElement | null>(null)

  const [itemsPanelWidth, setItemsPanelWidth] = useState<number>(
    application.getPreference(PrefKey.NotesPanelWidth, ITEMS_PANEL_DEFAULT_WIDTH),
  )
  const [listRef, setListRef] = useState<HTMLDivElement | null>(null)

  const occupiedAssistantSidePaneWidth =
    (paneController.panes.includes(AppPaneId.Navigation) ? navigationPanelWidth : 0) +
    (paneController.panes.includes(AppPaneId.Items) ? itemsPanelWidth : 0)

  const [assistantPanelWidth, setAssistantPanelWidth] = useState<number>(
    clampAssistantPanelWidth(
      application.getPreference(PrefKey.AssistantPanelWidth, ASSISTANT_PANEL_DEFAULT_WIDTH),
      window.innerWidth,
      occupiedAssistantSidePaneWidth,
    ),
  )
  const assistantResizeCleanupRef = useRef<(() => void) | null>(null)

  const persistAssistantPanelWidth = useCallback(
    (width: number) => {
      void application.setPreference(PrefKey.AssistantPanelWidth, width).catch((error) => {
        console.error(error)
        addToast({
          type: ToastType.Error,
          message: 'Could not save the assistant panel size.',
        })
      })
    },
    [application],
  )

  const startAssistantResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      assistantResizeCleanupRef.current?.()
      const startX = event.clientX
      const startWidth = assistantPanelWidth
      let latest = startWidth
      let cleaned = false

      const cleanup = (persist: boolean) => {
        if (cleaned) {
          return
        }
        cleaned = true
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('blur', onCancel)
        document.body.classList.remove('select-none', 'cursor-col-resize')
        assistantResizeCleanupRef.current = null
        if (persist) {
          persistAssistantPanelWidth(latest)
        }
      }

      const onMove = (moveEvent: PointerEvent) => {
        try {
          // The assistant is the rightmost pane, so dragging its left edge LEFT
          // (clientX decreases) should widen it.
          const delta = startX - moveEvent.clientX
          latest = clampAssistantPanelWidth(startWidth + delta, window.innerWidth, occupiedAssistantSidePaneWidth)
          setAssistantPanelWidth(latest)
        } catch (error) {
          console.error('Assistant panel resize failed', error)
          cleanup(false)
        }
      }

      const onUp = () => {
        cleanup(true)
      }

      const onCancel = () => cleanup(true)

      document.body.classList.add('select-none', 'cursor-col-resize')
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onCancel)
      window.addEventListener('blur', onCancel)
      assistantResizeCleanupRef.current = () => cleanup(false)
    },
    [assistantPanelWidth, occupiedAssistantSidePaneWidth, persistAssistantPanelWidth],
  )

  useEffect(
    () => () => {
      assistantResizeCleanupRef.current?.()
    },
    [],
  )

  useEffect(() => {
    const clampToViewport = () => {
      setAssistantPanelWidth((current) =>
        clampAssistantPanelWidth(current, window.innerWidth, occupiedAssistantSidePaneWidth),
      )
    }
    clampToViewport()
    window.addEventListener('resize', clampToViewport)
    return () => window.removeEventListener('resize', clampToViewport)
  }, [occupiedAssistantSidePaneWidth])

  const onAssistantResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const maximumWidth = maximumAssistantPanelWidth(window.innerWidth, occupiedAssistantSidePaneWidth)
      const step = event.shiftKey ? ASSISTANT_RESIZE_KEYBOARD_LARGE_STEP : ASSISTANT_RESIZE_KEYBOARD_STEP
      let nextWidth: number | undefined

      if (event.key === 'ArrowLeft') {
        nextWidth = assistantPanelWidth + step
      } else if (event.key === 'ArrowRight') {
        nextWidth = assistantPanelWidth - step
      } else if (event.key === 'Home') {
        nextWidth = ASSISTANT_PANEL_MIN_WIDTH
      } else if (event.key === 'End') {
        nextWidth = maximumWidth
      }

      if (nextWidth === undefined) {
        return
      }

      event.preventDefault()
      const clampedWidth = clampAssistantPanelWidth(nextWidth, window.innerWidth, occupiedAssistantSidePaneWidth)
      setAssistantPanelWidth(clampedWidth)
      persistAssistantPanelWidth(clampedWidth)
    },
    [assistantPanelWidth, occupiedAssistantSidePaneWidth, persistAssistantPanelWidth],
  )

  const showPanelResizers = !isTabletOrMobile

  const constellationPosition = usePreference(PrefKey.ConstellationPosition)

  const orderPanesForConstellation = (list: AppPaneId[]): AppPaneId[] => {
    if (isMobile || !list.includes(AppPaneId.Constellation)) {
      return list
    }
    const others = list.filter((pane) => pane !== AppPaneId.Constellation)
    const ordered =
      constellationPosition === 'left' ? [AppPaneId.Constellation, ...others] : [...others, AppPaneId.Constellation]
    return dockAssistantPaneToRight(ordered, list.includes(AppPaneId.Assistant))
  }

  const [_editorRef, setEditorRef] = useState<HTMLDivElement | null>(null)

  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const animationsSupported = isMobile && !prefersReducedMotion

  useEffect(() => {
    if (!animationsSupported) {
      return
    }

    const panes = paneController.panes
    const previousPanes = previousPaneController?.panes
    if (!previousPanes) {
      setPanesPendingEntrance([])
      return
    }

    const isPush = isPanesChangePush(previousPanes, panes)
    if (isPush) {
      setPanesPendingEntrance([panes[panes.length - 1]])
    }
  }, [paneController.panes, previousPaneController?.panes, animationsSupported])

  useEffect(() => {
    if (!animationsSupported) {
      return
    }

    const panes = paneController.panes
    const previousPanes = previousPaneController?.panes
    if (!previousPanes) {
      setPanesPendingExit([])
      return
    }

    const isExit = isPanesChangeLeafDismiss(previousPanes, panes)
    if (isExit) {
      setPanesPendingExit([previousPanes[previousPanes.length - 1]])
    }
  }, [paneController.panes, previousPaneController?.panes, animationsSupported])

  useEffect(() => {
    setRenderPanes(paneController.panes)
  }, [paneController.panes])

  useEffect(() => {
    if (!panesPendingEntrance || panesPendingEntrance?.length === 0) {
      return
    }

    if (panesPendingEntrance.length > 1) {
      console.warn('More than one pane pending entrance. This is not supported.')
      return
    }

    void animatePaneEntranceTransitionFromOffscreenToTheRight(AppPaneIdToDivId[panesPendingEntrance[0]]).then(() => {
      setPanesPendingEntrance([])
    })
  }, [panesPendingEntrance])

  useEffect(() => {
    if (!panesPendingExit || panesPendingExit?.length === 0) {
      return
    }

    if (panesPendingExit.length > 1) {
      console.warn('More than one pane pending exit. This is not supported.')
      return
    }

    void animatePaneExitTransitionOffscreenToTheRight(AppPaneIdToDivId[panesPendingExit[0]]).then(() => {
      setPanesPendingExit([])
    })
  }, [panesPendingExit])

  useEffect(() => {
    const removeObserver = application.addEventObserver(async () => {
      const width = application.getPreference(PrefKey.TagsPanelWidth, NAVIGATION_PANEL_DEFAULT_WIDTH)
      setNavigationPanelWidth(width)
    }, ApplicationEvent.PreferencesChanged)

    return () => {
      removeObserver()
    }
  }, [application])

  const navigationPanelResizeWidthChangeCallback = useCallback((width: number) => {
    setNavigationPanelWidth(width)
  }, [])

  const itemsPanelResizeWidthChangeCallback = useCallback((width: number) => {
    setItemsPanelWidth(width)
  }, [])

  const handleInitialItemsListPanelWidthLoad = useCallback((width: number) => {
    setItemsPanelWidth(width)
  }, [])

  const navigationPanelResizeFinishCallback: ResizeFinishCallback = useCallback(
    (width, _lastLeft, _isMaxWidth, isCollapsed) => {
      application.publishPanelDidResizeEvent(PANEL_NAME_NAVIGATION, width, isCollapsed)
    },
    [application],
  )

  const itemsPanelResizeFinishCallback: ResizeFinishCallback = useCallback(
    (width, _lastLeft, _isMaxWidth, isCollapsed) => {
      application.publishPanelDidResizeEvent(PANEL_NAME_NOTES, width, isCollapsed)
    },
    [application],
  )

  useEffect(() => {
    if (isTablet && !previousIsTabletOrMobileWrapped?.isTablet) {
      if (paneController.selectedPane !== AppPaneId.Navigation) {
        paneController.removePane(AppPaneId.Navigation)
      }
    } else if (
      !isTablet &&
      previousIsTabletOrMobileWrapped?.isTablet &&
      !paneController.panes.includes(AppPaneId.Navigation)
    ) {
      paneController.insertPaneAtIndex(AppPaneId.Navigation, 0)
    }
  }, [isTablet, paneController, previousIsTabletOrMobileWrapped])

  const computeStylesForContainer = (): React.CSSProperties => {
    const panes = paneController.panes
    const hasAssistant = panes.includes(AppPaneId.Assistant)
    const hasConstellation = panes.includes(AppPaneId.Constellation)
    const hasDashboard =
      panes.includes(AppPaneId.Dashboard) ||
      panes.includes(AppPaneId.Home) ||
      panes.includes(AppPaneId.Reminders) ||
      panes.includes(AppPaneId.Calendar) ||
      panes.includes(AppPaneId.Todos) ||
      panes.includes(AppPaneId.Research) ||
      panes.includes(AppPaneId.Bookmarks)

    if (isMobile) {
      return {}
    }

    const columnFor = (pane: AppPaneId) => {
      if (pane === AppPaneId.Assistant) {
        return `${assistantPanelWidth}px`
      }
      if (pane === AppPaneId.Navigation) {
        return `${navigationPanelWidth}px`
      }
      if (pane === AppPaneId.Items) {
        return `${itemsPanelWidth}px`
      }
      return 'minmax(0, 1fr)'
    }

    // Constellation docked to the bottom: it spans all columns in a second row
    // (placed explicitly per-pane), so the columns only describe the other panes.
    if (hasConstellation && constellationPosition === 'bottom') {
      const columns = panes.filter((pane) => pane !== AppPaneId.Constellation).map(columnFor)
      return { gridTemplateColumns: columns.join(' '), gridTemplateRows: '1fr minmax(0, 40vh)' }
    }

    if (hasAssistant || hasConstellation || hasDashboard) {
      // Render fixed-width side panes (navigation/items/assistant) at their set
      // widths, and let the editor / constellation graph / dashboard share the rest.
      const columns = orderPanesForConstellation(panes).map(columnFor)
      return { gridTemplateColumns: columns.join(' ') }
    }

    const numPanes = panes.length

    switch (numPanes) {
      case 1: {
        return {
          gridTemplateColumns: 'auto',
        }
      }
      case 2: {
        if (paneController.focusModeEnabled) {
          return {
            gridTemplateColumns: '0 1fr',
          }
        }
        if (isTablet) {
          return {
            gridTemplateColumns: '1fr 2fr',
          }
        } else {
          if (panes[0] === AppPaneId.Navigation) {
            return {
              gridTemplateColumns: `${navigationPanelWidth}px auto`,
            }
          } else {
            return {
              gridTemplateColumns: `${itemsPanelWidth}px auto`,
            }
          }
        }
      }
      case 3: {
        if (paneController.focusModeEnabled) {
          return {
            gridTemplateColumns: '0 0 1fr',
          }
        }
        return {
          gridTemplateColumns: `${navigationPanelWidth}px ${itemsPanelWidth}px 2fr`,
        }
      }
      default:
        return {}
    }
  }

  const computeClassesForPane = (_paneId: AppPaneId, isPendingEntrance: boolean, index: number): string => {
    const common = `app-pane app-pane-${index + 1} h-full content`

    if (isMobile) {
      return `absolute top-0 left-0 w-full flex flex-col ${common} ${
        isPendingEntrance ? 'translate-x-[100%]' : 'translate-x-0 '
      }`
    } else {
      return `flex flex-col relative overflow-hidden ${common}`
    }
  }

  const computeClassesForContainer = (): string => {
    if (isMobile) {
      return 'w-full'
    }

    return 'grid'
  }

  const renderPanesWithPendingExit = orderPanesForConstellation([...renderPanes, ...panesPendingExit])

  log(LoggingDomain.Panes, 'Rendering panes', renderPanesWithPendingExit)

  return (
    <div id="app" className={`app ${computeClassesForContainer()}`} style={{ ...computeStylesForContainer() }}>
      <TodoChecklistEditorOwnerHost application={application} />
      {renderPanesWithPendingExit.map((pane, index) => {
        const isPendingEntrance = panesPendingEntrance?.includes(pane)

        const constellationBottomPlacement =
          pane === AppPaneId.Constellation && constellationPosition === 'bottom' && !isMobile
            ? '[grid-column:1/-1] [grid-row:2]'
            : ''
        const className = classNames(
          computeClassesForPane(pane, isPendingEntrance ?? false, index),
          constellationBottomPlacement,
        )

        if (pane === AppPaneId.Navigation) {
          return (
            <ComponentErrorBoundary
              key="navigation-pane"
              regionName="Navigation"
              fallback={() => (
                <div className={classNames(className, 'text-passive-0 flex items-center justify-center')}>
                  Navigation unavailable
                </div>
              )}
            >
              <Navigation
                id={ElementIds.NavigationColumn}
                ref={setNavigationRef}
                className={classNames(className, isTabletOrMobile ? 'w-full' : '')}
                application={application}
              >
                {showPanelResizers && navigationRef && (
                  <PanelResizer
                    collapsable={true}
                    defaultWidth={navigationPanelWidth}
                    hoverable={true}
                    left={0}
                    minWidth={NAVIGATION_PANEL_MIN_WIDTH}
                    modifyElementWidth={false}
                    panel={navigationRef}
                    resizeFinishCallback={navigationPanelResizeFinishCallback}
                    side={PanelSide.Right}
                    type={PanelResizeType.WidthOnly}
                    width={navigationPanelWidth}
                    widthEventCallback={navigationPanelResizeWidthChangeCallback}
                  />
                )}
              </Navigation>
            </ComponentErrorBoundary>
          )
        } else if (pane === AppPaneId.Items) {
          return (
            <ComponentErrorBoundary
              key="content-list-view"
              regionName="Note list"
              fallback={() => (
                <div className={classNames(className, 'text-passive-0 flex items-center justify-center')}>
                  List unavailable
                </div>
              )}
            >
              <ContentListView
                id={ElementIds.ItemsColumn}
                className={className}
                ref={setListRef}
                application={application}
                onPanelWidthLoad={handleInitialItemsListPanelWidthLoad}
              >
                {showPanelResizers && listRef && (
                  <PanelResizer
                    collapsable={true}
                    defaultWidth={ITEMS_PANEL_DEFAULT_WIDTH}
                    hoverable={true}
                    left={0}
                    minWidth={ITEMS_PANEL_MIN_WIDTH}
                    modifyElementWidth={false}
                    panel={listRef}
                    resizeFinishCallback={itemsPanelResizeFinishCallback}
                    side={PanelSide.Right}
                    type={PanelResizeType.WidthOnly}
                    width={itemsPanelWidth}
                    widthEventCallback={itemsPanelResizeWidthChangeCallback}
                  />
                )}
              </ContentListView>
            </ComponentErrorBoundary>
          )
        } else if (pane === AppPaneId.Editor) {
          return (
            <ErrorBoundary key="editor-pane">
              <EditorPane
                id={ElementIds.EditorColumn}
                ref={setEditorRef}
                className={className}
                application={application}
              />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Assistant) {
          return (
            <ErrorBoundary key="assistant-pane">
              <AssistantView id={ElementIds.AssistantColumn} className={className} application={application}>
                {showPanelResizers && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize assistant panel"
                    aria-valuemin={ASSISTANT_PANEL_MIN_WIDTH}
                    aria-valuemax={maximumAssistantPanelWidth(window.innerWidth, occupiedAssistantSidePaneWidth)}
                    aria-valuenow={assistantPanelWidth}
                    tabIndex={0}
                    onPointerDown={startAssistantResize}
                    onKeyDown={onAssistantResizeKeyDown}
                    className="z-panel-resizer absolute top-0 left-0 hidden h-full w-[7px] touch-none cursor-col-resize bg-[color:var(--panel-resizer-background-color)] opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none md:block"
                  />
                )}
              </AssistantView>
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Constellation) {
          return (
            <ErrorBoundary key="constellation-pane">
              <ConstellationView id={ElementIds.ConstellationColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Dashboard) {
          return (
            <ErrorBoundary key="dashboard-pane">
              <DashboardView id={ElementIds.DashboardColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Home) {
          return (
            <ErrorBoundary key="home-pane">
              <HomeView id={ElementIds.HomeColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Reminders) {
          return (
            <ErrorBoundary key="reminders-pane">
              <RemindersView id={ElementIds.RemindersColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Calendar) {
          return (
            <ErrorBoundary key="calendar-aggregate-pane">
              <CalendarAggregateView id={ElementIds.CalendarColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Todos) {
          return (
            <ErrorBoundary key="todos-pane">
              <TodoView id={ElementIds.TodosColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Research) {
          return (
            <ErrorBoundary key="research-pane">
              <ResearchView id={ElementIds.ResearchColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        } else if (pane === AppPaneId.Bookmarks) {
          return (
            <ErrorBoundary key="bookmarks-pane">
              <BookmarksView id={ElementIds.BookmarksColumn} className={className} application={application} />
            </ErrorBoundary>
          )
        }
      })}
    </div>
  )
}

export default observer(PanesSystemComponent)
