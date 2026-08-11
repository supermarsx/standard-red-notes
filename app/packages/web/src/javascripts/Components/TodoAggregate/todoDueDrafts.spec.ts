import { clearTodoDueDraft, setTodoDueDraft, todoDueInputValue, TodoDueDrafts } from './todoDueDrafts'
import { checklistDueAtToLocalInput } from '../SuperEditor/Checklist/checklistDueDate'

describe('Todo due-date draft truthfulness', () => {
  it('restores an empty persisted value after a failed first date save', () => {
    let drafts: TodoDueDrafts = new Map()
    drafts = setTodoDueDraft(drafts, 'todo-a', '2026-08-14T12:30')
    expect(todoDueInputValue(drafts, 'todo-a')).toBe('2026-08-14T12:30')

    drafts = clearTodoDueDraft(drafts, 'todo-a')
    expect(todoDueInputValue(drafts, 'todo-a')).toBe('')
  })

  it('restores the prior persisted date after a failed date change', () => {
    const persisted = '2026-08-12T12:30:00.000Z'
    let drafts: TodoDueDrafts = new Map()
    drafts = setTodoDueDraft(drafts, 'todo-a', '2026-08-20T08:00')
    expect(todoDueInputValue(drafts, 'todo-a', persisted)).toBe('2026-08-20T08:00')

    drafts = clearTodoDueDraft(drafts, 'todo-a')
    expect(todoDueInputValue(drafts, 'todo-a', persisted)).toBe(checklistDueAtToLocalInput(persisted))
  })
})
