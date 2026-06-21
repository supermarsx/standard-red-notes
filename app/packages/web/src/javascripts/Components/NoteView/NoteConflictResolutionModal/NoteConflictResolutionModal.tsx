import { SNNote } from '@standardnotes/snjs'
import { useMemo } from 'react'
import Modal, { ModalAction } from '../../Modal/Modal'
import NoteConflictResolutionView from './NoteConflictResolutionView'

const NoteConflictResolutionModal = ({
  currentNote,
  conflictedNotes,
  close,
}: {
  currentNote: SNNote
  conflictedNotes: SNNote[]
  close: () => void
}) => {
  const actions = useMemo(
    (): ModalAction[] => [
      {
        label: 'Cancel',
        onClick: close,
        type: 'cancel',
        mobileSlot: 'left',
      },
    ],
    [close],
  )

  return (
    <Modal
      title="Resolve conflicts"
      className="flex flex-col overflow-hidden"
      actions={actions}
      close={close}
    >
      <NoteConflictResolutionView
        currentNote={currentNote}
        conflictedNotes={conflictedNotes}
        onClose={close}
        className="min-h-0 flex-grow"
      />
    </Modal>
  )
}

export default NoteConflictResolutionModal
