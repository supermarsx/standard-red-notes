import { InternetResearchInput, InternetResearchService } from './InternetResearchService'
const setup = (payload: unknown, status = 200) => {
  const fetch = jest
    .fn()
    .mockResolvedValue({ status, text: JSON.stringify(payload), title: '', contentType: 'application/json' })
  return { fetch, service: new InternetResearchService({ fetch }) }
}
const repository = { capability: 'repository', provider: 'github', action: 'metadata', repository: 'org/repo' } as const

describe('InternetResearchService', () => {
  it('uses native metadata and excludes unexpected fields', async () => {
    const { fetch, service } = setup({ full_name: 'org/repo', token: 'never forward' })
    expect((await service.execute(repository)).data).toEqual({ full_name: 'org/repo' })
    expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/org/repo?per_page=10&page=1')
  })
  it.each(['https://localhost/repo', '../repo', 'owner/..', 'owner/repo/extra', 'owner/repo?token=x'])(
    'rejects unsafe repository %s before fetching',
    async (name) => {
      const { fetch, service } = setup({})
      await expect(service.execute({ ...repository, repository: name })).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('encodes GitLab project/file path segments and decodes text', async () => {
    const { fetch, service } = setup({ encoding: 'base64', content: Buffer.from('hello').toString('base64') })
    const result = await service.execute({
      ...repository,
      provider: 'gitlab',
      repository: 'group/sub/repo',
      action: 'file',
      path: 'docs/README.md',
    })
    expect(fetch.mock.calls[0][0]).toContain('/projects/group%2Fsub%2Frepo/repository/files/docs%2FREADME.md?ref=HEAD')
    expect((result.data as { content: string }).content).toBe('hello')
  })
  it.each(['issues', 'pulls', 'releases', 'comments', 'issue', 'pull', 'release'] as const)(
    'routes GitHub %s',
    async (action) => {
      const { fetch, service } = setup([])
      await service.execute({ ...repository, action, number: 7, tag: 'v1/2' })
      const paths = {
        issues: '/issues?',
        pulls: '/pulls?',
        releases: '/releases?',
        comments: '/issues/7/comments?',
        issue: '/issues/7?',
        pull: '/pulls/7?',
        release: '/releases/tags/v1%2F2?',
      }
      expect(fetch.mock.calls[0][0]).toContain(paths[action])
    },
  )
  it.each([{ limit: 21 }, { limit: 0 }, { page: 101 }, { page: 1.5 }, { action: 'issue', number: -1 }])(
    'rejects invalid pagination/identifier %j',
    async (changes) => {
      const { fetch, service } = setup({})
      await expect(service.execute({ ...repository, ...changes } as InternetResearchInput)).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('bounds results and marks full pages', async () => {
    const { service } = setup(Array.from({ length: 25 }, (_, id) => ({ id })))
    expect(await service.execute({ ...repository, action: 'issues', limit: 2, page: 3 })).toMatchObject({
      page: 3,
      hasMore: true,
      data: [{ id: 0 }, { id: 1 }],
    })
  })
  it('searches Crossref metadata', async () => {
    const { fetch, service } = setup({ message: { items: [{ DOI: '10.1234/test', title: ['Research'] }] } })
    expect(
      (
        await service.execute({
          capability: 'academic',
          provider: 'crossref',
          action: 'search',
          query: 'hello world',
          page: 2,
          limit: 5,
        })
      ).data,
    ).toEqual([{ DOI: '10.1234/test', title: ['Research'] }])
    expect(fetch.mock.calls[0][0]).toContain('https://api.crossref.org/works?query=hello+world&rows=5&offset=5&select=')
  })
  it.each([429, 403])('reports rate limit without retry (%s)', async (status) => {
    const { fetch, service } = setup({ message: 'API rate limit exceeded' }, status)
    expect(await service.execute(repository)).toMatchObject({ rateLimited: true, data: null })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves SSRF and transport failure', async () => {
    const { fetch, service } = setup({})
    fetch.mockRejectedValue(new Error('blocked redirect'))
    await expect(service.execute(repository)).rejects.toThrow('blocked redirect')
  })
  it('reports truncated response instead of assuming success', async () => {
    const { fetch, service } = setup({})
    fetch.mockResolvedValue({ status: 200, text: '{broken' })
    expect(await service.execute(repository)).toMatchObject({ data: null, error: expect.stringContaining('invalid') })
  })
  it.each([Buffer.from([0, 1]), Buffer.alloc(65_000, 'a')])('rejects binary/oversized text', async (buffer) => {
    const { service } = setup({ encoding: 'base64', content: buffer.toString('base64') })
    expect(await service.execute({ ...repository, action: 'file', path: 'a.txt' })).toMatchObject({
      data: null,
      error: expect.any(String),
    })
  })
})

describe('native endpoint details', () => {
  it('reads GitLab MR conversations and diffs', async () => {
    const { fetch, service } = setup([])
    await service.execute({ ...repository, provider: 'gitlab', action: 'pull-comments', number: 3 })
    await service.execute({ ...repository, provider: 'gitlab', action: 'pull-files', number: 3 })
    expect(fetch.mock.calls[0][0]).toContain('/merge_requests/3/notes?')
    expect(fetch.mock.calls[1][0]).toContain('/merge_requests/3/diffs?')
  })
  it('does not falsely paginate GitHub contents listings', async () => {
    const { service } = setup([{ name: 'a' }, { name: 'b' }])
    expect(await service.execute({ ...repository, action: 'tree', limit: 1 })).toMatchObject({
      hasMore: false,
      truncated: true,
    })
  })
  it('encodes DOI identifiers rather than treating them as URLs', async () => {
    const { fetch, service } = setup({ message: { DOI: '10.1234/test' } })
    await service.execute({ capability: 'academic', provider: 'crossref', action: 'work', doi: '10.1234/test' })
    expect(fetch.mock.calls[0][0]).toBe('https://api.crossref.org/works/10.1234%2Ftest')
  })
})

describe('native evidence truncation reporting', () => {
  it('marks clipped issue and release text instead of presenting it as complete', async () => {
    const { service } = setup({ body: 'a'.repeat(12_001), title: 'Issue' })
    const result = await service.execute({ ...repository, action: 'issue', number: 1 })
    expect(result.truncated).toBe(true)
    expect((result.data as { body: string }).body).toHaveLength(12_000)
  })
  it('marks clipped nested authors and assets', async () => {
    const { service } = setup({ author: Array.from({ length: 21 }, () => ({ given: 'Name' })) })
    const result = await service.execute(repository)
    expect(result.truncated).toBe(true)
    expect((result.data as { author: unknown[] }).author).toHaveLength(20)
  })
  it('marks depth clipping', async () => {
    const { service } = setup({ author: { author: { author: { author: { author: { name: 'deep' } } } } } })
    expect((await service.execute(repository)).truncated).toBe(true)
  })
  it('does not mark ordinary field projection or exact bounds as clipping', async () => {
    const { service } = setup({
      body: 'a'.repeat(12_000),
      ignored: 'not evidence',
      author: Array.from({ length: 20 }, () => ({ given: 'Name' })),
    })
    expect((await service.execute(repository)).truncated).toBeUndefined()
  })
})
