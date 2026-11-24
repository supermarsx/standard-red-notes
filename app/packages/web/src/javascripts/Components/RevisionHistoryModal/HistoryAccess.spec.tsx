/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Result, type RevisionMetadata, type SNNote } from '@standardnotes/snjs'
import { NoteHistoryController } from '@/Controllers/NoteHistory/NoteHistoryController'
import RemoteHistoryList from './RemoteHistoryList'
import HistoryModalContentPane from './HistoryModalContentPane'

jest.mock('../NoteView/ReadonlyNoteContent', () => ({
  ReadonlyNoteContent: ({ content }: { content: { text: string } }) => content.text,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('opens an old revision from the history list without any subscription service or upgrade prompt', async () => {
  const note = { uuid: 'owned-note', content: { title: 'Today', text: 'Current version' } } as SNNote
  const entry = {
    uuid: 'old-version',
    created_at: '2024-01-01T12:00:00Z',
    required_role: 'pro-user',
  } as RevisionMetadata
  const content = { title: 'Earlier', text: 'Saved text from an earlier year' }
  const getRevision = { execute: jest.fn().mockResolvedValue(Result.ok({ payload: { uuid: note.uuid, content } })) }
  const controller = new NoteHistoryController(
    note,
    {} as never,
    { findItem: () => note } as never,
    {} as never,
    {} as never,
    { getExtensions: () => [], loadExtensionInContextOfItem: jest.fn() } as never,
    { sessionHistoryForItem: () => [] } as never,
    {} as never,
    getRevision as never,
    { execute: jest.fn().mockResolvedValue(Result.ok([])) } as never,
    {} as never,
    {} as never,
  )
  await controller.fetchAllHistory()
  controller.setRemoteHistory([{ title: 'More Than A Year Ago', entries: [entry] }])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSelectRevision = jest.fn()
  try {
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(RemoteHistoryList, { noteHistoryController: controller, onSelectRevision }),
          createElement(HistoryModalContentPane, { noteHistoryController: controller, note }),
        ),
      )
    })
    const revisionButton = container.querySelector('button[data-selected]') as HTMLButtonElement
    expect(revisionButton).not.toBeNull()
    await act(async () => revisionButton.click())
    expect(getRevision.execute).toHaveBeenCalledWith({ itemUuid: note.uuid, revisionUuid: entry.uuid })
    expect(container.textContent).toContain(content.text)
    expect(container.textContent).not.toMatch(/upgrade|discover plans|history is limited/i)
    expect(onSelectRevision).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    controller.deinit()
    container.remove()
  }
})
