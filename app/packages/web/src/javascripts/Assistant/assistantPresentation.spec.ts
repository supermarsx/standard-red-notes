import {
  describeAssistantTool,
  describeAssistantToolConfirmation,
  formatAssistantConfirmationText,
  isIrreversibleAssistantTool,
} from './assistantPresentation'

describe('assistant tool presentation', () => {
  it('uses a friendly activity label instead of the internal tool name', () => {
    expect(describeAssistantTool('notes.updateSuper', { title: 'Launch plan', markdown: '# Updated' })).toEqual({
      label: 'Updating a note',
      detail: 'Updating “Launch plan”',
    })
  })

  it('formats mutating actions as bounded human-readable approvals', () => {
    const confirmation = describeAssistantToolConfirmation({
      name: 'notes.create',
      args: { title: 'Project brief', text: 'a'.repeat(500), apiKey: 'do-not-show' },
    })

    expect(confirmation.title).toBe('Allow assistant action')
    expect(confirmation.confirmButtonText).toBe('Allow')
    const text = formatAssistantConfirmationText(confirmation)
    expect(text).toContain('Creating a note')
    expect(text).toContain('Title: Project brief')
    expect(text).toContain('Api Key: [hidden]')
    expect(text).toContain('…')
    expect(text).not.toContain('"title"')
    expect(text).not.toContain('do-not-show')
    expect(confirmation.reviewIncomplete).toBe(true)
  })

  it('marks irreversible actions as dangerous', () => {
    const confirmation = describeAssistantToolConfirmation({ name: 'notes.delete', args: { uuid: 'private-id' } })
    expect(confirmation.title).toBe('Confirm assistant action')
    expect(confirmation.confirmButtonStyle).toBe('danger')
    expect(formatAssistantConfirmationText(confirmation)).not.toContain('private-id')
    expect(confirmation.reviewIncomplete).toBe(false)
  })

  it('treats resetting achievement history as irreversible', () => {
    const request = { name: 'configure_achievements', args: { setting: 'reset' } }
    expect(isIrreversibleAssistantTool(request)).toBe(true)
    expect(describeAssistantToolConfirmation(request)).toMatchObject({
      title: 'Confirm assistant action',
      confirmButtonStyle: 'danger',
    })
  })

  it('prioritizes trusted target identities ahead of verbose model arguments', () => {
    const confirmation = describeAssistantToolConfirmation({
      name: 'reminders.set',
      args: {
        uuid: 'private-id',
        datetime: '2027-01-01T00:00:00Z',
        message: 'Long reminder',
        recurrence: { frequency: 'weekly' },
        email: false,
        extra: 'detail',
        targetTitle: 'Trusted note',
        targetShortId: '12345678',
      },
    })

    expect(confirmation.fields.slice(0, 2)).toEqual([
      { label: 'Target Title', value: 'Trusted note' },
      { label: 'Target Short Id', value: '12345678' },
    ])
    expect(formatAssistantConfirmationText(confirmation)).not.toContain('private-id')
  })
})
