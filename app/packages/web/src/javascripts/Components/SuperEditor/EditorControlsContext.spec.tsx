import { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createEditorControlsState, EditorControlsProvider, useEditorControlsState } from './EditorControlsContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps ribbon state and drafts through a composer replacement and clears them for a different note/session/key identity', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  let controls!: ReturnType<typeof createEditorControlsState>
  function Composer() {
    controls = useEditorControlsState()
    const state = useSyncExternalStore(controls.subscribe, controls.getSnapshot)
    return (
      <span>
        {state.tabId}:{state.commentTarget}:{controls.drafts.get('private:note') ?? ''}
      </span>
    )
  }
  const identity = {}
  const render = (owner: object, composer: string) =>
    root.render(
      <EditorControlsProvider identity={owner}>
        <Composer key={composer} />
      </EditorControlsProvider>,
    )
  await act(async () => render(identity, 'first'))
  await act(async () => {
    controls.drafts.set('private:note', 'Unfinished private comment')
    controls.setCommentTarget('task-1')
    controls.setTab('review')
  })
  await act(async () => render(identity, 'replacement'))
  expect(container.textContent).toBe('review:task-1:Unfinished private comment')
  await act(async () => render({}, 'replacement'))
  expect(container.textContent).not.toContain('Unfinished private comment')
  expect(controls.getSnapshot()).toEqual({ tabId: null, commentTarget: undefined })
  await act(async () => root.unmount())
})

it('preserves the chosen tab during unrelated notifications and accepts contextual-tab restoration callbacks', () => {
  const state = createEditorControlsState()
  const changed = jest.fn()
  const stop = state.subscribe(changed)
  state.setTab('review')
  const review = state.getSnapshot()
  state.setTab((previous) => (previous === 'contextual' ? null : previous))
  expect(state.getSnapshot()).toBe(review)
  expect(changed).toHaveBeenCalledTimes(1)
  stop()
  state.setTab('checklistTab')
  expect(changed).toHaveBeenCalledTimes(1)
})
