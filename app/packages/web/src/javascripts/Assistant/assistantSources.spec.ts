import { splitAssistantSources } from './assistantSources'

it('collects trailing web and note sources with the research breakdown', () => {
  const result = splitAssistantSources(
    'Answer\n\n## Retrieved web sources\n- [W1] [A](https://example.test)\n- [W2] [B](https://b.test)\n\n## Selected context sources\n- [1] Note\n\n### Research breakdown\n- Web pages read: 2\n- Search rounds: 1',
  )
  expect(result.body).toBe('Answer')
  expect(result.count).toBe(3)
  expect(result.sources).toContain('Research breakdown')
})

it('does not hide source-looking code or sections before the actual answer', () => {
  for (const text of ['```md\n## Sources\n- Sample\n```', '## Sources\n- A\n## Findings\nAnswer']) {
    expect(splitAssistantSources(text)).toEqual({ body: text, sources: '', count: 0 })
  }
})
