import { ReactNode, useEffect, useState } from 'react'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import { ElementIds } from '@/Constants/ElementIDs'
import AssistantView from '../Assistant/AssistantView'

type Props = {
  application: WebApplication
  className: string
  /**
   * True while the Assistant pane is part of the visible pane layout (including
   * its exit transition). A false value hides an already-mounted assistant but
   * deliberately does not tear down its active conversations.
   */
  visible: boolean
  children?: ReactNode
}

/**
 * Owns the AssistantView independently of transient pane layouts.
 *
 * The view is not created until it is opened for the first time, avoiding the
 * cost of loading persisted conversations during normal startup. After that
 * first open it remains mounted and is only CSS-hidden when the pane is
 * dismissed or a mobile layout replacement temporarily omits it. This keeps
 * in-flight provider streams, queued prompts, and inline approvals alive while
 * the user works elsewhere in the app. Account transitions still tear down the
 * account-keyed panels inside AssistantView itself.
 */
const PersistentAssistantPane = ({ application, className, visible, children }: Props) => {
  const [hasOpened, setHasOpened] = useState(visible)

  useEffect(() => {
    if (visible) {
      setHasOpened(true)
    }
  }, [visible])

  if (!visible && !hasOpened) {
    return null
  }

  return (
    <AssistantView
      id={ElementIds.AssistantColumn}
      className={classNames(className, !visible && 'hidden')}
      application={application}
    >
      {children}
    </AssistantView>
  )
}

export default PersistentAssistantPane
