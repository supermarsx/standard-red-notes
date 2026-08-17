import { WebApplication } from '@/Application/WebApplication'
import { DeepResearchReport, runDeepResearch } from './deepResearch'
import { runDeepResearchForApplication } from './deepResearchRunner'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'

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
