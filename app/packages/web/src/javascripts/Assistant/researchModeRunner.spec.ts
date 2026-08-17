import { WebApplication } from '@/Application/WebApplication'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'
import { runResearchModeForApplication } from './researchModeRunner'
import { savePersonaSettings } from './personaSettings'

jest.mock('./selectionActions', () => ({
  getSelectionAIAvailability: jest.fn(),
  runOneShotCompletion: jest.fn(),
}))

const availabilityMock = jest.mocked(getSelectionAIAvailability)
const completionMock = jest.mocked(runOneShotCompletion)

const createApplication = () => {
  let userUuid: string | undefined = 'account-a'
  const liveItems = new Map<string, { uuid: string }>()
  const createTemplateItem = jest.fn((contentType, content) => ({
    uuid: 'created-note',
    content_type: contentType,
    content,
  }))
  const findItem = jest.fn((uuid: string) => liveItems.get(uuid))
  const insertItem = jest.fn(async (item: { uuid: string }) => {
    liveItems.set(item.uuid, item)
    return item
  })
  const setItemToBeDeleted = jest.fn(async (item: { uuid: string }) => {
    liveItems.delete(item.uuid)
  })
  const application = {
    identifier: 'local-workspace',
    sessions: {
      isSignedIn: () => userUuid !== undefined,
      getUser: () => (userUuid ? { uuid: userUuid } : undefined),
    },
    items: { createTemplateItem, findItem },
    mutator: { insertItem, setItemToBeDeleted },
  } as unknown as WebApplication

  return {
    application,
    createTemplateItem,
    liveItems,
    insertItem,
    setItemToBeDeleted,
    setUserUuid: (next: string | undefined) => {
      userUuid = next
    },
  }
}

describe('research mode application lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    availabilityMock.mockReturnValue({ available: true })
  })

  it('accepts a refreshed User object for the same stable account', async () => {
    const harness = createApplication()
    completionMock.mockResolvedValue('# Verified title\n\nReport')

    await expect(runResearchModeForApplication(harness.application, 'topic')).resolves.toMatchObject({
      noteUuid: 'created-note',
      result: { title: 'Verified title', topic: 'topic' },
    })
    expect(harness.createTemplateItem).toHaveBeenCalledTimes(1)
    expect(harness.insertItem).toHaveBeenCalledTimes(1)
    expect(harness.setItemToBeDeleted).not.toHaveBeenCalled()
  })

  it('passes the initiating account persona explicitly to the pure research API', async () => {
    const harness = createApplication()
    savePersonaSettings('account:account-a', { persona: 'Account A research voice.' })
    completionMock.mockResolvedValue('# Scoped title\n\nReport')

    await runResearchModeForApplication(harness.application, 'topic')

    expect(completionMock.mock.calls[0][1]).toContain('Account A research voice.')
  })

  it('does not create a note when the account changes while the provider is pending', async () => {
    const harness = createApplication()
    let resolveCompletion!: (value: string) => void
    completionMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveCompletion = resolve
      }),
    )

    const pending = runResearchModeForApplication(harness.application, 'private account-a topic')
    expect(completionMock).toHaveBeenCalledTimes(1)

    harness.setUserUuid('account-b')
    resolveCompletion('# Must not be inserted\n\nPrivate result')

    await expect(pending).rejects.toThrow('active account changed')
    expect(harness.createTemplateItem).not.toHaveBeenCalled()
    expect(harness.insertItem).not.toHaveBeenCalled()
  })

  it('removes only the generated note when the account changes while insertion is pending', async () => {
    const harness = createApplication()
    const existingNote = { uuid: 'existing-account-b-note' }
    harness.liveItems.set(existingNote.uuid, existingNote)
    completionMock.mockResolvedValue('# Must be discarded\n\nPrivate result')
    let releaseInsert!: () => void
    let markInsertStarted!: () => void
    const insertStarted = new Promise<void>((resolve) => {
      markInsertStarted = resolve
    })
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve
    })
    harness.insertItem.mockImplementation(async (item: { uuid: string }) => {
      harness.liveItems.set(item.uuid, item)
      markInsertStarted()
      await insertGate
      return item
    })

    const pending = runResearchModeForApplication(harness.application, 'private account-a topic')
    await insertStarted
    const generatedTemplate = harness.createTemplateItem.mock.results[0]?.value

    harness.setUserUuid('account-b')
    releaseInsert()

    await expect(pending).resolves.toBeNull()
    expect(harness.setItemToBeDeleted).toHaveBeenCalledTimes(1)
    expect(harness.setItemToBeDeleted).toHaveBeenCalledWith(generatedTemplate)
    expect(harness.liveItems.has('created-note')).toBe(false)
    expect(harness.liveItems.get(existingNote.uuid)).toBe(existingNote)
  })

  it('removes the generated note when a key transition aborts a pending insertion', async () => {
    const harness = createApplication()
    const controller = new AbortController()
    completionMock.mockResolvedValue('# Must be discarded\n\nPrivate result')
    let releaseInsert!: () => void
    let markInsertStarted!: () => void
    const insertStarted = new Promise<void>((resolve) => {
      markInsertStarted = resolve
    })
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve
    })
    harness.insertItem.mockImplementation(async (item: { uuid: string }) => {
      harness.liveItems.set(item.uuid, item)
      markInsertStarted()
      await insertGate
      return item
    })

    const pending = runResearchModeForApplication(harness.application, 'private account-a topic', {
      signal: controller.signal,
    })
    await insertStarted

    controller.abort()
    releaseInsert()

    await expect(pending).resolves.toBeNull()
    expect(harness.setItemToBeDeleted).toHaveBeenCalledWith(harness.createTemplateItem.mock.results[0]?.value)
    expect(harness.liveItems.has('created-note')).toBe(false)
  })

  it('fails closed when compensation does not remove the generated note', async () => {
    const harness = createApplication()
    completionMock.mockResolvedValue('# Must not be exposed\n\nPrivate result')
    let releaseInsert!: () => void
    let markInsertStarted!: () => void
    const insertStarted = new Promise<void>((resolve) => {
      markInsertStarted = resolve
    })
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve
    })
    harness.insertItem.mockImplementation(async (item: { uuid: string }) => {
      harness.liveItems.set(item.uuid, item)
      markInsertStarted()
      await insertGate
      return item
    })
    harness.setItemToBeDeleted.mockResolvedValue(undefined)

    const pending = runResearchModeForApplication(harness.application, 'private account-a topic')
    await insertStarted

    harness.setUserUuid('account-b')
    releaseInsert()

    await expect(pending).rejects.toThrow('could not safely discard')
    expect(harness.setItemToBeDeleted).toHaveBeenCalledWith(harness.createTemplateItem.mock.results[0]?.value)
  })
})
