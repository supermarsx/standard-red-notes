import type { WebApplication } from '@/Application/WebApplication'
import { ContentType } from '@standardnotes/snjs'
import { captureAssistantCommentTarget, registerCommentTargetBridge } from './CommentTargets'

function fixture() {
  let user = { uuid: 'self' }
  let note: { uuid: string; content_type: string; locked: boolean; shared_vault_uuid?: string } = {
    uuid: 'note',
    content_type: ContentType.TYPES.Note,
    locked: false,
  }
  const application = {
    sessions: { getUser: () => user },
    items: { findItem: () => note },
    isAuthorizedToRenderItem: () => true,
  } as unknown as WebApplication
  return {
    application,
    note,
    replaceSession: () => {
      user = { uuid: 'self' }
    },
    replaceNote: () => {
      note = { ...note, shared_vault_uuid: 'changed' }
    },
  }
}

it('requires a live editor for anchored targets and scopes each bridge to its exact application', () => {
  const a = fixture(),
    b = fixture()
  const stop = registerCommentTargetBridge(a.application, 'note', {
    capture: () => ({ anchor: { kind: 'checklist', todoId: 'task-1234' }, assertCurrent: () => {} }),
  })
  try {
    expect(captureAssistantCommentTarget(a.application, 'note', 'checklist', 'task-1234').anchor).toEqual({
      kind: 'checklist',
      todoId: 'task-1234',
    })
    expect(() => captureAssistantCommentTarget(b.application, 'note', 'selection')).toThrow('live editor')
    expect(captureAssistantCommentTarget(b.application, 'note', 'note').anchor).toBeUndefined()
  } finally {
    stop()
  }
})

it('rejects same-uuid session replacement, lock and vault changes after capture', () => {
  const a = fixture()
  const one = captureAssistantCommentTarget(a.application, 'note', 'note')
  a.replaceSession()
  expect(() => one.assertCurrent()).toThrow('session changed')
  const two = captureAssistantCommentTarget(a.application, 'note', 'note')
  a.note.locked = true
  expect(() => two.assertCurrent()).toThrow('session changed')
  a.note.locked = false
  const three = captureAssistantCommentTarget(a.application, 'note', 'note')
  a.replaceNote()
  expect(() => three.assertCurrent()).toThrow('encryption identity changed')
})

it('does not let an old editor disposer remove a replacement and rejects captured retired lifetimes', () => {
  const a = fixture()
  const old = registerCommentTargetBridge(a.application, 'note', { capture: () => ({ assertCurrent: () => {} }) })
  const captured = captureAssistantCommentTarget(a.application, 'note', 'note')
  const current = jest.fn()
  const replacement = registerCommentTargetBridge(a.application, 'note', {
    capture: () => ({ assertCurrent: current }),
  })
  old()
  expect(() => captured.assertCurrent()).toThrow('editor changed')
  const next = captureAssistantCommentTarget(a.application, 'note', 'note')
  next.assertCurrent({ sharedMutation: true })
  expect(current).toHaveBeenCalledWith({ sharedMutation: true })
  replacement()
  expect(() => next.assertCurrent()).toThrow('editor changed')
})
