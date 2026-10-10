import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { CaldavTodosController } from './CaldavTokensController'
import { CaldavService } from '../../Service/Caldav/CaldavService'
import { PublishedTodo } from '../../Service/Caldav/ICalendarSerializer'

/**
 * The publish endpoint's field allowlist.
 *
 * This exists because `categories` and `recurrence` were added to the store's
 * schema, the serializer and the projection, and then DROPPED here: the
 * controller rebuilds the record field by field, so a field it does not name is
 * accepted with a 200 and stored as nothing. The live feed then showed a
 * repeating task as a one-off and `recurrence: 'ignore'` had no one to ignore.
 * Nothing above this layer could see it, because every layer above was handed a
 * record that genuinely had no rule.
 *
 * So: one assertion per forwarded field, read off what the service was handed.
 */
describe('CaldavTodosController publish: the forwarded field set', () => {
  let caldavService: jest.Mocked<CaldavService>
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const controller = () => new CaldavTodosController(caldavService as unknown as CaldavService)

  const responseWith = (): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: 'user-1' }, settings: { [SettingName.NAMES.CaldavEnabled]: 'true' } },
      json: jsonMock,
      status: statusMock,
    } as unknown as Response
  }

  const publish = async (body: Record<string, unknown>): Promise<PublishedTodo | undefined> => {
    const response = responseWith()
    await controller().publish({ body } as Request, response)
    return caldavService.publishTodo.mock.calls[0]?.[1] as PublishedTodo | undefined
  }

  beforeEach(() => {
    caldavService = {
      isEnabled: jest.fn().mockReturnValue(true),
      publishTodo: jest.fn(async (_uuid: string, todo: PublishedTodo) => todo),
      listTodos: jest.fn(),
      unpublishTodo: jest.fn(),
    } as unknown as jest.Mocked<CaldavService>
  })

  it('forwards EVERY field the store accepts', async () => {
    const stored = await publish({
      uid: 'task-1',
      summary: 'File taxes',
      description: 'from a note',
      start: '2026-04-01',
      due: '2026-04-15',
      completed: false,
      priority: 3,
      categories: ['Work', 'Finance'],
      recurrence: { frequency: 'monthly', monthDay: 31, timeZone: 'Europe/Berlin' },
    })
    expect(stored).toEqual({
      uid: 'task-1',
      summary: 'File taxes',
      description: 'from a note',
      start: '2026-04-01',
      due: '2026-04-15',
      completed: false,
      priority: 3,
      categories: ['Work', 'Finance'],
      recurrence: { frequency: 'monthly', monthDay: 31, timeZone: 'Europe/Berlin' },
    })
  })

  it('normalizes the repeat rule rather than storing it raw', async () => {
    const stored = await publish({
      summary: 'Daily',
      due: '2026-04-15',
      // An interval of 1 is redundant, so it is dropped: two equal rules must
      // compare equal in the store.
      recurrence: { frequency: 'daily', interval: 1 },
    })
    expect(stored?.recurrence).toEqual({ frequency: 'daily' })
  })

  it('REFUSES an unrecognized repeat rule instead of publishing a record without one', async () => {
    const response = responseWith()
    await controller().publish(
      { body: { summary: 'x', due: '2026-04-15', recurrence: { frequency: 'hourly' } } } as Request,
      response,
    )
    expect(statusMock).toHaveBeenCalledWith(400)
    expect(caldavService.publishTodo).not.toHaveBeenCalled()
  })

  it('REFUSES a malformed category list rather than quietly dropping it', async () => {
    for (const categories of ['Work', 7, [1, 2], [{}]]) {
      const response = responseWith()
      await controller().publish({ body: { summary: 'x', due: '2026-04-15', categories } } as Request, response)
      expect(statusMock).toHaveBeenCalledWith(400)
    }
    expect(caldavService.publishTodo).not.toHaveBeenCalled()
  })

  it('accepts an empty category list', async () => {
    expect((await publish({ summary: 'x', due: '2026-04-15', categories: [] }))?.categories).toEqual([])
  })

  it('omits both fields entirely when they were not sent', async () => {
    const stored = await publish({ summary: 'x', due: '2026-04-15' })
    expect(stored && 'categories' in stored).toBe(false)
    expect(stored && 'recurrence' in stored).toBe(false)
  })
})
