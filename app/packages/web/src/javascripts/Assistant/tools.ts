import {
  ContentType,
  NoteContent,
  NoteMutator,
  TagMutator,
  PrefKey,
  SNNote,
  SNTag,
  DecryptedItemInterface,
  ItemContent,
  isNote,
  isTag,
  FeatureStatus,
  CollectionSort,
  MutationType,
  PayloadEmitSource,
  isLitePayload,
} from '@standardnotes/snjs'
import { NativeFeatureIdentifier, NoteType } from '@standardnotes/features'
import { WebApplication } from '@/Application/WebApplication'
import { doesItemMatchSearchQuery } from '@/Utils/Items/Search/doesItemMatchSearchQuery'
import { GetAllThemesUseCase } from '@standardnotes/ui-services'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { ToolDefinition, ToolSession } from './types'
import { retrieve } from './retrieval'
import { HeadlessSuperConverter } from '@/Components/SuperEditor/Tools/HeadlessSuperConverter'
import {
  Reminder,
  Recurrence,
  RecurrenceFrequency,
  RecurrenceUnit,
  getNoteReminders,
  generateReminderId,
  describeRecurrence,
  NoteRemindersKey,
} from '@/Reminders/reminders'
import { createEmailReminder, deleteEmailReminder } from '@/Reminders/emailReminders'
import { webSearch, webFetch } from './webTools'
import { achievements, ACHIEVEMENTS } from '@/Achievements'
import { AssistantToolConfirmation } from './assistantPresentation'
import {
  AssistantNoteChange,
  AssistantNoteSnapshot,
  MAX_REVERSIBLE_ASSISTANT_NOTE_CHARS,
  assistantNoteSnapshotMatches,
  buildAssistantNoteChange,
  captureAssistantNoteSnapshot,
  createAssistantNoteSnapshot,
  flushAssistantNoteEditors,
} from './assistantNoteChanges'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { assertSuperNoteMarkdownRewriteSafe } from './superNoteMarkdownRewriteGuard'
import { sanitizeAssistantNoteChange } from './assistantChatHistory'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

const TODO_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']

/**
 * PrefKeys the assistant is allowed to set via app.setPreference. Anything not
 * in this allowlist is rejected.
 */
const ALLOWED_PREFERENCE_KEYS: PrefKey[] = [
  PrefKey.SortNotesBy,
  PrefKey.SortNotesReverse,
  PrefKey.NotesShowArchived,
  PrefKey.NotesShowTrashed,
  PrefKey.NotesHidePinned,
  PrefKey.NotesHideNotePreview,
  PrefKey.NotesHideDate,
  PrefKey.NotesHideTags,
  PrefKey.NotesHideEditorIcon,
  PrefKey.EditorSpellcheck,
  PrefKey.AlwaysShowSuperToolbar,
]

const BOOLEAN_PREFERENCE_KEYS = new Set<PrefKey>([
  PrefKey.SortNotesReverse,
  PrefKey.NotesShowArchived,
  PrefKey.NotesShowTrashed,
  PrefKey.NotesHidePinned,
  PrefKey.NotesHideNotePreview,
  PrefKey.NotesHideDate,
  PrefKey.NotesHideTags,
  PrefKey.NotesHideEditorIcon,
  PrefKey.EditorSpellcheck,
  PrefKey.AlwaysShowSuperToolbar,
])

const ALLOWED_NOTE_SORT_VALUES = new Set<string>([
  CollectionSort.CreatedAt,
  CollectionSort.UpdatedAt,
  CollectionSort.Title,
  CollectionSort.Custom,
])

const PANE_NAVIGATION_TARGETS: Record<string, AppPaneId> = {
  navigation: AppPaneId.Navigation,
  tags: AppPaneId.Navigation,
  items: AppPaneId.Items,
  notes: AppPaneId.Items,
  editor: AppPaneId.Editor,
  note: AppPaneId.Editor,
}

const NOTE_ACTIONS = ['pin', 'unpin', 'archive', 'unarchive', 'star', 'unstar', 'trash', 'untrash'] as const
type NoteAction = (typeof NOTE_ACTIONS)[number]

const RECURRENCE_FREQUENCIES: RecurrenceFrequency[] = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom']
const RECURRENCE_UNITS: RecurrenceUnit[] = ['day', 'week', 'month', 'year']

/** Web-native structured editors require schema-aware tools, never raw body replacement. */
const STRUCTURED_NOTE_EDITOR_IDENTIFIERS = new Set([
  'org.standardnotes.canvas',
  'org.standardnotes.base',
  'org.standardnotes.js-sandbox',
  'org.standardnotes.web-sandbox',
  'org.standardnotes.calendar',
  'org.standardnotes.kanban-board',
  'org.standardnotes.timeline',
  'org.standardnotes.flashcards',
  'org.standardnotes.map',
])

export interface AssistantToolContext {
  /** Combined user-cancel/deadline signal for this exact agent run. */
  signal?: AbortSignal
  /** Fails closed when sign-in identity changes during an async tool call. */
  isSessionCurrent?: () => boolean
  /**
   * Exact note UUIDs selected by the user for this request. When present, note
   * discovery, reads, mutations, reminders, tag assignment, and navigation all
   * fail closed to this set. An empty set means no existing note may be targeted;
   * model-provided text can never widen it.
   */
  selectedNoteUuids?: ReadonlySet<string>
  /** Content snapshots attached to the exact context sent for this run. */
  expectedNoteSnapshots?: Map<string, AssistantNoteSnapshot>
  /** Nested research agents are read-only; the visible parent owns all writes. */
  allowMutatingTools?: boolean
  /** Whether mutating tools require user confirmation before executing. */
  confirmBeforeWrite: boolean
  /** Resolves to true if the user approves a mutating action. */
  requestConfirmation: (request: AssistantToolConfirmation, signal?: AbortSignal) => Promise<boolean>
  /** Optional policy hook; when present it decides whether this call needs an approval. */
  shouldRequestConfirmation?: (request: AssistantToolConfirmation, mutating: boolean) => boolean
  /** Records a bounded display-only authorization decision against a live tool card. */
  onAuthorization?: (
    callId: string | undefined,
    authorization: {
      decision: 'allow' | 'deny'
      source: 'policy' | 'safety-review' | 'user-once' | 'user-chat'
    },
  ) => void
  /** Presents the given pane (used for app.navigate / app.openNote). */
  presentPane: (paneId: AppPaneId) => void
  /**
   * Runs a focused sub-agent for a self-contained subtask and resolves with its
   * final summary. Provided only at the top level; sub-agents cannot delegate.
   */
  runSubAgent?: (task: string, contextText?: string) => Promise<string>
  /** Called when the agent rewrites its todo list, so the UI can render it. */
  onTodosChanged?: (todos: TodoItem[]) => void
  /** Publishes a successful note edit to its bounded, local chat activity card. */
  onNoteChange?: (callId: string | undefined, change: AssistantNoteChange) => void
}

const DELEGATE_TOOL: ToolDefinition = {
  name: 'delegate',
  description:
    'Hand a focused, self-contained subtask to a sub-agent that has the same tools, and get back a summary of what it did. Use for genuinely separable parts of a larger task; do simple steps yourself.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The subtask for the sub-agent to carry out, stated self-containedly.' },
      context: {
        type: 'string',
        description: 'Optional extra context (e.g. relevant note uuids) the sub-agent needs.',
      },
    },
    required: ['task'],
  },
}

function noteSummary(note: SNNote) {
  return {
    uuid: note.uuid,
    title: note.title,
    preview: note.preview_plain,
    pinned: note.pinned,
    archived: note.archived,
    starred: note.starred,
    trashed: note.trashed,
    protected: note.protected,
    updated_at: note.userModifiedDate?.toISOString?.() ?? undefined,
  }
}

export class AssistantTools implements ToolSession {
  constructor(
    private readonly application: WebApplication,
    private readonly context: AssistantToolContext,
    /** When false (sub-agents) the delegate tool is withheld to prevent recursion. */
    private readonly enableDelegate = true,
  ) {}

  private todos: TodoItem[] = []
  /** Notes created successfully by this exact run become safe follow-up targets. */
  private readonly createdNoteUuids = new Set<string>()

  /** Agent runtime hook: install its combined user/deadline signal. */
  setAbortSignal(signal: AbortSignal): void {
    this.context.signal = signal
  }

  /**
   * Lazily-created headless Super converter. We construct one directly (the same
   * pattern as NoteExportUtils / SuperNoteConverter) rather than reaching into the
   * private DI container; spinning one up only when a Super tool is first used.
   */
  private _superConverter?: HeadlessSuperConverter

  private get superConverter(): HeadlessSuperConverter {
    if (!this._superConverter) {
      this._superConverter = new HeadlessSuperConverter()
    }
    return this._superConverter
  }

  /** True if the SuperEditor feature is entitled (Super notes can be created). */
  private canUseSuper(): boolean {
    return (
      this.application.features.getFeatureStatus(
        NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SuperEditor).getValue(),
      ) === FeatureStatus.Entitled
    )
  }

  tools(): ToolDefinition[] {
    const available =
      this.enableDelegate && this.context.runSubAgent ? [...TOOL_DEFINITIONS, DELEGATE_TOOL] : TOOL_DEFINITIONS
    return this.context.allowMutatingTools === false ? available.filter((tool) => !tool.mutating) : available
  }

  async call(name: string, rawArgs: unknown, callId?: string): Promise<unknown> {
    this.throwIfAborted()
    const args = (rawArgs ?? {}) as Record<string, unknown>
    // Resolve against the live tool list so a withheld tool (e.g. delegate inside
    // a sub-agent) is rejected as unknown rather than silently executing.
    const definition = this.tools().find((t) => t.name === name)
    if (!definition) {
      throw new Error(`Unknown tool: ${name}`)
    }

    if (definition.mutating) {
      this.assertMutationAuthorized(args)
    }

    const confirmationRequest = this.buildConfirmationRequest(name, args, callId)
    // Without a richer policy hook, preserve the legacy behavior: web tools
    // always ask because they disclose a query/URL outside the encrypted client.
    // When supplied, the hook is authoritative so the explicit bypass mode can
    // skip confirmation UI; dispatch-time authorization and validation below
    // remain unchanged.
    const isExternalDisclosure = name === 'web.search' || name === 'web.fetch'
    const needsConfirmation = this.context.shouldRequestConfirmation
      ? this.context.shouldRequestConfirmation(confirmationRequest, definition.mutating)
      : isExternalDisclosure || (definition.mutating && this.context.confirmBeforeWrite)
    if (needsConfirmation) {
      this.throwIfAborted()
      const approved = this.context.signal
        ? await this.context.requestConfirmation(confirmationRequest, this.context.signal)
        : await this.context.requestConfirmation(confirmationRequest)
      this.throwIfAborted()
      if (!approved) {
        return { ok: false, cancelled: true, message: 'User declined the action.' }
      }
    } else {
      this.context.onAuthorization?.(callId, { decision: 'allow', source: 'policy' })
    }

    this.throwIfAborted()
    if (definition.mutating) {
      // Approval can stay open while session/vault permissions change. Re-check
      // every hard write boundary immediately before dispatch; confirmation
      // policy (including bypass) is never an authorization decision.
      this.assertMutationAuthorized(args)
    }
    const result = await this.dispatch(name, args, callId)
    if (definition.mutating) {
      return this.markCompletedAfterCancellation(result)
    }
    this.throwIfAborted()
    return result
  }

  private dispatch(name: string, args: Record<string, unknown>, callId?: string): unknown | Promise<unknown> {
    switch (name) {
      case 'notes.list':
        return this.notesList(args)
      case 'notes.search':
        return this.notesSearch(args)
      case 'notes.retrieve':
        return this.notesRetrieve(args)
      case 'notes.read':
        return this.notesRead(args)
      case 'notes.create':
        return this.notesCreate(args)
      case 'notes.update':
        return this.notesUpdate(args, callId)
      case 'notes.createSuper':
        return this.notesCreateSuper(args)
      case 'notes.updateSuper':
        return this.notesUpdateSuper(args, callId)
      case 'notes.readSuper':
        return this.notesReadSuper(args)
      case 'notes.delete':
        return this.notesDelete(args)
      case 'reminders.set':
        return this.remindersSet(args)
      case 'reminders.list':
        return this.remindersList(args)
      case 'reminders.clear':
        return this.remindersClear(args)
      case 'web.search':
        return this.webSearch(args)
      case 'web.fetch':
        return this.webFetch(args)
      case 'get_achievements':
        return this.getAchievements()
      case 'configure_achievements':
        return this.configureAchievements(args)
      case 'tags.list':
        return this.tagsList()
      case 'tags.create':
        return this.tagsCreate(args)
      case 'tags.assign':
        return this.tagsAssign(args)
      case 'tags.unassign':
        return this.tagsUnassign(args)
      case 'app.openNote':
        return this.appOpenNote(args)
      case 'app.setPreference':
        return this.appSetPreference(args)
      case 'app.setTheme':
        return this.appSetTheme(args)
      case 'app.noteAction':
        return this.appNoteAction(args)
      case 'app.navigate':
        return this.appNavigate(args)
      case 'delegate':
        return this.delegate(args)
      case 'todo.write':
        return this.todoWrite(args)
      default:
        throw new Error(`Unhandled tool: ${name}`)
    }
  }

  private throwIfAborted(): void {
    if (this.context.isSessionCurrent && !this.context.isSessionCurrent()) {
      const error = new Error('Assistant operation expired when the signed-in account changed.')
      error.name = 'AbortError'
      throw error
    }
    const signal = this.context.signal
    if (!signal?.aborted) {
      return
    }
    if (signal.reason instanceof Error) {
      throw signal.reason
    }
    const error = new Error('Assistant operation was aborted.')
    error.name = 'AbortError'
    throw error
  }

  /**
   * Confirmation policy is never an authorization policy. Enforce account and
   * shared-vault write restrictions before any approval (or bypass) decision.
   */
  private assertMutationAuthorized(args: Record<string, unknown>): void {
    if (this.application.sessions?.isCurrentSessionReadOnly?.()) {
      throw new Error('The current session is read-only, so the assistant cannot make changes.')
    }

    const note = this.findTrustedTargetNote(args)
    if (!note) {
      const tag = this.findTrustedTargetTag(args)
      if (tag) {
        this.assertTagMutationAuthorized(tag)
      }
      return
    }
    this.assertNoteMutationAuthorized(note)
    const tag = this.findTrustedTargetTag(args)
    if (tag) {
      this.assertTagMutationAuthorized(tag)
    }
  }

  private assertNoteMutationAuthorized(note: SNNote): void {
    if (this.application.sessions?.isCurrentSessionReadOnly?.()) {
      throw new Error('The current session is read-only, so the assistant cannot make changes.')
    }
    if (note.locked || isLitePayload(note.payload) || !this.isReadableNote(note)) {
      throw new Error('This note is locked, incomplete, or no longer authorized for assistant changes.')
    }
    const expected = this.context.expectedNoteSnapshots?.get(note.uuid)
    if (expected && !assistantNoteSnapshotMatches(note, expected)) {
      throw new Error('This note changed after its content was sent to the assistant. Review it and try again.')
    }
    const vault = this.application.vaults?.getItemVault?.(note)
    if (vault?.isSharedVaultListing() && this.application.vaultUsers?.isCurrentUserReadonlyVaultMember?.(vault)) {
      throw new Error('You have read-only access to this shared vault, so the assistant cannot change this note.')
    }
  }

  private assertTagMutationAuthorized(tag: SNTag): void {
    if (this.application.sessions?.isCurrentSessionReadOnly?.()) {
      throw new Error('The current session is read-only, so the assistant cannot make changes.')
    }
    if (!this.isReadableTag(tag)) {
      throw new Error('This tag is locked, incomplete, or no longer authorized for assistant changes.')
    }
    const vault = this.application.vaults?.getItemVault?.(tag)
    if (vault?.isSharedVaultListing() && this.application.vaultUsers?.isCurrentUserReadonlyVaultMember?.(vault)) {
      throw new Error('You have read-only access to this shared vault, so the assistant cannot change this tag.')
    }
  }

  private throwIfSessionChanged(): void {
    if (!this.context.isSessionCurrent || this.context.isSessionCurrent()) {
      return
    }
    const error = new Error('Assistant operation expired when the signed-in account changed.')
    error.name = 'AbortError'
    throw error
  }

  private syncInBackground(): void {
    try {
      const pending = this.application.sync?.sync?.()
      void pending?.catch((error) => console.error('Assistant note sync failed', error))
    } catch (error) {
      console.error('Assistant note sync failed', error)
    }
  }

  private isBoundaryExpired(): boolean {
    return (
      this.context.signal?.aborted === true ||
      (this.context.isSessionCurrent !== undefined && !this.context.isSessionCurrent())
    )
  }

  private markCompletedAfterCancellation(result: unknown): unknown {
    if (!this.isBoundaryExpired()) {
      return result
    }
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), completedAfterCancellation: true }
    }
    return { ok: true, result, completedAfterCancellation: true }
  }

  /** Bind reminder delivery to the API client that was current when the tool began. */
  private emailApplicationSnapshot(): WebApplication {
    return { legacyApi: this.application.legacyApi } as unknown as WebApplication
  }

  /** Admit only the exact note identity returned for this session's own template. */
  private recordCreatedNote(template: { uuid: string }, note: SNNote): void {
    this.throwIfSessionChanged()
    if (!isNote(note) || note.uuid !== template.uuid) {
      throw new Error('The created note identity did not match the application-issued template.')
    }
    this.createdNoteUuids.add(note.uuid)
    this.recordExpectedNoteSnapshot(note)
  }

  private validatePreferenceValue(key: PrefKey, value: unknown): void {
    if (BOOLEAN_PREFERENCE_KEYS.has(key)) {
      if (typeof value !== 'boolean') {
        throw new Error(`Preference "${key}" requires a boolean value`)
      }
      return
    }
    if (key === PrefKey.SortNotesBy) {
      if (typeof value !== 'string' || !ALLOWED_NOTE_SORT_VALUES.has(value)) {
        throw new Error(`Preference "${key}" must be one of: ${Array.from(ALLOWED_NOTE_SORT_VALUES).join(', ')}`)
      }
      return
    }
    throw new Error(`Preference "${key}" has no assistant value validator`)
  }

  /** Add bounded application-resolved identities to every target-bearing prompt. */
  private buildConfirmationRequest(
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ): AssistantToolConfirmation {
    const presentationArgs = { ...args }
    delete presentationArgs.targetTitle
    delete presentationArgs.targetShortId
    delete presentationArgs.targetTagTitle
    delete presentationArgs.targetTagShortId

    const note = this.findTrustedTargetNote(args)
    if (note) {
      presentationArgs.targetTitle = note.title.trim().slice(0, 120) || 'Untitled note'
      presentationArgs.targetShortId = note.uuid.slice(0, 8)
    }

    const tag = this.findTrustedTargetTag(args)
    if (tag) {
      presentationArgs.targetTagTitle = tag.title.trim().slice(0, 120) || 'Untitled tag'
      presentationArgs.targetTagShortId = tag.uuid.slice(0, 8)
    }
    return { name, args: presentationArgs, ...(callId ? { callId } : {}) }
  }

  private findTrustedTargetNote(args: Record<string, unknown>): SNNote | undefined {
    const uuid =
      typeof args.uuid === 'string' ? args.uuid : typeof args.noteUuid === 'string' ? args.noteUuid : undefined
    if (uuid) {
      const byUuid = this.application.items.findItem<SNNote>(uuid)
      return byUuid && isNote(byUuid) && this.isReadableNote(byUuid) ? byUuid : undefined
    }
    return undefined
  }

  private findTrustedTargetTag(args: Record<string, unknown>): SNTag | undefined {
    if (typeof args.tagUuid !== 'string') {
      return undefined
    }
    const tag = this.application.items.findItem<SNTag>(args.tagUuid)
    return tag && isTag(tag) && this.isReadableTag(tag) ? tag : undefined
  }

  private isReadableNote(note: SNNote): boolean {
    const inSelectedScope = this.context.selectedNoteUuids
      ? this.context.selectedNoteUuids.has(note.uuid) || this.createdNoteUuids.has(note.uuid)
      : true
    if (!inSelectedScope) {
      return false
    }
    if (note.locked || isLitePayload(note.payload)) {
      return false
    }

    // Production WebApplication always provides this authorization check. The
    // feature test harnesses intentionally use small structural stubs, so the
    // absent-method fallback applies only to those non-application objects.
    const authorize = this.application.isAuthorizedToRenderItem
    if (typeof authorize !== 'function') {
      return true
    }
    try {
      return authorize.call(this.application, note)
    } catch {
      return false
    }
  }

  private isReadableTag(tag: SNTag): boolean {
    if (tag.locked || isLitePayload(tag.payload)) {
      return false
    }
    const authorize = this.application.isAuthorizedToRenderItem
    if (typeof authorize !== 'function') {
      return true
    }
    try {
      return authorize.call(this.application, tag)
    } catch {
      return false
    }
  }

  private tagSummary(tag: SNTag) {
    const parents: SNTag[] = []
    const seen = new Set([tag.uuid])
    let current = tag
    for (let depth = 0; depth < 100; depth++) {
      const parent = this.application.items.getTagParent?.(current)
      if (!parent) {
        return { uuid: tag.uuid, title: tag.title, longTitle: [...parents, tag].map((entry) => entry.title).join('/') }
      }
      if (seen.has(parent.uuid) || !this.isReadableTag(parent)) {
        return { uuid: tag.uuid, title: tag.title, longTitle: tag.title }
      }
      seen.add(parent.uuid)
      parents.unshift(parent)
      current = parent
    }
    return { uuid: tag.uuid, title: tag.title, longTitle: tag.title }
  }

  private requireReadableNote(uuid: unknown): SNNote {
    if (typeof uuid !== 'string') {
      throw new Error('A note "uuid" string is required')
    }
    if (
      this.context.selectedNoteUuids &&
      !this.context.selectedNoteUuids.has(uuid) &&
      !this.createdNoteUuids.has(uuid)
    ) {
      throw new Error('That note is outside the context selected for this assistant request.')
    }
    const note = this.requireNote(uuid)
    if (!this.isReadableNote(note)) {
      throw new Error('The assistant is not authorized to access that note.')
    }
    return note
  }

  private allNotes(): SNNote[] {
    return this.application.items.getItems<SNNote>(ContentType.TYPES.Note)
  }

  private allTags(): SNTag[] {
    return this.application.items.getItems<SNTag>(ContentType.TYPES.Tag)
  }

  private requireNote(uuid: unknown): SNNote {
    if (typeof uuid !== 'string') {
      throw new Error('A note "uuid" string is required')
    }
    const note = this.application.items.findItem<SNNote>(uuid)
    if (!note || !isNote(note)) {
      throw new Error(`Note not found: ${uuid}`)
    }
    return note
  }

  private requireTag(uuid: unknown): SNTag {
    if (typeof uuid !== 'string') {
      throw new Error('A tag "uuid" string is required')
    }
    const tag = this.application.items.findItem<SNTag>(uuid)
    if (!tag || !isTag(tag)) {
      throw new Error(`Tag not found: ${uuid}`)
    }
    return tag
  }

  private requireReadableTag(uuid: unknown): SNTag {
    const tag = this.requireTag(uuid)
    if (!this.isReadableTag(tag)) {
      throw new Error('The assistant is not authorized to access that tag.')
    }
    return tag
  }

  private notesList(args: Record<string, unknown>) {
    const limit = typeof args.limit === 'number' ? args.limit : 50
    const includeTrashed = args.includeTrashed === true
    const includeArchived = args.includeArchived === true
    const notes = this.allNotes()
      .filter((note) => this.isReadableNote(note))
      .filter((n) => (includeTrashed || !n.trashed) && (includeArchived || !n.archived))
      .slice(0, limit)
    return { count: notes.length, notes: notes.map(noteSummary) }
  }

  private notesSearch(args: Record<string, unknown>) {
    const query = typeof args.query === 'string' ? args.query : ''
    const limit = typeof args.limit === 'number' ? args.limit : 25
    if (!query) {
      throw new Error('A search "query" string is required')
    }
    const matches = this.allNotes()
      .filter((note) => this.isReadableNote(note))
      .filter((note) => doesItemMatchSearchQuery(note as DecryptedItemInterface<ItemContent>, query, this.application))
      .slice(0, limit)
    return { count: matches.length, notes: matches.map(noteSummary) }
  }

  private notesRetrieve(args: Record<string, unknown>) {
    const query = typeof args.query === 'string' ? args.query : ''
    if (!query) {
      throw new Error('A retrieval "query" string is required')
    }
    const limit = typeof args.limit === 'number' ? args.limit : 5
    const perNote = args.perNote !== false
    const docs = this.allNotes()
      .filter((note) => this.isReadableNote(note))
      .filter((note) => !note.trashed)
      .map((note) => ({ uuid: note.uuid, title: note.title, text: note.text }))
    const results = retrieve(docs, query, { limit, perNote })
    return { count: results.length, results }
  }

  private todoWrite(args: Record<string, unknown>) {
    const rawTodos = Array.isArray(args.todos) ? args.todos : []
    const todos: TodoItem[] = rawTodos
      .map((entry): TodoItem => {
        const item = (entry ?? {}) as Record<string, unknown>
        const content = typeof item.content === 'string' ? item.content.trim() : ''
        const status =
          typeof item.status === 'string' && TODO_STATUSES.includes(item.status as TodoStatus)
            ? (item.status as TodoStatus)
            : 'pending'
        return { content, status }
      })
      .filter((todo) => todo.content.length > 0)
    this.todos = todos
    this.context.onTodosChanged?.(todos)
    return { ok: true, todos }
  }

  private notesRead(args: Record<string, unknown>) {
    const note = this.requireReadableNote(args.uuid)
    return {
      ...noteSummary(note),
      text: note.text,
      tags: this.application.items
        .getSortedTagsForItem(note)
        .filter((tag) => this.isReadableTag(tag))
        .map((tag) => this.tagSummary(tag)),
    }
  }

  /** Flush an open editor before taking the before-snapshot for an assistant edit. */
  private async latestReadableNote(uuid: unknown): Promise<SNNote> {
    const note = this.requireReadableNote(uuid)
    await flushAssistantNoteEditors(this.application, note.uuid)
    const latest = this.requireReadableNote(uuid)
    this.assertNoteMutationAuthorized(latest)
    if (latest.text.length > MAX_REVERSIBLE_ASSISTANT_NOTE_CHARS) {
      throw new Error('This note is too large for a safely reversible assistant edit.')
    }
    return latest
  }

  private async requireUnchangedWritableNote(uuid: string, expected: AssistantNoteSnapshot): Promise<SNNote> {
    await flushAssistantNoteEditors(this.application, uuid)
    const latest = this.requireReadableNote(uuid)
    this.assertNoteMutationAuthorized(latest)
    if (!assistantNoteSnapshotMatches(latest, expected)) {
      throw new Error('This note changed while the assistant was preparing its edit. Review it and try again.')
    }
    return latest
  }

  private assertDurableAssistantNoteChange(
    change: AssistantNoteChange | undefined,
    after: AssistantNoteSnapshot,
  ): void {
    if (!change) {
      return
    }
    if (
      after.text.length > MAX_REVERSIBLE_ASSISTANT_NOTE_CHARS ||
      !sanitizeAssistantNoteChange({ ...change, position: 'after' })
    ) {
      throw new Error('This edit is too large or complex to retain a safe encrypted undo record.')
    }
  }

  private recordExpectedNoteSnapshot(note: SNNote): void {
    this.context.expectedNoteSnapshots?.set(note.uuid, captureAssistantNoteSnapshot(note))
  }

  private notePreview(text: string): string {
    const limit = 160
    return text.length > limit ? `${text.slice(0, limit)}...` : text
  }

  private publishNoteChange(callId: string | undefined, change: AssistantNoteChange | undefined): void {
    if (!change) {
      return
    }
    this.throwIfSessionChanged()
    try {
      this.context.onNoteChange?.(callId, change)
    } catch {
      // A rendering callback must never turn an already-committed note write
      // into a reported tool failure or prevent its sync request.
    }
  }

  private async superNoteMarkdown(note: SNNote): Promise<string> {
    if (note.noteType !== NoteType.Super) {
      return note.text
    }
    try {
      return await this.superConverter.convertSuperStringToOtherFormat(note.text, 'md')
    } catch {
      return extractPlaintextFromNoteText(note.text, note.noteType)
    }
  }

  private async notesCreate(args: Record<string, unknown>) {
    // `format: 'super'` routes to the Markdown -> Super conversion path so the
    // model never has to hand-write Lexical JSON.
    if (args.format === 'super') {
      return this.notesCreateSuper(args)
    }

    const title = typeof args.title === 'string' ? args.title : ''
    const text = typeof args.text === 'string' ? args.text : ''
    // Optional editorIdentifier lets the agent create a typed note (e.g. the
    // Calendar note type 'org.standardnotes.calendar'). We only honor it when the
    // feature is entitled, mirroring the Importer's guard, so an unavailable type
    // silently falls back to a plain note rather than producing a broken one.
    const requestedEditor = typeof args.editorIdentifier === 'string' ? args.editorIdentifier : undefined
    const editorIdentifier =
      requestedEditor &&
      this.application.features.getFeatureStatus(NativeFeatureIdentifier.create(requestedEditor).getValue()) ===
        FeatureStatus.Entitled
        ? requestedEditor
        : undefined

    const template = this.application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
      title,
      text,
      references: [],
      editorIdentifier,
    })
    const note = await this.application.mutator.insertItem<SNNote>(template)
    this.recordCreatedNote(template, note)
    return { ok: true, note: noteSummary(note), editorIdentifier: editorIdentifier ?? null }
  }

  private async notesUpdate(args: Record<string, unknown>, callId?: string) {
    const note = await this.latestReadableNote(args.uuid)
    const hasBody = typeof args.text === 'string' || typeof args.markdown === 'string'
    if (typeof args.title !== 'string' && !hasBody && args.format !== 'super') {
      throw new Error('Provide a title or body change for notes.update.')
    }
    if (args.format === 'super' || (note.noteType === NoteType.Super && hasBody)) {
      return this.notesUpdateSuper(args, callId, note)
    }
    if (hasBody && note.editorIdentifier && STRUCTURED_NOTE_EDITOR_IDENTIFIERS.has(note.editorIdentifier)) {
      throw new Error(
        'This note uses a structured editor. Its body can only be changed by a schema-aware tool; a title-only update is safe.',
      )
    }

    const before = captureAssistantNoteSnapshot(note)
    const after = createAssistantNoteSnapshot({
      ...before,
      title: typeof args.title === 'string' ? args.title : before.title,
      text: typeof args.text === 'string' ? args.text : before.text,
      previewPlain: typeof args.text === 'string' ? this.notePreview(args.text) : before.previewPlain,
      previewHtml: typeof args.text === 'string' ? undefined : before.previewHtml,
    })
    const change = buildAssistantNoteChange({ noteUuid: note.uuid, before, after })
    this.assertDurableAssistantNoteChange(change, after)
    if (!change) {
      return { ok: true, note: noteSummary(note), unchanged: true }
    }
    const updated = await this.application.mutator.changeItem<NoteMutator, SNNote>(
      note,
      (mutator) => {
        if (typeof args.title === 'string') {
          mutator.title = args.title
        }
        if (typeof args.text === 'string') {
          mutator.text = args.text
          mutator.preview_plain = this.notePreview(args.text)
          mutator.preview_html = undefined
        }
      },
      MutationType.UpdateUserTimestamps,
      PayloadEmitSource.AssistantChanged,
    )
    this.recordExpectedNoteSnapshot(updated)
    this.syncInBackground()
    this.publishNoteChange(callId, change)
    return { ok: true, note: noteSummary(updated) }
  }

  /**
   * Create a Super (Lexical) note from MARKDOWN. The model supplies markdown
   * (which may contain ```mermaid fenced blocks — those become MermaidNodes for
   * free via the existing MarkdownTransformers); we convert it to Super JSON with
   * the HeadlessSuperConverter and store it as note.text with the right noteType +
   * editorIdentifier (mirroring Importer.ts). Falls back to a plain note (the raw
   * markdown) when the SuperEditor feature is not entitled.
   */
  private async notesCreateSuper(args: Record<string, unknown>) {
    const title = typeof args.title === 'string' ? args.title : ''
    const markdown = typeof args.markdown === 'string' ? args.markdown : typeof args.text === 'string' ? args.text : ''

    if (!this.canUseSuper()) {
      const template = this.application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
        title,
        text: markdown,
        references: [],
      })
      const plain = await this.application.mutator.insertItem<SNNote>(template)
      this.recordCreatedNote(template, plain)
      return {
        ok: true,
        note: noteSummary(plain),
        super: false,
        warning: 'The Super editor is not available; created a plain-text note with the markdown instead.',
      }
    }

    let superText: string
    try {
      superText = this.superConverter.convertOtherFormatToSuperString(markdown, 'md')
    } catch (error) {
      throw new Error(
        `Could not convert markdown to a Super note: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const template = this.application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
      title,
      text: superText,
      references: [],
      noteType: NoteType.Super,
      editorIdentifier: NativeFeatureIdentifier.TYPES.SuperEditor,
    })
    const note = await this.application.mutator.insertItem<SNNote>(template)
    this.recordCreatedNote(template, note)
    return { ok: true, note: noteSummary(note), super: true }
  }

  /**
   * Update a Super note from MARKDOWN. The model is given the round-tripped
   * markdown (via notes.readSuper) to edit, and passes the full edited markdown
   * back here; we convert it to Super JSON and store it. If the target note is not
   * yet a Super note it is converted into one.
   */
  private async notesUpdateSuper(args: Record<string, unknown>, callId?: string, resolvedNote?: SNNote) {
    const note = resolvedNote ?? (await this.latestReadableNote(args.uuid))
    const hasBodyInput = typeof args.markdown === 'string' || typeof args.text === 'string'
    const replacesBody = hasBodyInput || note.noteType !== NoteType.Super
    if (
      replacesBody &&
      note.noteType !== NoteType.Super &&
      note.editorIdentifier &&
      STRUCTURED_NOTE_EDITOR_IDENTIFIERS.has(note.editorIdentifier)
    ) {
      throw new Error(
        'This note uses a structured editor. Its body can only be changed by a schema-aware tool; a title-only update is safe.',
      )
    }
    if (hasBodyInput && note.noteType === NoteType.Super) {
      assertSuperNoteMarkdownRewriteSafe(note.text)
    }
    const beforeMarkdown = await this.superNoteMarkdown(note)
    const markdown =
      typeof args.markdown === 'string' ? args.markdown : typeof args.text === 'string' ? args.text : beforeMarkdown

    if (!this.canUseSuper()) {
      throw new Error('The Super editor is not available, so this note cannot be saved as Super.')
    }

    let superText = note.text
    if (replacesBody) {
      try {
        superText = this.superConverter.convertOtherFormatToSuperString(markdown, 'md')
      } catch (error) {
        throw new Error(
          `Could not convert markdown to a Super note: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const before = captureAssistantNoteSnapshot(note)
    const after = createAssistantNoteSnapshot({
      ...before,
      title: typeof args.title === 'string' ? args.title : before.title,
      text: replacesBody ? superText : before.text,
      previewPlain: replacesBody
        ? this.notePreview(extractPlaintextFromNoteText(superText, NoteType.Super))
        : before.previewPlain,
      previewHtml: replacesBody ? undefined : before.previewHtml,
      noteType: replacesBody ? NoteType.Super : before.noteType,
      editorIdentifier: replacesBody ? NativeFeatureIdentifier.TYPES.SuperEditor : before.editorIdentifier,
    })
    const change = buildAssistantNoteChange({
      noteUuid: note.uuid,
      before,
      after,
      beforeDisplayText: beforeMarkdown,
      afterDisplayText: replacesBody ? markdown : beforeMarkdown,
    })
    this.assertDurableAssistantNoteChange(change, after)
    if (!change) {
      return { ok: true, note: noteSummary(note), super: note.noteType === NoteType.Super, unchanged: true }
    }
    const current = await this.requireUnchangedWritableNote(note.uuid, before)
    const updated = await this.application.mutator.changeItem<NoteMutator, SNNote>(
      current,
      (mutator) => {
        if (typeof args.title === 'string') {
          mutator.title = args.title
        }
        if (replacesBody) {
          mutator.text = superText
          mutator.preview_plain = this.notePreview(extractPlaintextFromNoteText(superText, NoteType.Super))
          mutator.preview_html = undefined
          mutator.noteType = NoteType.Super
          mutator.editorIdentifier = NativeFeatureIdentifier.TYPES.SuperEditor
        }
      },
      MutationType.UpdateUserTimestamps,
      PayloadEmitSource.AssistantChanged,
    )
    this.recordExpectedNoteSnapshot(updated)
    this.syncInBackground()
    this.publishNoteChange(callId, change)
    return { ok: true, note: noteSummary(updated), super: true }
  }

  /**
   * Read a Super note as MARKDOWN so the model can edit it and pass the result to
   * notes.updateSuper. For a non-Super note this just returns its raw text.
   */
  private async notesReadSuper(args: Record<string, unknown>) {
    const note = this.requireReadableNote(args.uuid)
    if (note.noteType !== NoteType.Super) {
      return { ...noteSummary(note), super: false, markdown: note.text }
    }
    try {
      const markdown = await this.superConverter.convertSuperStringToOtherFormat(note.text, 'md')
      return { ...noteSummary(note), super: true, markdown }
    } catch (error) {
      throw new Error(
        `Could not read the Super note as markdown: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async notesDelete(args: Record<string, unknown>) {
    const note = this.requireReadableNote(args.uuid)
    this.assertNoteMutationAuthorized(note)
    await this.application.mutator.deleteItem(note)
    return { ok: true, deleted: note.uuid }
  }

  /**
   * Resolve a note from either a uuid or a (case-insensitive) title. Reminders
   * tools accept a title for convenience; an ambiguous title (>1 match) is an
   * error so we never set a reminder on the wrong note.
   */
  private resolveNote(args: Record<string, unknown>): SNNote {
    if (typeof args.uuid === 'string' && args.uuid) {
      return this.requireReadableNote(args.uuid)
    }
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) {
      throw new Error('A note "uuid" or "title" is required')
    }
    const matches = this.allNotes().filter(
      (note) => this.isReadableNote(note) && !note.trashed && note.title.trim().toLowerCase() === title.toLowerCase(),
    )
    if (matches.length === 0) {
      throw new Error(`No note found with title: ${title}`)
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple notes are titled "${title}" (${matches.length}). Pass the note "uuid" instead: ${matches
          .map((n) => n.uuid)
          .join(', ')}`,
      )
    }
    return matches[0]
  }

  private parseRecurrence(value: unknown): Recurrence | undefined {
    if (!value || typeof value !== 'object') {
      return undefined
    }
    const raw = value as Record<string, unknown>
    const frequency = RECURRENCE_FREQUENCIES.includes(raw.frequency as RecurrenceFrequency)
      ? (raw.frequency as RecurrenceFrequency)
      : 'none'
    if (frequency === 'none') {
      return undefined
    }
    if (frequency === 'custom') {
      const interval = typeof raw.interval === 'number' && raw.interval >= 1 ? Math.floor(raw.interval) : 1
      const unit = RECURRENCE_UNITS.includes(raw.unit as RecurrenceUnit) ? (raw.unit as RecurrenceUnit) : 'day'
      return { frequency: 'custom', interval, unit }
    }
    return { frequency }
  }

  private reminderSummary(reminder: Reminder) {
    return {
      id: reminder.id,
      dueAt: reminder.dueAt,
      message: reminder.message,
      notified: reminder.notified === true,
      recurrence: describeRecurrence(reminder.recurrence) ?? 'does not repeat',
      email: typeof reminder.emailReminderId === 'string',
    }
  }

  /**
   * Set (or update) a reminder on a note. Persists via the same synced appData
   * path the UI uses (notesController.upsertNoteReminder). Optionally also
   * registers the reminder for EMAIL delivery, which sends its time + message to
   * the server in PLAINTEXT (out of end-to-end encryption) — only when the model
   * passes `email: true` AND the user has an account.
   */
  private async remindersSet(args: Record<string, unknown>) {
    const note = this.resolveNote(args)
    this.assertNoteMutationAuthorized(note)
    const notesController = this.application.notesController
    const emailApplication = this.emailApplicationSnapshot()

    const datetime = typeof args.datetime === 'string' ? args.datetime : ''
    if (!datetime) {
      throw new Error('A "datetime" (ISO 8601 string) is required')
    }
    const due = new Date(datetime)
    if (Number.isNaN(due.getTime())) {
      throw new Error(`Could not parse "datetime": ${datetime}. Use an ISO 8601 string like 2026-07-01T09:00:00.`)
    }
    const dueIso = due.toISOString()
    const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : undefined
    const recurrence = this.parseRecurrence(args.recurrence)

    const reminder: Reminder = {
      id: generateReminderId(),
      dueAt: dueIso,
      message,
      notified: false,
      recurrence,
    }

    const wantsEmail = args.email === true
    let emailWarning: string | undefined
    let createdEmailReminderId: string | undefined
    if (wantsEmail) {
      if (!this.application.hasAccount()) {
        emailWarning = 'Email delivery was requested but skipped: an account is required to receive emails.'
      } else {
        const emailId = await createEmailReminder(emailApplication, dueIso, message || 'Reminder')
        if (emailId) {
          reminder.emailReminderId = emailId
          createdEmailReminderId = emailId
        } else {
          emailWarning = 'The reminder was saved, but it could not be registered for email delivery.'
        }
      }
    }

    if (this.context.isSessionCurrent && !this.context.isSessionCurrent()) {
      if (createdEmailReminderId) {
        const removed = await deleteEmailReminder(emailApplication, createdEmailReminderId)
        if (!removed) {
          throw new Error('The account changed and the newly created email reminder could not be rolled back safely.')
        }
      }
      this.throwIfSessionChanged()
    }

    try {
      // Once the external email record exists, finish linking it locally even
      // if cancellation arrives between these two non-transactional systems.
      // The caller enforces the abort boundary after dispatch settles.
      this.assertNoteMutationAuthorized(note)
      await notesController.upsertNoteReminder(note, reminder)
    } catch (error) {
      if (createdEmailReminderId) {
        const removed = await deleteEmailReminder(emailApplication, createdEmailReminderId)
        if (!removed) {
          this.throwIfSessionChanged()
          try {
            // If the external delete failed, preserve the exact server id in the
            // synced note so it remains visible and retryable instead of orphaned.
            // Never cross a newly-applied lock or read-only boundary to do so.
            this.assertNoteMutationAuthorized(note)
            await notesController.upsertNoteReminder(note, reminder)
          } catch (compensationError) {
            throw new Error(
              `Could not save the reminder, cancel its email delivery, or restore its local provenance: ${
                compensationError instanceof Error ? compensationError.message : String(compensationError)
              }`,
              { cause: error },
            )
          }
          return {
            ok: true,
            noteUuid: note.uuid,
            reminder: this.reminderSummary(reminder),
            warning: 'The initial local save failed, but the email reminder was preserved and relinked for retry.',
          }
        }
      }
      throw error
    }

    return {
      ok: true,
      noteUuid: note.uuid,
      reminder: this.reminderSummary(reminder),
      ...(emailWarning ? { warning: emailWarning } : {}),
    }
  }

  /** List the reminders on a note (or, with no note given, across all notes). */
  private remindersList(args: Record<string, unknown>) {
    const hasTarget = (typeof args.uuid === 'string' && args.uuid) || (typeof args.title === 'string' && args.title)
    if (hasTarget) {
      const note = this.resolveNote(args)
      const reminders = getNoteReminders(note)
      return { noteUuid: note.uuid, count: reminders.length, reminders: reminders.map((r) => this.reminderSummary(r)) }
    }
    const all = this.allNotes()
      .filter((note) => this.isReadableNote(note) && !note.trashed)
      .flatMap((note) =>
        getNoteReminders(note).map((reminder) => ({
          noteUuid: note.uuid,
          noteTitle: note.title,
          ...this.reminderSummary(reminder),
        })),
      )
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    return { count: all.length, reminders: all }
  }

  /** Clear all reminders while keeping every external id reflected locally. */
  private async remindersClear(args: Record<string, unknown>) {
    const note = this.resolveNote(args)
    this.assertNoteMutationAuthorized(note)
    const existing = getNoteReminders(note)
    const notesController = this.application.notesController
    const mutator = this.application.mutator
    const emailApplication = this.emailApplicationSnapshot()

    // Clear locally before touching the external service. If this write fails,
    // every server id remains referenced and no compensation is necessary.
    await notesController.clearNoteReminders(note)

    const failedExternalDeletes: Reminder[] = []
    for (const reminder of existing) {
      if (reminder.emailReminderId) {
        const removed = await deleteEmailReminder(emailApplication, reminder.emailReminderId)
        if (!removed) {
          failedExternalDeletes.push(reminder)
        }
      }
    }

    if (failedExternalDeletes.length > 0) {
      try {
        this.assertNoteMutationAuthorized(note)
        await mutator.changeItem<NoteMutator, SNNote>(note, (noteMutator) => {
          noteMutator.setAppDataItem(NoteRemindersKey, failedExternalDeletes)
        })
      } catch (error) {
        throw new Error('Could not restore reminders whose external email records were not deleted.', { cause: error })
      }
      throw new Error(
        `Could not delete ${failedExternalDeletes.length} email reminder${
          failedExternalDeletes.length === 1 ? '' : 's'
        }; the corresponding local reminder state was restored.`,
      )
    }

    return { ok: true, noteUuid: note.uuid, cleared: existing.length }
  }

  private async webSearch(args: Record<string, unknown>) {
    const query = typeof args.query === 'string' ? args.query : ''
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    return webSearch(this.application, query, { limit, signal: this.context.signal })
  }

  private async webFetch(args: Record<string, unknown>) {
    const url = typeof args.url === 'string' ? args.url : ''
    return webFetch(this.application, url, { signal: this.context.signal })
  }

  /**
   * Read-only summary of the user's achievements. Preserves the mystery of
   * still-hidden, still-locked achievements: it reveals only HOW MANY remain
   * hidden, never their names or criteria. Unlocked achievements (even hidden
   * ones) and visible in-progress ones are reported fully.
   */
  private getAchievements() {
    const progress = achievements.getProgress()
    const total = progress.length
    const unlocked = progress.filter((p) => p.unlocked)
    const lockedVisible = progress.filter((p) => !p.unlocked && !p.def.hidden)
    const hiddenLockedCount = progress.filter((p) => !p.unlocked && p.def.hidden).length

    const inProgress = lockedVisible
      .filter((p) => p.current > 0)
      .sort((a, b) => b.current / b.def.threshold - a.current / a.def.threshold)
      .slice(0, 5)
      .map((p) => ({ name: p.def.name, current: p.current, threshold: p.def.threshold }))

    return {
      unlockedCount: unlocked.length,
      total,
      unlocked: unlocked.map((p) => p.def.name),
      topInProgress: inProgress,
      hiddenLockedRemaining: hiddenLockedCount,
    }
  }

  /**
   * Configure the user's achievements at their request. Can toggle the whole
   * system, the unlock toasts, the unlock-date recording, or enable/disable a
   * single achievement (referenced by id or name), or reset all progress.
   * Mutating — gated by the same confirmation flow as other writes.
   */
  private configureAchievements(args: Record<string, unknown>) {
    const setting = String(args.setting ?? '')

    if (setting === 'reset') {
      achievements.resetAll()
      return {
        ok: true,
        message: 'All achievement progress and unlock dates were reset.',
        config: achievements.getConfig(),
      }
    }

    if (typeof args.enabled !== 'boolean') {
      return { ok: false, message: "Provide a boolean 'enabled' (true to turn on, false to turn off)." }
    }
    const enabled = args.enabled

    switch (setting) {
      case 'system':
        achievements.setMasterEnabled(enabled)
        return {
          ok: true,
          message: `Achievements ${enabled ? 'enabled' : 'disabled'}.`,
          config: achievements.getConfig(),
        }
      case 'toasts':
        achievements.setShowUnlockToasts(enabled)
        return {
          ok: true,
          message: `Unlock notifications ${enabled ? 'enabled' : 'disabled'}.`,
          config: achievements.getConfig(),
        }
      case 'timestamps':
        achievements.setRecordTimestamps(enabled)
        return {
          ok: true,
          message: `Recording of unlock date/time ${enabled ? 'enabled' : 'disabled'}.`,
          config: achievements.getConfig(),
        }
      case 'achievement': {
        const query = String(args.achievement ?? '').trim()
        if (!query) {
          return { ok: false, message: "Provide the 'achievement' id or name to enable/disable." }
        }
        const lower = query.toLowerCase()
        const match =
          ACHIEVEMENTS.find((a) => a.id === query) ?? ACHIEVEMENTS.find((a) => a.name.toLowerCase() === lower)
        if (!match) {
          // Suggest only non-hidden names so still-secret achievements stay a surprise.
          const suggestions = ACHIEVEMENTS.filter((a) => !a.hidden)
            .slice(0, 12)
            .map((a) => a.name)
          return { ok: false, message: `No achievement matched "${query}".`, knownNames: suggestions }
        }
        achievements.setAchievementEnabled(match.id, enabled)
        return {
          ok: true,
          message: `Achievement "${match.name}" ${enabled ? 'enabled' : 'disabled'}.`,
          config: achievements.getConfig(),
        }
      }
      default:
        return {
          ok: false,
          message: "Unknown 'setting'. Use 'system', 'toasts', 'timestamps', 'achievement', or 'reset'.",
        }
    }
  }

  private tagsList() {
    const selectedNoteUuids = this.context.selectedNoteUuids
    const tags = selectedNoteUuids
      ? Array.from(
          this.allNotes()
            .filter((note) => selectedNoteUuids.has(note.uuid) && this.isReadableNote(note))
            .flatMap((note) => this.application.items.getSortedTagsForItem(note))
            .reduce((byUuid, tag) => byUuid.set(tag.uuid, tag), new Map<string, SNTag>())
            .values(),
        )
      : this.allTags()
    const readableTags = tags.filter((tag) => this.isReadableTag(tag))
    return { count: readableTags.length, tags: readableTags.map((tag) => this.tagSummary(tag)) }
  }

  private async tagsCreate(args: Record<string, unknown>) {
    const title = typeof args.title === 'string' ? args.title : ''
    if (!title) {
      throw new Error('A tag "title" string is required')
    }
    const normalizedTitle = title.toLowerCase()
    const existing = this.allTags().find(
      (tag) => tag.parentId === undefined && tag.title?.toLowerCase() === normalizedTitle,
    )
    if (existing) {
      this.assertTagMutationAuthorized(existing)
      return { ok: true, tag: this.tagSummary(existing), existing: true }
    }
    const tag = await this.application.mutator.findOrCreateTag(title)
    this.assertTagMutationAuthorized(tag)
    return { ok: true, tag: this.tagSummary(tag) }
  }

  private async tagsAssign(args: Record<string, unknown>) {
    const note = this.requireReadableNote(args.noteUuid)
    this.assertNoteMutationAuthorized(note)
    const tag = this.requireReadableTag(args.tagUuid)
    this.assertTagMutationAuthorized(tag)
    if (note.key_system_identifier !== tag.key_system_identifier) {
      throw new Error('The note and tag belong to different vaults and cannot be linked.')
    }
    const updatedTags = await this.application.mutator.addTagToNote(note, tag, false)
    if (!updatedTags) {
      throw new Error('The note and tag could not be linked.')
    }
    return { ok: true, noteUuid: note.uuid, tagUuid: tag.uuid }
  }

  private async tagsUnassign(args: Record<string, unknown>) {
    const note = this.requireReadableNote(args.noteUuid)
    this.assertNoteMutationAuthorized(note)
    const tag = this.requireReadableTag(args.tagUuid)
    this.assertTagMutationAuthorized(tag)
    if (note.key_system_identifier !== tag.key_system_identifier) {
      throw new Error('The note and tag belong to different vaults and cannot be unlinked.')
    }
    await this.application.mutator.changeItem<TagMutator, SNTag>(tag, (mutator) => {
      mutator.removeItemAsRelationship(note)
    })
    return { ok: true, noteUuid: note.uuid, tagUuid: tag.uuid }
  }

  private async appOpenNote(args: Record<string, unknown>) {
    const note = this.requireReadableNote(args.uuid)
    await this.application.itemListController.openNote(note.uuid)
    this.context.presentPane(AppPaneId.Editor)
    return { ok: true, opened: note.uuid }
  }

  private async appSetPreference(args: Record<string, unknown>) {
    const key = args.key as PrefKey
    if (!ALLOWED_PREFERENCE_KEYS.includes(key)) {
      throw new Error(`Preference "${String(key)}" is not allowed to be set by the assistant`)
    }
    this.validatePreferenceValue(key, args.value)
    await this.application.setPreference(key, args.value as never)
    return { ok: true, key, value: args.value }
  }

  private async appSetTheme(args: Record<string, unknown>) {
    const identifierOrName = typeof args.theme === 'string' ? args.theme : ''
    if (!identifierOrName) {
      throw new Error('A "theme" identifier or name is required')
    }
    const usecase = new GetAllThemesUseCase(this.application.items)
    const { thirdParty, native } = usecase.execute({ excludeLayerable: false })
    const allThemes = [...thirdParty, ...native]
    const match = allThemes.find(
      (theme) =>
        theme.uniqueIdentifier.value === identifierOrName ||
        theme.displayName.toLowerCase() === identifierOrName.toLowerCase(),
    )
    if (!match) {
      throw new Error(
        `Theme not found: ${identifierOrName}. Available: ${allThemes.map((t) => t.displayName).join(', ')}`,
      )
    }
    await this.application.themeManager.selectTheme(match)
    return { ok: true, theme: match.displayName }
  }

  private async appNoteAction(args: Record<string, unknown>) {
    const note = this.requireReadableNote(args.uuid)
    this.assertNoteMutationAuthorized(note)
    const action = args.action as NoteAction
    if (!NOTE_ACTIONS.includes(action)) {
      throw new Error(`Unknown note action: ${String(action)}. Allowed: ${NOTE_ACTIONS.join(', ')}`)
    }
    await this.application.mutator.changeItem<NoteMutator, SNNote>(note, (mutator) => {
      switch (action) {
        case 'pin':
          mutator.pinned = true
          break
        case 'unpin':
          mutator.pinned = false
          break
        case 'archive':
          mutator.archived = true
          break
        case 'unarchive':
          mutator.archived = false
          break
        case 'star':
          mutator.starred = true
          break
        case 'unstar':
          mutator.starred = false
          break
        case 'trash':
          mutator.trashed = true
          break
        case 'untrash':
          mutator.trashed = false
          break
      }
    })
    return { ok: true, uuid: note.uuid, action }
  }

  private appNavigate(args: Record<string, unknown>) {
    const target = typeof args.target === 'string' ? args.target.toLowerCase() : ''
    const paneId = PANE_NAVIGATION_TARGETS[target]
    if (!paneId) {
      throw new Error(
        `Unknown navigation target: ${target}. Allowed: ${Object.keys(PANE_NAVIGATION_TARGETS).join(', ')}`,
      )
    }
    this.context.presentPane(paneId)
    return { ok: true, navigatedTo: target }
  }

  private async delegate(args: Record<string, unknown>) {
    if (!this.context.runSubAgent) {
      throw new Error('Delegation is not available in this context')
    }
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) {
      throw new Error('A "task" string describing the subtask is required')
    }
    const contextText = typeof args.context === 'string' ? args.context : undefined
    const result = await this.context.runSubAgent(task, contextText)
    return { ok: true, result }
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'notes.list',
    description: 'List the user notes (most recent first). Returns uuid, title, preview and flags.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of notes to return (default 50)' },
        includeArchived: { type: 'boolean' },
        includeTrashed: { type: 'boolean' },
      },
    },
  },
  {
    name: 'notes.search',
    description: 'Search notes by title/content text. Returns matching note summaries.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'notes.retrieve',
    description:
      'Relevance-rank the user notes for a question and return the most relevant passages (snippets) with their note uuids and scores. Prefer this over reading many notes when answering a question — it finds the right context across the whole corpus. Use notes.read on a returned uuid to get the full note.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or topic to retrieve relevant passages for.' },
        limit: { type: 'number', description: 'Max passages to return (default 5).' },
        perNote: { type: 'boolean', description: 'Return at most one passage per note (default true).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'notes.read',
    description: 'Read the full text and tags of a single note by uuid.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
    },
  },
  {
    name: 'notes.create',
    description:
      'Create a new note. By default the text is stored as PLAIN text. Pass format:"super" together with `markdown` (instead of `text`) to create a rich Super note from markdown — including ```mermaid fenced blocks, which become live diagrams (prefer notes.createSuper for this). Optionally pass editorIdentifier to create a typed note (e.g. "org.standardnotes.calendar" for a Calendar note).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string', description: 'Plain-text body (for the default plain note).' },
        format: {
          type: 'string',
          enum: ['plain', 'super'],
          description: 'Use "super" to convert `markdown` into a rich Super note.',
        },
        markdown: { type: 'string', description: 'Markdown body when format is "super" (supports ```mermaid blocks).' },
        editorIdentifier: {
          type: 'string',
          description:
            'Optional note-type editor identifier, e.g. "org.standardnotes.calendar". Ignored if the feature is unavailable.',
        },
      },
    },
  },
  {
    name: 'notes.update',
    description:
      'Update the title and/or text of an existing note by uuid. Pass format:"super" with `markdown` to (re)write the note as a rich Super note (prefer notes.updateSuper, which round-trips existing content to markdown first).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        title: { type: 'string' },
        text: { type: 'string' },
        format: { type: 'string', enum: ['plain', 'super'] },
        markdown: { type: 'string', description: 'Markdown body when format is "super".' },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'notes.createSuper',
    description:
      'Create a rich Super (Lexical) note from MARKDOWN. The markdown may contain headings, lists, tables, code, and ```mermaid fenced blocks (which render as live Mermaid diagrams). This is the correct way to author formatted/diagram notes — do NOT write Lexical JSON into a plain note.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        markdown: { type: 'string', description: 'The note body as markdown. Use a ```mermaid block for a diagram.' },
      },
      required: ['markdown'],
    },
  },
  {
    name: 'notes.updateSuper',
    description:
      'Rewrite a note as a rich Super note from MARKDOWN. To edit an existing Super note, first call notes.readSuper to get its markdown, edit that, then pass the full edited markdown back here.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        title: { type: 'string' },
        markdown: { type: 'string', description: 'The full new note body as markdown (supports ```mermaid).' },
      },
      required: ['uuid', 'markdown'],
    },
  },
  {
    name: 'notes.readSuper',
    description:
      'Read a Super note as MARKDOWN (round-tripped from its Lexical JSON) so you can edit it and pass the result to notes.updateSuper. For a non-Super note it returns the raw text.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
    },
  },
  {
    name: 'notes.delete',
    description: 'Permanently delete a note by uuid.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
    },
  },
  {
    name: 'tags.list',
    description: 'List visible tags with their uuid and full hierarchical title.',
    mutating: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_achievements',
    description:
      "Get a compact summary of the user's gamification achievements: how many are unlocked out of the total, the names of the unlocked ones, the top in-progress achievements (name, current, threshold), and how many HIDDEN achievements remain locked. Do not speculate about the names or criteria of still-hidden achievements — only report the count that remain, to preserve the surprise.",
    mutating: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'configure_achievements',
    description:
      "Configure the user's achievements when they ask. setting='system' turns the whole achievements feature on/off; 'toasts' turns unlock notifications on/off; 'timestamps' turns recording of the unlock date/time on/off; 'achievement' enables/disables one achievement (pass its name or id in 'achievement', plus 'enabled'); 'reset' clears all progress and unlock dates (no 'enabled' needed). All except 'reset' require the boolean 'enabled'. Only act on an explicit user request; do not enable/disable achievements on your own initiative.",
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        setting: { type: 'string', enum: ['system', 'toasts', 'timestamps', 'achievement', 'reset'] },
        enabled: { type: 'boolean', description: 'Required for all settings except reset.' },
        achievement: { type: 'string', description: "Achievement name or id; required when setting='achievement'." },
      },
      required: ['setting'],
    },
  },
  {
    name: 'tags.create',
    description: 'Create a tag (or return the existing tag) with the given title.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'tags.assign',
    description: 'Assign a tag to a note.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { noteUuid: { type: 'string' }, tagUuid: { type: 'string' } },
      required: ['noteUuid', 'tagUuid'],
    },
  },
  {
    name: 'tags.unassign',
    description: 'Remove a tag from a note.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { noteUuid: { type: 'string' }, tagUuid: { type: 'string' } },
      required: ['noteUuid', 'tagUuid'],
    },
  },
  {
    name: 'app.openNote',
    description: 'Open a note in the editor by uuid.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
    },
  },
  {
    name: 'app.setPreference',
    description: 'Set an allowlisted app preference (note list display, sorting, spellcheck, etc).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'One of the allowlisted PrefKey values' },
        value: {},
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'app.setTheme',
    description: 'Toggle a theme by its identifier or display name.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { theme: { type: 'string' } },
      required: ['theme'],
    },
  },
  {
    name: 'app.noteAction',
    description: 'Perform a note action: pin, unpin, archive, unarchive, star, unstar, trash, untrash.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        action: { type: 'string', enum: [...NOTE_ACTIONS] },
      },
      required: ['uuid', 'action'],
    },
  },
  {
    name: 'app.navigate',
    description: 'Navigate the app to a pane: navigation/tags, items/notes, or editor/note.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', enum: Object.keys(PANE_NAVIGATION_TARGETS) } },
      required: ['target'],
    },
  },
  {
    name: 'todo.write',
    description:
      'Record or update a short plan for a multi-step task. Pass the FULL todo list each time (it replaces the previous one). Keep exactly one item in_progress at a time and mark items completed as you finish them. Use this to plan before acting and to show the user progress; skip it for trivial one-step requests.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Short imperative description of the step.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'reminders.set',
    description:
      'Set a reminder on a note (identified by uuid or exact title) for a given datetime. Reminders sync across devices. Optionally repeat (recurrence) and optionally deliver by email (email:true sends the time + message to the server in PLAINTEXT, leaving end-to-end encryption — only do this when the user explicitly asks).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'The note uuid (preferred).' },
        title: { type: 'string', description: 'The exact note title (used only if uuid is omitted).' },
        datetime: {
          type: 'string',
          description: 'When the reminder is due, as an ISO 8601 string (e.g. 2026-07-01T09:00:00).',
        },
        message: { type: 'string', description: 'Optional reminder message.' },
        recurrence: {
          type: 'object',
          description: 'Optional repeat schedule. Omit (or frequency:"none") for a one-shot reminder.',
          properties: {
            frequency: { type: 'string', enum: [...RECURRENCE_FREQUENCIES] },
            interval: {
              type: 'number',
              description: 'For frequency "custom": how many units between occurrences (>= 1).',
            },
            unit: {
              type: 'string',
              enum: [...RECURRENCE_UNITS],
              description: 'For frequency "custom": the interval unit.',
            },
          },
        },
        email: {
          type: 'boolean',
          description: 'Also deliver this reminder by email (requires an account; sends time + message in plaintext).',
        },
      },
      required: ['datetime'],
    },
  },
  {
    name: 'reminders.list',
    description:
      "List reminders. With a note uuid/title, lists that note's reminders; with no note, lists all reminders across notes, soonest first.",
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        title: { type: 'string' },
      },
    },
  },
  {
    name: 'reminders.clear',
    description:
      'Remove all reminders from a note (identified by uuid or exact title). Also cancels any email-delivery records.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        title: { type: 'string' },
      },
    },
  },
  {
    name: 'web.search',
    description:
      'Search the web for a query and get back a list of {title, url, snippet}. Runs via the server (the query leaves end-to-end encryption). Use this for facts the user notes do not contain; then web.fetch a result url for full content. Returns {error} (not an exception) if web tools are unavailable.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Optional max number of results.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web.fetch',
    description:
      'Fetch a single web page (absolute http(s) url) and get back {title, text} (readable extracted text). Runs via the server (the url leaves end-to-end encryption). Returns {error} (not an exception) if the page cannot be fetched or web tools are unavailable.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
]
