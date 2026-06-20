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
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { doesItemMatchSearchQuery } from '@/Utils/Items/Search/doesItemMatchSearchQuery'
import { GetAllThemesUseCase } from '@standardnotes/ui-services'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { ToolDefinition, ToolSession } from './types'
import { retrieve } from './retrieval'

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

export interface AssistantToolContext {
  /** Whether mutating tools require user confirmation before executing. */
  confirmBeforeWrite: boolean
  /** Resolves to true if the user approves a mutating action. */
  requestConfirmation: (description: string) => Promise<boolean>
  /** Presents the given pane (used for app.navigate / app.openNote). */
  presentPane: (paneId: AppPaneId) => void
  /**
   * Runs a focused sub-agent for a self-contained subtask and resolves with its
   * final summary. Provided only at the top level; sub-agents cannot delegate.
   */
  runSubAgent?: (task: string, contextText?: string) => Promise<string>
  /** Called when the agent rewrites its todo list, so the UI can render it. */
  onTodosChanged?: (todos: TodoItem[]) => void
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
      context: { type: 'string', description: 'Optional extra context (e.g. relevant note uuids) the sub-agent needs.' },
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

function tagSummary(application: WebApplication, tag: SNTag) {
  return {
    uuid: tag.uuid,
    title: tag.title,
    longTitle: application.items.getTagLongTitle(tag),
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

  tools(): ToolDefinition[] {
    if (this.enableDelegate && this.context.runSubAgent) {
      return [...TOOL_DEFINITIONS, DELEGATE_TOOL]
    }
    return TOOL_DEFINITIONS
  }

  async call(name: string, rawArgs: unknown): Promise<unknown> {
    const args = (rawArgs ?? {}) as Record<string, unknown>
    // Resolve against the live tool list so a withheld tool (e.g. delegate inside
    // a sub-agent) is rejected as unknown rather than silently executing.
    const definition = this.tools().find((t) => t.name === name)
    if (!definition) {
      throw new Error(`Unknown tool: ${name}`)
    }

    if (definition.mutating && this.context.confirmBeforeWrite) {
      const approved = await this.context.requestConfirmation(`Run "${name}" with ${JSON.stringify(args)}?`)
      if (!approved) {
        return { ok: false, cancelled: true, message: 'User declined the action.' }
      }
    }

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
        return this.notesUpdate(args)
      case 'notes.delete':
        return this.notesDelete(args)
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

  private notesList(args: Record<string, unknown>) {
    const limit = typeof args.limit === 'number' ? args.limit : 50
    const includeTrashed = args.includeTrashed === true
    const includeArchived = args.includeArchived === true
    const notes = this.allNotes()
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
      .filter((note) =>
        doesItemMatchSearchQuery(note as DecryptedItemInterface<ItemContent>, query, this.application),
      )
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
    const note = this.requireNote(args.uuid)
    return {
      ...noteSummary(note),
      text: note.text,
      tags: this.application.items.getSortedTagsForItem(note).map((tag) => tagSummary(this.application, tag)),
    }
  }

  private async notesCreate(args: Record<string, unknown>) {
    const title = typeof args.title === 'string' ? args.title : ''
    const text = typeof args.text === 'string' ? args.text : ''
    const template = this.application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
      title,
      text,
      references: [],
    })
    const note = await this.application.mutator.insertItem<SNNote>(template)
    return { ok: true, note: noteSummary(note) }
  }

  private async notesUpdate(args: Record<string, unknown>) {
    const note = this.requireNote(args.uuid)
    const updated = await this.application.mutator.changeItem<NoteMutator, SNNote>(note, (mutator) => {
      if (typeof args.title === 'string') {
        mutator.title = args.title
      }
      if (typeof args.text === 'string') {
        mutator.text = args.text
      }
    })
    return { ok: true, note: noteSummary(updated) }
  }

  private async notesDelete(args: Record<string, unknown>) {
    const note = this.requireNote(args.uuid)
    await this.application.mutator.deleteItem(note)
    return { ok: true, deleted: note.uuid }
  }

  private tagsList() {
    const tags = this.allTags()
    return { count: tags.length, tags: tags.map((tag) => tagSummary(this.application, tag)) }
  }

  private async tagsCreate(args: Record<string, unknown>) {
    const title = typeof args.title === 'string' ? args.title : ''
    if (!title) {
      throw new Error('A tag "title" string is required')
    }
    const tag = await this.application.mutator.findOrCreateTag(title)
    return { ok: true, tag: tagSummary(this.application, tag) }
  }

  private async tagsAssign(args: Record<string, unknown>) {
    const note = this.requireNote(args.noteUuid)
    const tag = this.requireTag(args.tagUuid)
    await this.application.mutator.addTagToNote(note, tag, false)
    return { ok: true, noteUuid: note.uuid, tagUuid: tag.uuid }
  }

  private async tagsUnassign(args: Record<string, unknown>) {
    const note = this.requireNote(args.noteUuid)
    const tag = this.requireTag(args.tagUuid)
    await this.application.mutator.changeItem<TagMutator, SNTag>(tag, (mutator) => {
      mutator.removeItemAsRelationship(note)
    })
    return { ok: true, noteUuid: note.uuid, tagUuid: tag.uuid }
  }

  private async appOpenNote(args: Record<string, unknown>) {
    const note = this.requireNote(args.uuid)
    await this.application.itemListController.openNote(note.uuid)
    this.context.presentPane(AppPaneId.Editor)
    return { ok: true, opened: note.uuid }
  }

  private async appSetPreference(args: Record<string, unknown>) {
    const key = args.key as PrefKey
    if (!ALLOWED_PREFERENCE_KEYS.includes(key)) {
      throw new Error(`Preference "${String(key)}" is not allowed to be set by the assistant`)
    }
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
      throw new Error(`Theme not found: ${identifierOrName}. Available: ${allThemes.map((t) => t.displayName).join(', ')}`)
    }
    await this.application.componentManager.toggleTheme(match)
    return { ok: true, theme: match.displayName }
  }

  private async appNoteAction(args: Record<string, unknown>) {
    const note = this.requireNote(args.uuid)
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
      throw new Error(`Unknown navigation target: ${target}. Allowed: ${Object.keys(PANE_NAVIGATION_TARGETS).join(', ')}`)
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

// Minimal structural mutator types so we don't depend on the concrete mutator class.
interface NoteMutatorLike {
  title: string
  text: string
  pinned: boolean
  archived: boolean
  starred: boolean
  trashed: boolean
}

interface TagMutatorLike {
  removeItemAsRelationship(item: DecryptedItemInterface): void
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
    description: 'Create a new note with a title and text.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
      },
    },
  },
  {
    name: 'notes.update',
    description: 'Update the title and/or text of an existing note by uuid.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        title: { type: 'string' },
        text: { type: 'string' },
      },
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
    description: 'List all tags with their uuid and full hierarchical title.',
    mutating: false,
    inputSchema: { type: 'object', properties: {} },
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
]
