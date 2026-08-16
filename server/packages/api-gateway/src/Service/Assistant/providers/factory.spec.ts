import { listProviderModels } from './factory'

describe('OpenAI-compatible model discovery', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('does not advertise models that explicitly omit tool support', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'tool-model', supported_parameters: ['tools', 'temperature'] },
          { id: 'no-tool-model', supported_parameters: ['temperature'] },
          { id: 'empty-capabilities', supported_parameters: [] },
          { id: 'metadata-absent' },
          { id: 'metadata-malformed', supported_parameters: 'tools' },
        ],
      }),
    }) as unknown as typeof fetch

    await expect(
      listProviderModels('openai', {
        openaiApiKey: 'test-key',
        openaiBaseURL: 'https://openrouter.ai/api/v1',
      }),
    ).resolves.toEqual(['tool-model', 'metadata-absent', 'metadata-malformed'])

    expect(global.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key' }) }),
    )
  })
})
