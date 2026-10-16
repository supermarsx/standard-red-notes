/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ReviewTools } from './ReviewTools'
import { mutatePrivateNoteComments } from '@/Comments/PrivateNoteComments'
import { COMMENT_INDICATORS_PREF_KEY } from '@/Comments/CommentPreferences'
import type { ToolbarButtonProps } from './ToolbarButton'

let mockOwner = false
let mockAuthorized = true
const mockUser = { uuid: 'self' }
const mockIdentity = { noteUuid: 'note', userUuid: 'self' }
const mockNote = { uuid: 'note', locked: false, trashed: false }
const mockApplication = {
  items: { findItem: () => mockNote },
  sessions: { getUser: () => mockUser, isCurrentSessionReadOnly: () => false },
  isAuthorizedToRenderItem: () => mockAuthorized,
  alerts: { confirm: jest.fn() },
  setPreference: jest.fn(),
  notesController: { purgeNoteComments: jest.fn() },
}
jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('@/Hooks/usePreference', () => ({ __esModule: true, default: () => undefined }))
jest.mock('@/Comments/CommentPermissions', () => ({ canPurgeAllNoteComments: () => mockOwner }))
jest.mock('../../Collaboration/CollaborationKeyDerivation', () => ({
  resolveNoteEncryptionIdentity: () => mockIdentity,
}))
jest.mock('@/Comments/PrivateNoteComments', () => ({ mutatePrivateNoteComments: jest.fn() }))
jest.mock('@/Comments/useNoteComments', () => ({
  useNoteComments: () => {
    throw new Error('Review must not start a collaboration room')
  },
}))
jest.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [{ dispatchCommand: () => {} }],
}))
jest.mock('../../EditorControlsContext', () => ({ useEditorControlsState: () => ({ openComments: () => {} }) }))
jest.mock('./ToolbarButton', () => ({
  __esModule: true,
  default: ({ name, children, onSelect, active: _active, ...props }: ToolbarButtonProps) => (
    <button {...props} onClick={onSelect}>
      {children ?? name}
    </button>
  ),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  mockOwner = false
  mockAuthorized = true
  mockApplication.alerts.confirm.mockResolvedValue(true)
  mockApplication.setPreference.mockResolvedValue(undefined)
  mockApplication.notesController.purgeNoteComments.mockResolvedValue([])
  jest.mocked(mutatePrivateNoteComments).mockResolvedValue(undefined)
})

async function mount() {
  const element = document.createElement('div')
  const root = createRoot(element)
  await act(async () => root.render(<ReviewTools note={mockNote as never} />))
  return {
    element,
    close: async () => act(async () => root.unmount()),
    click: async (label: string) => {
      const button = element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      if (!button) {
        throw new Error(`Missing ${label}`)
      }
      await act(async () => button.click())
    },
  }
}

it('opens Review without joining a room and hides owner-only purge from members', async () => {
  const view = await mount()
  try {
    expect(view.element.querySelector('[aria-label="Purge all comments"]')).toBeNull()
    await view.click('Show comment indicators')
    expect(mockApplication.setPreference).toHaveBeenCalledWith(COMMENT_INDICATORS_PREF_KEY, false)
  } finally {
    await view.close()
  }
})

it('pairs every visible Review action with a compact decorative icon and visible label', async () => {
  mockOwner = true
  const view = await mount()
  try {
    for (const label of [
      'Show comments',
      'New comment on selection',
      'Show comment indicators',
      'Purge my comments',
      'Purge all comments',
    ]) {
      const button = view.element.querySelector(`button[aria-label="${label}"]`)
      const icon = button?.querySelector('.super-toolbar-icon')
      expect(icon).not.toBeNull()
      expect(icon?.getAttribute('aria-hidden')).toBe('true')
      expect(icon?.classList.contains('shrink-0')).toBe(true)
      expect(button?.textContent?.trim().length).toBeGreaterThan(0)
      expect(icon?.parentElement?.classList.contains('gap-1.5')).toBe(true)
    }
  } finally {
    await view.close()
  }
})

it('requires confirmation and independently removes private and authored shared comments', async () => {
  const view = await mount()
  try {
    mockApplication.alerts.confirm.mockResolvedValueOnce(false)
    await view.click('Purge my comments')
    expect(mutatePrivateNoteComments).not.toHaveBeenCalled()
    expect(mockApplication.notesController.purgeNoteComments).not.toHaveBeenCalled()
    await view.click('Purge my comments')
    expect(mutatePrivateNoteComments).toHaveBeenCalledWith(mockApplication, 'note', expect.any(Function))
    const clear = jest.mocked(mutatePrivateNoteComments).mock.calls[0][2]
    expect(clear([{} as never])).toEqual([])
    expect(mockApplication.notesController.purgeNoteComments).toHaveBeenCalledWith(mockNote, 'mine', mockIdentity)
  } finally {
    await view.close()
  }
})

it('rechecks ownership and access after the confirmation dialog', async () => {
  mockOwner = true
  const view = await mount()
  try {
    mockApplication.alerts.confirm.mockImplementationOnce(async () => {
      mockOwner = false
      return true
    })
    await view.click('Purge all comments')
    expect(mutatePrivateNoteComments).not.toHaveBeenCalled()
    expect(mockApplication.notesController.purgeNoteComments).not.toHaveBeenCalled()
    expect(view.element.querySelector('[role="alert"]')?.textContent).toContain('could not be removed')
  } finally {
    await view.close()
  }
})

it('the owner can purge all shared comments while clearing only their own private storage', async () => {
  mockOwner = true
  const view = await mount()
  try {
    await view.click('Purge all comments')
    expect(mockApplication.notesController.purgeNoteComments).toHaveBeenCalledWith(mockNote, 'all', mockIdentity)
    expect(mockApplication.alerts.confirm.mock.calls[0][0]).toContain(
      'Other people’s private comments are not affected',
    )
  } finally {
    await view.close()
  }
})
