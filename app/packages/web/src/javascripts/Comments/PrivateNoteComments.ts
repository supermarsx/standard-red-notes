import { ContentType, PrefKey, SNNote, SNUserPrefs, UserPrefsMutator } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import {
  NoteComment,
  normalizeComment,
  MAX_NOTE_COMMENTS,
  MAX_COMMENT_REPLIES_PER_THREAD,
  utf8ByteLength,
} from './comments'

// Literal also works while older generated SDK bundles are being rebuilt.
export const PRIVATE_NOTE_COMMENTS_KEY = 'privateNoteComments' as PrefKey.PrivateNoteComments
export const MAX_PRIVATE_COMMENT_BYTES = 256 * 1024
export const MAX_PRIVATE_COMMENT_NOTES = 256
type PrivateComments = { version: 1; ownerUuid: string; notes: Record<string, NoteComment[]> }
const queues = new WeakMap<WebApplication, Promise<unknown>>()

export function normalizePrivateComments(value: unknown, ownerUuid: string): PrivateComments | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Partial<PrivateComments>
  if (
    candidate.version !== 1 ||
    candidate.ownerUuid !== ownerUuid ||
    !candidate.notes ||
    typeof candidate.notes !== 'object' ||
    Array.isArray(candidate.notes)
  ) {
    return undefined
  }
  const entries = Object.entries(candidate.notes)
  let bytes: number
  try {
    bytes = utf8ByteLength(JSON.stringify(value))
  } catch {
    return undefined
  }
  if (entries.length > MAX_PRIVATE_COMMENT_NOTES || bytes > MAX_PRIVATE_COMMENT_BYTES) {
    return undefined
  }
  const notes: Record<string, NoteComment[]> = Object.create(null)
  for (const [uuid, comments] of entries) {
    if (!uuid || uuid.length > 128 || !Array.isArray(comments) || comments.length > MAX_NOTE_COMMENTS) {
      return undefined
    }
    const normalized = comments.map(normalizeComment)
    if (normalized.some((comment) => !comment || comment.authorUuid !== ownerUuid)) {
      return undefined
    }
    notes[uuid] = normalized as NoteComment[]
  }
  return { version: 1, ownerUuid, notes }
}

function personalPreferences(application: WebApplication): SNUserPrefs | undefined {
  const candidates = application.items.getItems<SNUserPrefs>(ContentType.TYPES.UserPrefs)
  return candidates.find(
    (item): item is SNUserPrefs =>
      item instanceof SNUserPrefs && !item.shared_vault_uuid && !item.key_system_identifier,
  )
}

export function readPrivateNoteComments(application: WebApplication, noteUuid: string): NoteComment[] {
  const owner = application.sessions.getUser()?.uuid
  const preferences = personalPreferences(application)
  const note = application.items.findItem<SNNote>(noteUuid)
  if (!owner || !preferences || !note || !application.isAuthorizedToRenderItem(note)) {
    return []
  }
  return normalizePrivateComments(preferences.getPref(PRIVATE_NOTE_COMMENTS_KEY), owner)?.notes[noteUuid] ?? []
}

/** Only the personal UserPrefs item is mutated; no shared note or relay receives private text. */
export async function mutatePrivateNoteComments(
  application: WebApplication,
  noteUuid: string,
  update: (comments: NoteComment[]) => NoteComment[],
): Promise<void> {
  const user = application.sessions.getUser()
  const valid = (): boolean => {
    const note = application.items.findItem<SNNote>(noteUuid)
    return Boolean(
      user &&
      application.sessions.getUser() === user &&
      note &&
      !note.trashed &&
      !application.sessions.isCurrentSessionReadOnly() &&
      application.isAuthorizedToRenderItem(note),
    )
  }
  const work = (queues.get(application) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const preferences = personalPreferences(application)
      if (!valid() || !preferences || !application.sync.isDatabaseLoaded()) {
        throw new Error('Private comments are unavailable until your account data is loaded and unlocked.')
      }
      await application.mutator.changeItem<UserPrefsMutator, SNUserPrefs>(preferences, (mutator) => {
        if (!valid() || personalPreferences(application)?.uuid !== preferences.uuid) {
          throw new Error('The account changed before this private comment could be saved.')
        }
        const latest = personalPreferences(application)!
        const raw = latest.getPref(PRIVATE_NOTE_COMMENTS_KEY)
        const store =
          raw === undefined
            ? { version: 1 as const, ownerUuid: user!.uuid, notes: {} }
            : normalizePrivateComments(raw, user!.uuid)
        if (!store) {
          throw new Error(
            'Private comments could not be read safely. Export your account data before repairing this preference.',
          )
        }
        const nextComments = update(store.notes[noteUuid] ?? [])
        const notes = { ...store.notes }
        if (nextComments.length) {
          notes[noteUuid] = nextComments
        } else {
          delete notes[noteUuid]
        }
        const next = { ...store, notes }
        if (
          nextComments.some(
            (comment) =>
              comment.parentId &&
              nextComments.filter((reply) => reply.parentId === comment.parentId).length >
                MAX_COMMENT_REPLIES_PER_THREAD,
          ) ||
          !normalizePrivateComments(next, user!.uuid)
        ) {
          throw new Error(
            'Private comment storage is full. Delete older private comments or export them before adding more.',
          )
        }
        mutator.setPref(PRIVATE_NOTE_COMMENTS_KEY, next)
      })
      if (valid()) {
        void application.sync.sync({ sourceDescription: 'Private note comments' })
      }
    })
  queues.set(application, work)
  try {
    await work
  } finally {
    if (queues.get(application) === work) {
      queues.delete(application)
    }
  }
}
