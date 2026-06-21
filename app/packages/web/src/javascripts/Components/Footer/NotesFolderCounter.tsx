import { observer } from 'mobx-react-lite'
import { FunctionComponent } from 'react'
import { WebApplication } from '@/Application/WebApplication'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: a quiet footer status counter of the total number of
 * notes (and folders and tags) in the account. Reads observable counts off the
 * navigation controller so it updates live as items are created/deleted —
 * `allNotesCount` is the total countable notes (the same figure shown for the
 * "Notes" smart view), independent of the current tag/folder selection.
 */
const NotesFolderCounter: FunctionComponent<Props> = ({ application }) => {
  const nav = application.navigationController
  const notes = nav.allNotesCount
  const folders = nav.folders.length
  const tags = nav.tags.length

  const notesLabel = `${notes.toLocaleString()} ${notes === 1 ? 'note' : 'notes'}`
  const foldersLabel =
    folders > 0 ? ` · ${folders.toLocaleString()} ${folders === 1 ? 'folder' : 'folders'}` : ''
  const tagsLabel = tags > 0 ? ` · ${tags.toLocaleString()} ${tags === 1 ? 'tag' : 'tags'}` : ''
  const label = `${notesLabel}${foldersLabel}${tagsLabel}`

  return (
    <div className="select-none whitespace-nowrap text-xs font-bold text-neutral" title={label}>
      {label}
    </div>
  )
}

export default observer(NotesFolderCounter)
