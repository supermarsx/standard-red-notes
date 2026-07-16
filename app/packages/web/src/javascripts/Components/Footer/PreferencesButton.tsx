import { compareSemVersions, PrefKey, StatusServiceEvent } from '@standardnotes/snjs'
import { keyboardStringForShortcut, OPEN_PREFERENCES_COMMAND } from '@standardnotes/ui-services'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApplication } from '../ApplicationProvider'
import { useKeyboardService } from '../KeyboardServiceProvider'
import Icon from '../Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import RoundIconButton from '../Button/RoundIconButton'
import CountBubble from '../Preferences/PreferencesComponents/CountBubble'
import usePreference from '@/Hooks/usePreference'

type Props = {
  openPreferences: (openWhatsNew: boolean) => void
}

const PreferencesButton = ({ openPreferences }: Props) => {
  const application = useApplication()

  const keyboardService = useKeyboardService()
  const shortcut = useMemo(
    () => keyboardStringForShortcut(keyboardService.keyboardShortcutForCommand(OPEN_PREFERENCES_COMMAND)),
    [keyboardService],
  )

  // Standard Red Notes: the What's New section is opt-in (hidden by default).
  // While hidden, the unread-changelog dot and the "open preferences straight to
  // What's New" behavior are suppressed as well.
  const showWhatsNewSection = usePreference(PrefKey.ShowWhatsNewSection)

  const [changelogLastReadVersion, setChangelogLastReadVersion] = useState(() =>
    application.changelogService.getLastReadVersion(),
  )
  const isChangelogUnread = useMemo(() => {
    return showWhatsNewSection && changelogLastReadVersion && !application.isNativeMobileWeb()
      ? compareSemVersions(application.version, changelogLastReadVersion) > 0
      : false
  }, [application, changelogLastReadVersion, showWhatsNewSection])
  useEffect(
    () => application.changelogService.addLastReadChangeListener(setChangelogLastReadVersion),
    [application.changelogService],
  )

  const onClick = useCallback(() => {
    openPreferences(isChangelogUnread)
  }, [isChangelogUnread, openPreferences])

  const [bubbleCount, setBubbleCount] = useState<string | undefined>()
  useEffect(() => {
    return application.status.addEventObserver((event, message) => {
      if (event !== StatusServiceEvent.PreferencesBubbleCountChanged) {
        return
      }
      setBubbleCount(message)
    })
  }, [application.status])

  const isMobileScreen = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  if (isMobileScreen) {
    return (
      <div className="relative">
        <RoundIconButton className="bg-default ml-2.5" onClick={onClick} label="Go to preferences" icon="tune" />
        <CountBubble position="right" count={bubbleCount} />
      </div>
    )
  }

  return (
    <StyledTooltip label={`Open preferences (${shortcut})`}>
      <button onClick={onClick} className="group relative flex h-full w-8 cursor-pointer items-center justify-center">
        <div className="relative h-5">
          <Icon type="tune" className="group-hover:text-info rounded" />
          <CountBubble position="right" count={bubbleCount} />
        </div>
        {isChangelogUnread && <div className="bg-info absolute top-0.5 right-0.5 h-2 w-2 rounded-full" />}
      </button>
    </StyledTooltip>
  )
}

export default PreferencesButton
