import Button from '../Button/Button'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'

export type AssistantNoticeDismissalMode = 'once' | '15-days' | 'never'

type Props = {
  onSelect: (mode: AssistantNoticeDismissalMode) => void
  onClose: () => void
}

/** Presentation only: the parent owns the reminder policy and its persistence. */
export function AssistantNoticeDismissal({ onSelect, onClose }: Props) {
  const select = (mode: AssistantNoticeDismissalMode) => {
    onSelect(mode)
    onClose()
  }
  return (
    <ModalOverlay
      isOpen
      close={onClose}
      modal
      aria-label="Hide AI privacy reminder"
      aria-modal="true"
      className="border-border !m-4 !h-auto !max-h-[85vh] !max-w-sm rounded border"
    >
      <Modal
        title="Hide AI privacy reminder"
        close={onClose}
        actions={[{ label: 'Cancel', type: 'cancel', onClick: onClose, mobileSlot: 'left' }]}
      >
        <div className="space-y-3 p-4">
          <p className="text-passive-0 text-sm">Choose when the privacy reminder should appear again.</p>
          <div className="flex flex-col gap-2">
            <Button type="button" fullWidth onClick={() => select('once')}>
              Just this time
            </Button>
            <Button type="button" fullWidth onClick={() => select('15-days')}>
              Remind me in 15 days
            </Button>
            <Button type="button" fullWidth onClick={() => select('never')}>
              Don’t remind me again
            </Button>
          </div>
        </div>
      </Modal>
    </ModalOverlay>
  )
}

export default AssistantNoticeDismissal
