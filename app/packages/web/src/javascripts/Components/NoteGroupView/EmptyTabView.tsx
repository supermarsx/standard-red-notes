import { FunctionComponent } from 'react'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '../Icon/Icon'
import Button from '../Button/Button'

type Props = {
  application: WebApplication
  /** The id of the empty view tab this view is rendered for, so it can close itself. */
  tabId: string
  className?: string
}

/**
 * Standard Red Notes: placeholder content shown for an empty view tab (opened by
 * the tab-bar "+" when the new-tab behavior is set to "empty"). Offers the user a
 * way forward without forcing a new note to exist: create one in place, or pick an
 * existing note from the list.
 *
 * "New note" creates the note in this tab's place — it opens a new note tile and
 * closes this empty tab, so the empty tab is effectively replaced by a real note
 * tab.
 */
const EmptyTabView: FunctionComponent<Props> = ({ application, tabId, className }) => {
  const createNoteInPlace = () => {
    void application.itemListController.openNewNoteInNewTile()
    application.paneController.closeViewTab(tabId)
  }

  return (
    <div className={classNames('flex min-h-0 flex-grow flex-col items-center justify-center p-6', className)}>
      <div className="flex max-w-sm flex-col items-center text-center">
        <Icon type="add" size="large" className="mb-3 text-passive-1" />
        <h2 className="mb-1 text-lg font-semibold text-text">Empty tab</h2>
        <p className="mb-5 text-sm text-passive-1">
          This tab is empty. Create a new note here, or open an existing note from the list.
        </p>
        <Button primary onClick={createNoteInPlace}>
          New note
        </Button>
        <p className="mt-4 text-xs text-passive-2">Or select a note from the list to open it here.</p>
      </div>
    </div>
  )
}

export default EmptyTabView
