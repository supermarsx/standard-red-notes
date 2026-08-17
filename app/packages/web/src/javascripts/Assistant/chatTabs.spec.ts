/** @jest-environment jsdom */
import {
  AssistantChatTabsStorage,
  ASSISTANT_CHAT_TABS_LEGACY_KEY_PREFIX,
  DEFAULT_TAB_TITLE,
  assistantChatWorkspaceScope,
  assistantChatTabsStorageKey,
  deriveTitleFromMessage,
  getAssistantBrowsingContextId,
  persistTabs,
  persistTabsStrict,
  readPersistedTabs,
  readPersistedTabsResult,
} from './chatTabs'

const createStorage = () => {
  const values = new Map<string, unknown>()
  const storage: AssistantChatTabsStorage = {
    getValue: <T>(key: string) => values.get(key) as T,
    setValue: (key, value) => void values.set(key, value),
  }
  return { storage, values }
}

describe('deriveTitleFromMessage', () => {
  it('returns the default title for empty or whitespace-only input', () => {
    expect(deriveTitleFromMessage('')).toBe(DEFAULT_TAB_TITLE)
    expect(deriveTitleFromMessage('   ')).toBe(DEFAULT_TAB_TITLE)
    expect(deriveTitleFromMessage('\n\n  \n')).toBe(DEFAULT_TAB_TITLE)
  })

  it('keeps a short message verbatim (capitalized, no ellipsis)', () => {
    expect(deriveTitleFromMessage('fix the login bug')).toBe('Fix the login bug')
  })

  it('truncates a long message to the first few words with an ellipsis', () => {
    const title = deriveTitleFromMessage('please summarize my notes about the quarterly budget review meeting')
    expect(title).toBe('Please summarize my notes about the…')
  })

  it('uses only the first non-empty line', () => {
    expect(deriveTitleFromMessage('\n\nWrite a poem\nabout the sea')).toBe('Write a poem')
  })

  it('strips surrounding punctuation that reads poorly as a label', () => {
    expect(deriveTitleFromMessage('"hello there"')).toBe('Hello there')
    expect(deriveTitleFromMessage('### Heading')).toBe('Heading')
  })

  it('falls back to the default when the message is only punctuation', () => {
    expect(deriveTitleFromMessage('!!! ???')).toBe(DEFAULT_TAB_TITLE)
  })

  it('caps very long single words by length with an ellipsis', () => {
    const title = deriveTitleFromMessage('a'.repeat(80))
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(40)
  })
})

describe('persisted chat tabs', () => {
  beforeEach(() => localStorage.clear())

  it('keeps tab labels encrypted and scoped to the active account', () => {
    const { storage } = createStorage()
    persistTabs(storage, 'account-a', [{ id: 'a', title: 'Private work', userRenamed: true }])
    expect(readPersistedTabs(storage, 'account-a')).toEqual([{ id: 'a', title: 'Private work', userRenamed: true }])
    expect(readPersistedTabs(storage, 'account-b')).toBeNull()
    expect(JSON.stringify(localStorage)).not.toContain('Private work')
  })

  it('isolates the retained dock from the separately mounted assistant window', () => {
    expect(assistantChatWorkspaceScope('account-a', false)).toBe('account-a:dock')
    expect(assistantChatWorkspaceScope('account-a', true)).toBe('account-a:window')
  })

  it('keeps one device workspace across a cold browser or app restart', () => {
    const values = new Map<string, string>()
    const deviceStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    const firstLaunch = getAssistantBrowsingContextId(deviceStorage)
    const coldRestart = getAssistantBrowsingContextId(deviceStorage)

    expect(coldRestart).toBe(firstLaunch)
    expect(assistantChatWorkspaceScope('account-a', false, coldRestart)).toBe(
      assistantChatWorkspaceScope('account-a', false, firstLaunch),
    )
  })

  it('caps and de-duplicates untrusted tab metadata', () => {
    const { storage } = createStorage()
    const tabs = Array.from({ length: 25 }, (_, index) => ({
      id: index === 1 ? 'tab-0' : `tab-${index}`,
      title: `Chat ${index}`,
      userRenamed: false,
    }))
    persistTabs(storage, 'account', tabs)
    const persisted = readPersistedTabs(storage, 'account')!
    expect(persisted).toHaveLength(20)
    expect(new Set(persisted.map((tab) => tab.id)).size).toBe(20)
  })

  it('round-trips a maximum-length auto-generated title', () => {
    const { storage } = createStorage()
    const title = deriveTitleFromMessage('a'.repeat(80))
    persistTabs(storage, 'account', [{ id: 'long', title, userRenamed: false }])
    expect(readPersistedTabs(storage, 'account')).toEqual([{ id: 'long', title, userRenamed: false }])
  })

  it('migrates scoped plaintext metadata once and removes it', () => {
    const { storage, values } = createStorage()
    const legacyKey = `${ASSISTANT_CHAT_TABS_LEGACY_KEY_PREFIX}:account`
    localStorage.setItem(legacyKey, JSON.stringify([{ id: 'old', title: 'Move me', userRenamed: true }]))

    expect(readPersistedTabs(storage, 'account')).toEqual([{ id: 'old', title: 'Move me', userRenamed: true }])
    expect(localStorage.getItem(legacyKey)).toBeNull()
    expect([...values.values()]).toContainEqual({
      version: 1,
      tabs: [{ id: 'old', title: 'Move me', userRenamed: true }],
    })
  })

  it('distinguishes missing metadata from corrupt or unreadable encrypted storage', () => {
    const { storage, values } = createStorage()
    expect(readPersistedTabsResult(storage, 'missing')).toEqual({ status: 'missing' })

    values.set(assistantChatTabsStorageKey('corrupt'), {
      version: 1,
      tabs: [{ id: '../invalid', title: 'Do not rewrite me', userRenamed: false }],
    })
    expect(readPersistedTabsResult(storage, 'corrupt')).toEqual({ status: 'error' })

    storage.getValue = () => {
      throw new Error('encrypted storage unavailable')
    }
    expect(readPersistedTabsResult(storage, 'unreadable')).toEqual({ status: 'error' })
  })

  it('surfaces strict persistence failures instead of claiming durable metadata', async () => {
    const { storage, values } = createStorage()
    storage.setValueAndAwaitPersist = async () => {
      throw new Error('disk write rejected')
    }

    await expect(
      persistTabsStrict(storage, 'account', [{ id: 'chat', title: 'Private work', userRenamed: true }]),
    ).rejects.toThrow('disk write rejected')
    expect(values.has(assistantChatTabsStorageKey('account'))).toBe(false)
  })
})
