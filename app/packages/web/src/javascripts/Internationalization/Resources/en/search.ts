/**
 * English strings for the search surface (search bar, filters, query options,
 * empty/no-results states). Source of truth: other locales fall back to these
 * until translated.
 */
const search = {
  // SearchBar
  placeholder: 'Search...',

  // SearchOptions (quick toggle bubbles)
  protectedContents: 'Protected Contents',
  archived: 'Archived',
  trashed: 'Trashed',

  // AiContextualSearch
  aiUnavailable: 'AI re-ranking is unavailable or returned no result.',
  aiUnavailableTooltip: 'AI contextual search is unavailable.',
  aiTypeQueryFirst: 'Type a search query first.',
  aiTooltip:
    'Re-rank the top results by semantic relevance using your configured AI provider. ' +
    'Sends those candidates’ titles and short snippets, plus your query, to the provider.',
  aiSearchWithAi: 'Search with AI',
  aiRanking: 'Ranking…',
  aiRankedByRelevance: 'Ranked by AI relevance',
  aiPrivacyNotice:
    'Sends the top results’ titles & snippets and your query to your AI provider. Cloud providers will see ' +
    'them — a local model keeps it on-device.',

  // AdvancedSearchOptions
  advancedFilters: 'Advanced search filters',
  filters: 'Filters',
  noteTypeAny: 'Any type',
  noteTypePlainText: 'Plain text',
  noteTypeRichText: 'Rich text',
  noteTypeSuper: 'Super',
  noteTypeMarkdown: 'Markdown',
  noteTypeCode: 'Code',
  noteTypeTask: 'Task',
  noteTypeSpreadsheet: 'Spreadsheet',
  flagProtected: 'Protected',
  flagPinned: 'Pinned',
  flagArchived: 'Archived',
  flagStarred: 'Starred',
  flagTrashed: 'Trashed',
  topicsLabel: 'Topics (comma separated)',
  topicsPlaceholder: 'work, personal',
  noteTypeLabel: 'Note type',
  searchInLabel: 'Search in',
  searchInTitleAndContent: 'Title & content',
  modifiedWithinLabel: 'Modified within',
  datePreset: 'Last {{label}}',
  createdAfterLabel: 'Created after',
  createdBeforeLabel: 'Created before',
  updatedAfterLabel: 'Updated after',
  updatedBeforeLabel: 'Updated before',
  statusLabel: 'Status',
  hasAttachments: 'Has attachments',
  caseSensitive: 'Case sensitive',
  clearAllFilters: 'Clear all filters',
}

export default search
