import { addToast, ToastType } from '@standardnotes/toast'
import { showCollaborationPresenceActivity } from './CollaborationPresenceNotification'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Regular: 'regular' },
}))

describe('showCollaborationPresenceActivity', () => {
  it('suppresses other sessions belonging to this account, without comparing display names', () => {
    showCollaborationPresenceActivity({ action: 'joined', label: 'Me', userUuid: 'self' }, 'self')
    showCollaborationPresenceActivity({ action: 'left', label: 'Me', userUuid: 'self' }, 'self')
    expect(addToast).not.toHaveBeenCalled()
    showCollaborationPresenceActivity({ action: 'joined', label: 'Me', userUuid: 'another-user' }, 'self')
    expect(addToast).toHaveBeenCalledTimes(1)
  })
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
