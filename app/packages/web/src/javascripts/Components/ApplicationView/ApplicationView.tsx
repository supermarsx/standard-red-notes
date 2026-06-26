import { WebApplicationGroup } from '@/Application/WebApplicationGroup'
import { getPlatformString } from '@/Utils'
import {
  ApplicationEvent,
  Challenge,
  ChallengeReason,
  SessionStrings,
  removeFromArray,
  WebAppEvent,
  PrefKey,
  PrefDefaults,
  LocalPrefKey,
  LocalPrefDefaults,
  ContentType,
} from '@standardnotes/snjs'
import { applyEditorFont } from '@/Utils/editorFont'
import { achievements, METRICS } from '@/Achievements'
import { startAppUsageTimeTracking } from '@/Services/AppUsageTime/AppUsageTimeTracker'
import { reapplyPersistedCustomTheme } from '@/Components/Preferences/Panes/Appearance/CustomThemes/CustomThemeManager'
import { alertDialog, isIOS, RouteType } from '@standardnotes/ui-services'
import { WebApplication } from '@/Application/WebApplication'
import Footer from '@/Components/Footer/Footer'
import SessionsModal from '@/Components/SessionsModal/SessionsModal'
import PreferencesViewWrapper from '@/Components/Preferences/PreferencesViewWrapper'
import ChallengeModal from '@/Components/ChallengeModal/ChallengeModal'
import NotesContextMenu from '@/Components/NotesContextMenu/NotesContextMenu'
import PurchaseFlowWrapper from '@/Components/PurchaseFlow/PurchaseFlowWrapper'
import { FunctionComponent, useCallback, useEffect, useMemo, useState, Suspense, useRef } from 'react'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'
import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'
import Spinner from '@/Components/Spinner/Spinner'
import RevisionHistoryModal from '@/Components/RevisionHistoryModal/RevisionHistoryModal'
import ConfirmSignoutContainer from '@/Components/ConfirmSignoutModal/ConfirmSignoutModal'
import { addToast, ToastContainer, ToastType } from '@standardnotes/toast'
import FilePreviewModalWrapper from '@/Components/FilePreview/FilePreviewModal'
import FileContextMenuWrapper from '@/Components/FileContextMenu/FileContextMenu'
import PermissionsModalWrapper from '@/Components/PermissionsModal/PermissionsModalWrapper'
import TagContextMenuWrapper from '@/Components/Tags/TagContextMenuWrapper'
import FolderContextMenuWrapper from '@/Components/Tags/FolderContextMenuWrapper'
import FileDragNDropProvider from '../FileDragNDropProvider'
import ResponsivePaneProvider from '../Panes/ResponsivePaneProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import ConfirmDeleteAccountContainer from '@/Components/ConfirmDeleteAccountModal/ConfirmDeleteAccountModal'
import ApplicationProvider from '../ApplicationProvider'
import KeyboardServiceProvider from '../KeyboardServiceProvider'
import PanesSystemComponent from '../Panes/PanesSystemComponent'
import LinkingControllerProvider from '@/Controllers/LinkingControllerProvider'
import ImportModal from '../ImportModal/ImportModal'
import ExportModal from '../ExportModal/ExportModal'
import IosKeyboardClose from '../IosKeyboardClose/IosKeyboardClose'
import EditorWidthSelectionModalWrapper from '../EditorWidthSelectionModal/EditorWidthSelectionModal'
import { ProtectionEvent } from '@standardnotes/services'
import KeyboardShortcutsModal from '../KeyboardShortcutsHelpModal/KeyboardShortcutsHelpModal'
import CommandPalette from '../CommandPalette/CommandPalette'
import SuperExportModal from '../NotesOptions/SuperExportModal'
import { useConflictWarnings } from '@/Hooks/useConflictWarnings'
import { usePreferenceSyncToast } from '@/Hooks/usePreferenceSyncToast'
import { useReminderChecker } from '@/Reminders/useReminderChecker'
import { useDiaryScheduler } from '@/Diary/useDiaryScheduler'
import RemindersButton from '@/Reminders/RemindersButton'
import FloatingNarrationPlayer from '../Narration/FloatingNarrationPlayer'
import AppLockPasskeyScreen from './AppLockPasskeyScreen'
import { isAppLockPasskeyRegistered } from '@/AppLockPasskey/appLockPasskeyService'

type Props = {
  application: WebApplication
  mainApplicationGroup: WebApplicationGroup
}

const LazyLoadedClipperView = lazyWithRetry(() => import('../ClipperView/ClipperView'))
const LazyLoadedAssistantView = lazyWithRetry(() => import('../Assistant/AssistantView'))
const LazyLoadedConstellationView = lazyWithRetry(() => import('../Constellation/ConstellationView'))

const LazyViewLoadingFallback = (
  <div className="flex h-full w-full items-center justify-center">
    <Spinner className="h-6 w-6" />
  </div>
)

/**
 * Identifies the "your session became invalid, please re-enter your email and
 * password" challenge that snjs pops whenever an authenticated request gets a
 * 401/498 that isn't a clean server-side revoke. It is a `Custom` challenge
 * whose heading is the (stable) session-recovery copy. We special-case it so
 * that, once the user dismisses it, we stop letting it re-pop on every failed
 * sync and instead surface a clickable "Login needed" footer status.
 */
const isSessionReauthChallenge = (challenge: Challenge): boolean =>
  challenge.reason === ChallengeReason.Custom && challenge.heading === SessionStrings.EnterEmailAndPassword

/**
 * Standard Red Notes (achievements): record the "account age in years" metric on
 * launch. There is no account-creation date on the client User object, so we use
 * the oldest item's creation date as the account-age anchor (the same signal the
 * statistics/dashboard derive age from). Web-local + fire-and-forget.
 */
const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365
const recordAccountAgeAchievement = (application: WebApplication): void => {
  // This scans EVERY note (O(n)) to find the oldest creation date. Running it
  // inline during onAppLaunch would block the most latency-sensitive moment of
  // startup — and that cost grows with the note count. It is a fire-and-forget
  // achievement metric with no UI dependency, so defer it to browser idle time
  // (with a setTimeout fallback) to keep launch off the main-thread hot path.
  const run = () => {
    try {
      const items = application.items.getItems(ContentType.TYPES.Note)
      let oldest = Number.POSITIVE_INFINITY
      for (const item of items) {
        const created = item.created_at?.getTime?.()
        if (typeof created === 'number' && created > 0 && created < oldest) {
          oldest = created
        }
      }
      if (!Number.isFinite(oldest)) {
        return
      }
      const years = Math.floor((Date.now() - oldest) / MS_PER_YEAR)
      if (years > 0) {
        achievements.setAtLeast(METRICS.accountAgeYears, years)
      }
    } catch {
      // Fire-and-forget.
    }
  }

  const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback
  if (typeof ric === 'function') {
    ric(run, { timeout: 5000 })
  } else {
    setTimeout(run, 2000)
  }
}

const ApplicationView: FunctionComponent<Props> = ({ application, mainApplicationGroup }) => {
  const platformString = getPlatformString()
  const [launched, setLaunched] = useState(false)
  const [needsUnlock, setNeedsUnlock] = useState(true)
  const [challenges, setChallenges] = useState<Challenge[]>([])
  // Local passkey app-lock gate: when a passkey is registered, the app stays
  // gated (after the existing passcode/biometric unlock) until a successful
  // WebAuthn assertion. This gates LOCAL UI access on this device only; it does
  // not affect the E2E encryption keys.
  const [passkeyUnlockPending, setPasskeyUnlockPending] = useState(false)

  const currentWriteErrorDialog = useRef<Promise<void> | null>(null)
  const currentLoadErrorDialog = useRef<Promise<void> | null>(null)

  // App-wide watcher: warn the user in real time when a new sync conflict
  // (conflicted copy) appears, deep-linking them to Preferences → Conflicts.
  useConflictWarnings(application)

  // App-wide watcher: show a single debounced "Settings saved and synced" toast
  // when the user changes a preference and that change reaches the server.
  usePreferenceSyncToast(application)

  // App-wide watcher: periodically scan notes for due reminders and fire a
  // notification + in-app toast (opt-in; nothing fires until the user sets one).
  useReminderChecker(application)

  // App-wide watcher: when Diary mode is enabled, fire a single once-a-day
  // notification (at the configured time) prompting the user to write today's
  // diary entry. Opt-in; nothing fires until the user enables it.
  useDiaryScheduler(application)

  // Standard Red Notes: accumulate active (foreground) usage time and unlock the
  // app-hours achievements. Fire-and-forget; persists across reloads.
  useEffect(() => {
    const stop = startAppUsageTimeTracking()
    return stop
  }, [])

  useEffect(() => {
    const desktopService = application.desktopManager

    if (desktopService) {
      application.componentManager.setDesktopManager(desktopService)
    }

    application
      .prepareForLaunch({
        receiveChallenge: async (challenge) => {
          // If the user has already dismissed the invalid-session re-login
          // prompt, do NOT keep re-popping it on every subsequent failed sync.
          // Leave this re-auth challenge PENDING (do NOT cancel it): snjs guards
          // re-auth with an internal "challenge presented" flag that stays set
          // while a challenge is unresolved, which suppresses further re-auth
          // attempts AND the failed-sync retries behind them. Cancelling here
          // resets that guard, so the next 401 immediately re-presents → cancel
          // → a ~30ms `/v1/items` 401 storm that breaks the tab. We stash it and
          // settle it only once the user signs in again. The footer surfaces a
          // clickable "Login needed" and openSignIn() lets them re-auth.
          if (isSessionReauthChallenge(challenge) && application.accountMenuController.reloginPromptDismissed) {
            application.accountMenuController.pendingReauthChallenge = challenge
            return
          }
          const challengesCopy = challenges.slice()
          challengesCopy.push(challenge)
          setChallenges(challengesCopy)
        },
      })
      .then(() => {
        void application.launch()
      })
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application])

  const removeChallenge = useCallback(
    (challenge: Challenge) => {
      const challengesCopy = challenges.slice()
      removeFromArray(challengesCopy, challenge)
      setChallenges(challengesCopy)
    },
    [challenges],
  )

  const onAppStart = useCallback(() => {
    setNeedsUnlock(application.hasPasscode())
  }, [application])

  const handleDemoSignInFromParamsIfApplicable = useCallback(() => {
    const route = application.routeService.getRoute()
    if (route.type !== RouteType.Demo) {
      return
    }

    const token = route.demoParams.token
    if (!token || application.hasAccount()) {
      return
    }

    const status = application.status.addMessage('Preparing demo...')
    void application.user.populateSessionFromDemoShareToken(token).then(() => {
      application.status.removeMessage(status)
      application.hideAccountMenu()
    })
  }, [application])

  // Engage the local passkey gate iff a passkey is registered on this device.
  // Called whenever the existing local unlock (passcode/biometric/launch) clears,
  // so the passkey assertion is required on each fresh unlock.
  const engagePasskeyGateIfRegistered = useCallback(() => {
    setPasskeyUnlockPending(isAppLockPasskeyRegistered(application))
  }, [application])

  const onAppLaunch = useCallback(() => {
    setLaunched(true)
    setNeedsUnlock(false)
    engagePasskeyGateIfRegistered()
    handleDemoSignInFromParamsIfApplicable()
    recordAccountAgeAchievement(application)
  }, [application, engagePasskeyGateIfRegistered, handleDemoSignInFromParamsIfApplicable])

  useEffect(() => {
    if (application.isStarted()) {
      onAppStart()
    }

    if (application.isLaunched()) {
      onAppLaunch()
    }

    const removeAppObserver = application.addEventObserver(async (eventName) => {
      if (eventName === ApplicationEvent.Started) {
        onAppStart()
      } else if (eventName === ApplicationEvent.Launched) {
        onAppLaunch()
      } else if (eventName === ApplicationEvent.LocalDatabaseReadError) {
        if (!currentLoadErrorDialog.current) {
          alertDialog({
            text: 'Unable to load local database. Please restart the app and try again.',
          })
            .then(() => {
              currentLoadErrorDialog.current = null
            })
            .catch(console.error)
        }
      } else if (eventName === ApplicationEvent.LocalDatabaseWriteError) {
        if (!currentWriteErrorDialog.current) {
          currentWriteErrorDialog.current = alertDialog({
            text: 'Unable to write to local database. Please restart the app and try again.',
          })
            .then(() => {
              currentWriteErrorDialog.current = null
            })
            .catch(console.error)
        }
      } else if (eventName === ApplicationEvent.SyncTooManyRequests) {
        addToast({
          type: ToastType.Error,
          message: 'Too many requests. Please try again later.',
        })
      } else if (eventName === ApplicationEvent.SignedIn || eventName === ApplicationEvent.CompletedFullSync) {
        // The session is valid again (the user signed in, or a full sync
        // succeeded after re-auth). Settle the re-auth challenge we left pending
        // so snjs's internal guard resets for the future (safe now — there is no
        // active 401 loop to restart), and clear the "login needed" state so the
        // footer returns to its normal connection status.
        const pendingChallenge = application.accountMenuController.pendingReauthChallenge
        if (pendingChallenge) {
          application.accountMenuController.pendingReauthChallenge = undefined
          application.cancelChallenge(pendingChallenge)
        }
        if (application.accountMenuController.reloginPromptDismissed) {
          application.accountMenuController.setReloginPromptDismissed(false)
        }
      }
    })

    return () => {
      removeAppObserver()
    }
  }, [application, onAppLaunch, onAppStart])

  // Standard Red Notes (achievements): count sync conflicts. The sync layer
  // creates a "conflicted copy" item carrying `conflictOf` whenever a conflict is
  // detected; each such newly-INSERTED note is one conflict. streamItems fires
  // `inserted` once per genuinely new item, so this counts each conflict once.
  useEffect(() => {
    const removeObserver = application.items.streamItems(ContentType.TYPES.Note, ({ inserted }) => {
      let conflicts = 0
      for (const note of inserted) {
        if ((note as { conflictOf?: string }).conflictOf) {
          conflicts += 1
        }
      }
      if (conflicts > 0) {
        achievements.increment(METRICS.syncConflictsTotal, conflicts)
      }
    })
    return () => {
      removeObserver()
    }
  }, [application])

  useEffect(() => {
    const applyFont = () => {
      const customFont = application.getPreference(PrefKey.EditorFontFamily, PrefDefaults[PrefKey.EditorFontFamily])
      const monospace = application.preferences.getLocalValue(
        LocalPrefKey.EditorMonospaceEnabled,
        LocalPrefDefaults[LocalPrefKey.EditorMonospaceEnabled],
      )
      applyEditorFont(customFont, monospace)
    }

    if (application.isLaunched()) {
      applyFont()
    }

    const removeSyncedObserver = application.addEventObserver(async () => {
      applyFont()
    }, ApplicationEvent.PreferencesChanged)

    const removeLaunchObserver = application.addEventObserver(async () => {
      applyFont()
    }, ApplicationEvent.Launched)

    const removeLocalObserver = application.addEventObserver(async () => {
      applyFont()
    }, ApplicationEvent.LocalPreferencesChanged)

    return () => {
      removeSyncedObserver()
      removeLaunchObserver()
      removeLocalObserver()
    }
  }, [application])

  // Standard Red Notes: re-assert the selected custom-theme :root override on
  // launch and whenever the base theme changes (auto light/dark switches fire
  // LocalPreferencesChanged), so it stays layered on top of the base theme.
  useEffect(() => {
    if (application.isLaunched()) {
      reapplyPersistedCustomTheme()
    }

    const removeLaunchObserver = application.addEventObserver(async () => {
      reapplyPersistedCustomTheme()
    }, ApplicationEvent.Launched)

    const removeLocalObserver = application.addEventObserver(async () => {
      // Defer so the base theme's stylesheet has been applied first.
      setTimeout(() => reapplyPersistedCustomTheme(), 50)
    }, ApplicationEvent.LocalPreferencesChanged)

    return () => {
      removeLaunchObserver()
      removeLocalObserver()
    }
  }, [application])

  useEffect(() => {
    const disposer = application.protections.addEventObserver(async (eventName) => {
      if (eventName === ProtectionEvent.BiometricsSoftLockEngaged) {
        setNeedsUnlock(true)
        // Re-arm the passkey gate so it is required again on the next unlock.
        setPasskeyUnlockPending(isAppLockPasskeyRegistered(application))
      } else if (eventName === ProtectionEvent.BiometricsSoftLockDisengaged) {
        setNeedsUnlock(false)
        engagePasskeyGateIfRegistered()
      }
    })

    return disposer
  }, [application, engagePasskeyGateIfRegistered])

  useEffect(() => {
    const removeObserver = application.addWebEventObserver(async (eventName) => {
      if (eventName === WebAppEvent.WindowDidFocus || eventName === WebAppEvent.WindowDidBlur) {
        if (!(await application.protections.isLocked())) {
          application.sync.sync().catch(console.error)
        }
      }
    })

    return () => {
      removeObserver()
    }
  }, [application])

  // The passkey lock screen shows once the existing local unlock has cleared
  // (passcode/biometric/launch) but the registered passkey assertion is still
  // pending. It is never shown before the existing unlock, so the passcode lock
  // continues to gate first and remains the fallback.
  const showPasskeyLockScreen = useMemo(() => {
    return !needsUnlock && launched && passkeyUnlockPending
  }, [needsUnlock, launched, passkeyUnlockPending])

  const renderAppContents = useMemo(() => {
    return !needsUnlock && launched && !passkeyUnlockPending
  }, [needsUnlock, launched, passkeyUnlockPending])

  const onPasskeyUnlocked = useCallback(() => {
    setPasskeyUnlockPending(false)
  }, [])

  const renderChallenges = useCallback(() => {
    return challenges.map((challenge) => (
      <div className="sk-modal" key={`${challenge.id}${application.ephemeralIdentifier}`}>
        <ChallengeModal
          key={`${challenge.id}${application.ephemeralIdentifier}`}
          application={application}
          mainApplicationGroup={mainApplicationGroup}
          challenge={challenge}
          onDismiss={removeChallenge}
        />
      </div>
    ))
  }, [challenges, mainApplicationGroup, removeChallenge, application])

  if (!renderAppContents) {
    return (
      <ApplicationProvider application={application}>
        <AndroidBackHandlerProvider application={application}>
          {renderChallenges()}
          {showPasskeyLockScreen && <AppLockPasskeyScreen application={application} onUnlocked={onPasskeyUnlocked} />}
        </AndroidBackHandlerProvider>
      </ApplicationProvider>
    )
  }

  const route = application.routeService.getRoute()

  if (route.type === RouteType.AppViewRoute && route.appViewRouteParam === 'assistant') {
    return (
      <ApplicationProvider application={application}>
        <KeyboardServiceProvider service={application.keyboardService}>
          <AndroidBackHandlerProvider application={application}>
            <ResponsivePaneProvider paneController={application.paneController}>
              <LinkingControllerProvider controller={application.linkingController}>
                <FileDragNDropProvider application={application}>
                  <div className={platformString + ' main-ui-view sn-component h-full'}>
                    <ComponentErrorBoundary label="The Assistant">
                      <Suspense fallback={LazyViewLoadingFallback}>
                        <LazyLoadedAssistantView
                          id="assistant-standalone"
                          application={application}
                          className="h-full"
                          standalone
                        />
                      </Suspense>
                    </ComponentErrorBoundary>
                  </div>
                  <ToastContainer />
                  <FilePreviewModalWrapper application={application} />
                  {renderChallenges()}
                </FileDragNDropProvider>
              </LinkingControllerProvider>
            </ResponsivePaneProvider>
          </AndroidBackHandlerProvider>
        </KeyboardServiceProvider>
      </ApplicationProvider>
    )
  }

  if (route.type === RouteType.AppViewRoute && route.appViewRouteParam === 'constellation') {
    return (
      <ApplicationProvider application={application}>
        <KeyboardServiceProvider service={application.keyboardService}>
          <AndroidBackHandlerProvider application={application}>
            <ResponsivePaneProvider paneController={application.paneController}>
              <LinkingControllerProvider controller={application.linkingController}>
                <FileDragNDropProvider application={application}>
                  <div className={platformString + ' main-ui-view sn-component h-full'}>
                    <ComponentErrorBoundary label="The Constellation view">
                      <Suspense fallback={LazyViewLoadingFallback}>
                        <LazyLoadedConstellationView
                          id="constellation-standalone"
                          application={application}
                          className="h-full"
                          standalone
                        />
                      </Suspense>
                    </ComponentErrorBoundary>
                  </div>
                  <ToastContainer />
                  <FilePreviewModalWrapper application={application} />
                  {renderChallenges()}
                </FileDragNDropProvider>
              </LinkingControllerProvider>
            </ResponsivePaneProvider>
          </AndroidBackHandlerProvider>
        </KeyboardServiceProvider>
      </ApplicationProvider>
    )
  }

  if (route.type === RouteType.AppViewRoute && route.appViewRouteParam === 'extension') {
    return (
      <ApplicationProvider application={application}>
        <KeyboardServiceProvider service={application.keyboardService}>
          <AndroidBackHandlerProvider application={application}>
            <ResponsivePaneProvider paneController={application.paneController}>
              <LinkingControllerProvider controller={application.linkingController}>
                <FileDragNDropProvider application={application}>
                  <ComponentErrorBoundary label="The Clipper view">
                    <Suspense fallback={LazyViewLoadingFallback}>
                      <LazyLoadedClipperView applicationGroup={mainApplicationGroup} />
                    </Suspense>
                  </ComponentErrorBoundary>
                  <ToastContainer />
                  <FilePreviewModalWrapper application={application} />
                  {renderChallenges()}
                </FileDragNDropProvider>
              </LinkingControllerProvider>
            </ResponsivePaneProvider>
          </AndroidBackHandlerProvider>
        </KeyboardServiceProvider>
      </ApplicationProvider>
    )
  }

  return (
    <ApplicationProvider application={application}>
      <KeyboardServiceProvider service={application.keyboardService}>
        <AndroidBackHandlerProvider application={application}>
          <ResponsivePaneProvider paneController={application.paneController}>
            <LinkingControllerProvider controller={application.linkingController}>
              <div className={platformString + ' main-ui-view sn-component h-full'}>
                <FileDragNDropProvider application={application}>
                  <PanesSystemComponent />
                </FileDragNDropProvider>
                  <>
                    <Footer application={application} applicationGroup={mainApplicationGroup} />
                    <SessionsModal application={application} />
                    <PreferencesViewWrapper application={application} />
                    <RevisionHistoryModal application={application} />
                  </>
                  {renderChallenges()}
                  <>
                    <NotesContextMenu />
                    <TagContextMenuWrapper
                      navigationController={application.navigationController}
                      featuresController={application.featuresController}
                    />
                    <FolderContextMenuWrapper
                      navigationController={application.navigationController}
                      featuresController={application.featuresController}
                    />
                    <FileContextMenuWrapper
                      filesController={application.filesController}
                      itemListController={application.itemListController}
                    />
                    <PurchaseFlowWrapper application={application} />
                    <ConfirmSignoutContainer applicationGroup={mainApplicationGroup} application={application} />
                    <ToastContainer />
                    <FilePreviewModalWrapper application={application} />
                    <PermissionsModalWrapper application={application} />
                    <EditorWidthSelectionModalWrapper />
                    <ConfirmDeleteAccountContainer application={application} />
                    <ImportModal importModalController={application.importModalController} />
                    <ExportModal exportModalController={application.exportModalController} />
                    <KeyboardShortcutsModal keyboardService={application.keyboardService} />
                    <SuperExportModal />
                    <CommandPalette />
                    <div className="pointer-events-none fixed bottom-14 right-4 z-footer-bar-item">
                      <RemindersButton application={application} />
                    </div>
                    <FloatingNarrationPlayer />
                  </>
                  {isIOS() && <IosKeyboardClose />}
                </div>
              </LinkingControllerProvider>
          </ResponsivePaneProvider>
        </AndroidBackHandlerProvider>
      </KeyboardServiceProvider>
    </ApplicationProvider>
  )
}

export default ApplicationView
