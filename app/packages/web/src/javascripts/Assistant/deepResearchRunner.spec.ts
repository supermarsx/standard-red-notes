import { WebApplication } from '@/Application/WebApplication'
import { DeepResearchReport, runDeepResearch } from './deepResearch'
import { runDeepResearchForApplication } from './deepResearchRunner'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'
import { gatherResearchWebEvidence } from './researchWebEvidence'
import { ContentType } from '@standardnotes/snjs'

jest.mock('./researchWebEvidence', () => ({
  ...jest.requireActual('./researchWebEvidence'),
  gatherResearchWebEvidence: jest.fn(),
}))

jest.mock('./deepResearch', () => ({
  ...jest.requireActual('./deepResearch'),
  runDeepResearch: jest.fn(),
}))

jest.mock('./selectionActions', () => ({
  getSelectionAIAvailability: jest.fn(),
  runOneShotCompletion: jest.fn(),
}))

const availabilityMock = jest.mocked(getSelectionAIAvailability)
const completionMock = jest.mocked(runOneShotCompletion)
const deepResearchMock = jest.mocked(runDeepResearch)
const gatherMock = jest.mocked(gatherResearchWebEvidence)

const report: DeepResearchReport = {
  question: 'topic',
  report: 'report',
  sources: [],
  rounds: 2,
  stopReason: 'model-finished',
}

describe('deep research application lifecycle', () => {
  beforeEach(() => {
    availabilityMock.mockReturnValue({ available: true })
    completionMock.mockResolvedValue('provider response')
    gatherMock.mockResolvedValue({
      status: 'retrieved',
      sources: [{ title: 'Source', url: 'https://source.example/report', text: 'Evidence' }],
    })
  })

  const applicationFor = (user: () => string) =>
    ({
      sessions: { isSignedIn: () => true, getUser: () => ({ uuid: user() }) },
      items: { getItems: jest.fn(() => []) },
    }) as unknown as WebApplication

  it('passes approved topic evidence into synthesis without sending note content as a search query', async () => {
    const application = applicationFor(() => 'account-a')
    deepResearchMock.mockResolvedValue(report)
    const requestConfirmation = jest.fn().mockResolvedValue(true)
    const signal = new AbortController().signal
    await runDeepResearchForApplication(application, 'topic', { includeWeb: true, signal, requestConfirmation })
    expect(gatherMock).toHaveBeenCalledWith(
      application,
      'topic',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        requestConfirmation,
        isCurrent: expect.any(Function),
      }),
    )
    expect(deepResearchMock.mock.calls[0][3]?.webEvidence?.sources[0].text).toBe('')
    expect(deepResearchMock.mock.calls[0][3]?.webSummary).toBe('provider response')
  })

  it('does not start local reads or provider work when the account changes during web gathering', async () => {
    let user = 'account-a'
    const application = applicationFor(() => user)
    gatherMock.mockImplementation(async (_app, _topic, options) => {
      user = 'account-b'
      expect(options.isCurrent()).toBe(false)
      return { status: 'unavailable', sources: [] }
    })
    await expect(runDeepResearchForApplication(application, 'topic', { includeWeb: true })).resolves.toBeNull()
    expect(application.items.getItems).not.toHaveBeenCalled()
    expect(deepResearchMock).not.toHaveBeenCalled()
    expect(completionMock).not.toHaveBeenCalled()
  })

  it('keeps existing local-only callers off the web', async () => {
    deepResearchMock.mockResolvedValue(report)
    await runDeepResearchForApplication(
      applicationFor(() => 'account-a'),
      'topic',
    )
    expect(gatherMock).not.toHaveBeenCalled()
  })

  it('never reads locked, lite, or render-denied note contents into the research corpus', async () => {
    const application = applicationFor(() => 'account-a')
    const notes = ['allowed', 'locked', 'lite', 'denied', 'authorization-threw'].map((uuid) => ({
      uuid,
      content_type: ContentType.TYPES.Note,
      locked: uuid === 'locked',
      payload: uuid === 'lite' ? { content: { __lazyLite: true } } : undefined,
      get title() {
        if (uuid !== 'allowed') throw new Error('Private title read')
        return 'Allowed'
      },
      get text() {
        if (uuid !== 'allowed') throw new Error('Private body read')
        return 'Readable evidence'
      },
    }))
    jest.mocked(application.items.getItems).mockReturnValue(notes as never)
    application.isAuthorizedToRenderItem = jest.fn((note) => {
      if (note.uuid === 'authorization-threw') throw new Error('locked')
      return note.uuid === 'allowed' || note.uuid === 'lite'
    })
    deepResearchMock.mockResolvedValue(report)
    await runDeepResearchForApplication(application, 'topic')
    expect(deepResearchMock.mock.calls[0][1]).toEqual([
      { uuid: 'allowed', title: 'Allowed', text: 'Readable evidence' },
    ])
  })

  it('stops further model work when a previously captured source becomes locked mid-run', async () => {
    const application = applicationFor(() => 'account-a')
    const note = {
      uuid: 'source',
      content_type: ContentType.TYPES.Note,
      locked: false,
      title: 'Source',
      text: 'Private evidence',
    }
    jest.mocked(application.items.getItems).mockReturnValue([note] as never)
    application.isAuthorizedToRenderItem = jest.fn(() => true)
    completionMock.mockImplementation(async () => {
      note.locked = true
      return 'First response'
    })
    deepResearchMock.mockImplementation(async (_question, _corpus, complete) => {
      await complete('system', 'user')
      await complete('system again', 'cached private evidence')
      return report
    })
    await expect(runDeepResearchForApplication(application, 'topic')).rejects.toThrow(
      'access to its source notes changed',
    )
    expect(completionMock).toHaveBeenCalledTimes(1)
  })

  it('refuses the next provider continuation after the initiating account changes', async () => {
    let userUuid = 'account-a'
    const application = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: userUuid }),
      },
      items: { getItems: jest.fn(() => []) },
    } as unknown as WebApplication

    deepResearchMock.mockImplementation(async (_question, _corpus, complete) => {
      await complete('first system', 'first user')
      userUuid = 'account-b'
      await complete('second system', 'second user')
      return report
    })

    await expect(runDeepResearchForApplication(application, 'topic')).rejects.toThrow('active account changed')
    expect(completionMock).toHaveBeenCalledTimes(1)
  })

  it('does not expose a completed result after the provider changes account mid-flight', async () => {
    let userUuid = 'account-a'
    let resolveCompletion!: (value: string) => void
    const application = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: userUuid }),
      },
      items: { getItems: jest.fn(() => []) },
    } as unknown as WebApplication

    completionMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveCompletion = resolve
      }),
    )
    deepResearchMock.mockImplementation(async (_question, _corpus, complete) => {
      await complete('system', 'user')
      return report
    })

    const pending = runDeepResearchForApplication(application, 'topic')
    userUuid = 'account-b'
    resolveCompletion('private account-a response')

    await expect(pending).rejects.toThrow('active account changed')
  })
})
