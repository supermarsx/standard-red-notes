import { FunctionComponent } from 'react'
import { SNNote } from '@standardnotes/snjs'
import CollaborationStatusIndicator from './CollaborationStatusIndicator'
import NoteStatusIndicator, { NoteStatus } from './NoteStatusIndicator'

type Props = {
  note: SNNote
  status: NoteStatus | undefined
  syncTakingTooLong: boolean
  updateSavingIndicator?: boolean
}

/**
 * The title bar's status chips, in their fixed reading order: encrypted
 * collaboration first, then note sync.
 *
 * This exists as its own component so that ordering is an observable DOM fact a
 * test can assert, rather than a line buried in NoteView's several-hundred-line
 * render. Both children hide themselves when they have nothing to say, so on the
 * ordinary path this contributes no markup at all.
 */
const NoteStatusCluster: FunctionComponent<Props> = ({ note, status, syncTakingTooLong, updateSavingIndicator }) => {
  return (
    <div className="flex flex-shrink-0 items-center">
      <CollaborationStatusIndicator noteUuid={note.uuid} />
      <NoteStatusIndicator
        note={note}
        status={status}
        syncTakingTooLong={syncTakingTooLong}
        updateSavingIndicator={updateSavingIndicator}
      />
    </div>
  )
}

export default NoteStatusCluster
