/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import TrashActionsBar from './TrashActionsBar'
jest.mock('@standardnotes/snjs', () => ({ isNote: (item: { content_type: string }) => item.content_type === 'Note' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const fixture = () => {
  const note = { uuid: 'trash', content_type: 'Note', trashed: true, protected: false, locked: false }
  return {
    note,
    application: {
      itemListController: {
        items: [note, { uuid: 'live', content_type: 'Note', trashed: false }],
        selectUuids: jest.fn(async () => undefined),
      },
      notesController: {
        selectedNotes: [note],
        setTrashSelectedNotes: jest.fn(async () => undefined),
        deleteNotesPermanently: jest.fn(async () => undefined),
        emptyTrash: jest.fn(async () => undefined),
      },
      items: { trashedItems: [note] },
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      isAuthorizedToRenderItem: () => true,
    },
  }
}
const click = async (label: string) => {
  await act(async () => {
    ;[...container.querySelectorAll('button')].find((button) => button.textContent === label)!.click()
    await Promise.resolve()
  })
}
it('selects only displayed trashed notes and uses the existing confirmed permanent-delete and empty-trash paths', async () => {
  const { application } = fixture()
  await act(async () => root.render(createElement(TrashActionsBar, { application: application as never })))
  await click('Select all')
  expect(application.itemListController.selectUuids).toHaveBeenCalledWith(['trash'], true)
  await click('Delete selected permanently')
  expect(application.notesController.deleteNotesPermanently).toHaveBeenCalledTimes(1)
  await click('Empty trash')
  expect(application.notesController.emptyTrash).toHaveBeenCalledTimes(1)
})
it('prevents destructive actions for locked or inaccessible trash', async () => {
  const { application, note } = fixture()
  note.locked = true
  await act(async () => root.render(createElement(TrashActionsBar, { application: application as never })))
  expect(
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Empty trash')!.disabled,
  ).toBe(true)
  expect(
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete selected permanently')!
      .disabled,
  ).toBe(true)
})
