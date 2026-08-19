import { addToast, ToastType } from '@standardnotes/toast'
import { showCollaborationPresenceActivity } from './CollaborationPresenceNotification'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Regular: 'regular' },
}))

describe('showCollaborationPresenceActivity', () => {
  it('renders joined and left transitions as transient in-app notifications', () => {
    showCollaborationPresenceActivity({ action: 'joined', label: 'Alice' })
    showCollaborationPresenceActivity({ action: 'left', label: 'Alice' })

    expect(addToast).toHaveBeenNthCalledWith(1, {
      type: ToastType.Regular,
      message: 'Alice joined this note.',
    })
    expect(addToast).toHaveBeenNthCalledWith(2, {
      type: ToastType.Regular,
      message: 'Alice left this note.',
    })
  })
})
