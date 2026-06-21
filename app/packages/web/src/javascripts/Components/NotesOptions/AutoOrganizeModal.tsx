import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  FolderContent,
  FolderContentType,
  FolderMutator,
  SNFolder,
  SNNote,
  SNTag,
} from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import Icon from '../Icon/Icon'
import { getSelectionAIAvailability } from '@/Assistant/selectionActions'
import { notePlaintextForTags } from '@/Assistant/tagSuggestions'
import {
  buildOrganizeDigest,
  DEFAULT_MAX_NOTES,
  ParsedPlan,
  requestCurrentNotePlan,
  requestOrganizePlan,
} from '@/Assistant/autoOrganize'

type Mode = 'current-note' | 'all-notes'

type Props = {
  application: WebApplication
  /** The active note — required for the current-note mode, optional for all-notes. */
  note?: SNNote
  mode: Mode
  isOpen: boolean
  close: () => void
}

/** A per-note assignment resolved to a live note plus its proposed folder/tags. */
type ResolvedAssignment = {
  note: SNNote
  folder: string
  tags: string[]
}

/** What the preview shows + what apply consumes. */
type Preview = {
  /** Folder names that do not yet exist (will be created). */
  newFolders: string[]
  /** Tag names that do not yet exist (will be created). */
  newTags: string[]
  /** Resolved per-note assignments (notes that survived id validation). */
  assignments: ResolvedAssignment[]
  /** How many notes were considered for the digest. */
  consideredCount: number
  /** How many notes were skipped because of the cap / budget. */
  skippedCount: number
}

const lower = (value: string): string => value.trim().toLowerCase()

const AutoOrganizeModalContent = observer(({ application, note, mode, close }: Omit<Props, 'isOpen'>) => {
  const aiAvailability = useMemo(() => getSelectionAIAvailability(application), [application])

  const existingTags = useMemo(() => application.items.getDisplayableTags(), [application])
  const existingFolders = useMemo(() => application.navigationController.folders, [application])

  const [preview, setPreview] = useState<Preview | null>(null)
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ranOnce, setRanOnce] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const existingFolderNames = useMemo(() => new Set(existingFolders.map((f) => lower(f.title))), [existingFolders])
  const existingTagNames = useMemo(() => new Set(existingTags.map((t) => lower(t.title))), [existingTags])

  const buildPreviewFromPlan = useCallback(
    (folders: string[], tags: string[], assignments: ResolvedAssignment[], considered: number, skipped: number): Preview => {
      const newFolders = folders.filter((name) => !existingFolderNames.has(lower(name)))
      const newTags = tags.filter((name) => !existingTagNames.has(lower(name)))
      return { newFolders, newTags, assignments, consideredCount: considered, skippedCount: skipped }
    },
    [existingFolderNames, existingTagNames],
  )

  const generate = useCallback(async () => {
    if (!aiAvailability.available) {
      return
    }
    setGenerating(true)
    setError(null)
    setRanOnce(true)
    setPreview(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const existingFolderTitles = existingFolders.map((f) => f.title)
      const existingTagTitles = existingTags.map((t) => t.title)

      if (mode === 'current-note') {
        if (!note) {
          throw new Error('No active note to organize.')
        }
        const plaintext = notePlaintextForTags(note.text ?? '', note.noteType)
        if (!plaintext.trim() && !(note.title ?? '').trim()) {
          addToast({ type: ToastType.Regular, message: 'This note is empty — nothing to organize.' })
          setGenerating(false)
          return
        }
        const plan = await requestCurrentNotePlan(
          application,
          { title: note.title ?? '', plaintext, existingFolders: existingFolderTitles, existingTags: existingTagTitles },
          { signal: controller.signal },
        )
        const assignments: ResolvedAssignment[] =
          plan.folder || plan.tags.length > 0 ? [{ note, folder: plan.folder, tags: plan.tags }] : []
        const folders = plan.folder ? [plan.folder] : []
        setPreview(buildPreviewFromPlan(folders, plan.tags, assignments, 1, 0))
      } else {
        // All-notes: snapshot the library, build a budgeted/capped digest keyed by uuid.
        const allNotes = application.items.getDisplayableNotes()
        const digest = buildOrganizeDigest(
          allNotes.map((n) => ({
            id: n.uuid,
            title: n.title ?? '',
            plaintext: notePlaintextForTags(n.text ?? '', n.noteType),
          })),
          { maxNotes: DEFAULT_MAX_NOTES },
        )
        if (digest.includedCount === 0) {
          addToast({ type: ToastType.Regular, message: 'No notes to organize.' })
          setGenerating(false)
          return
        }
        const plan: ParsedPlan = await requestOrganizePlan(
          application,
          {
            digest: digest.text,
            validIds: digest.includedIds,
            existingFolders: existingFolderTitles,
            existingTags: existingTagTitles,
          },
          { signal: controller.signal },
        )
        const byUuid = new Map(allNotes.map((n) => [n.uuid, n]))
        const assignments: ResolvedAssignment[] = plan.assignments
          .map((a) => {
            const resolved = byUuid.get(a.id)
            return resolved ? { note: resolved, folder: a.folder, tags: a.tags } : undefined
          })
          .filter((a): a is ResolvedAssignment => !!a)
        setPreview(buildPreviewFromPlan(plan.folders, plan.tags, assignments, digest.includedCount, digest.omittedCount))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
      abortRef.current = null
    }
  }, [aiAvailability.available, application, buildPreviewFromPlan, existingFolders, existingTags, mode, note])

  const apply = useCallback(async () => {
    if (!preview || preview.assignments.length === 0) {
      return
    }
    setApplying(true)
    try {
      // Resolve / create folders and tags by name, case-insensitively. Folder/tag
      // creation is ADDITIVE — we never delete or move anything destructively.
      const folderByName = new Map<string, SNFolder>()
      for (const folder of application.navigationController.folders) {
        folderByName.set(lower(folder.title), folder)
      }
      const tagByName = new Map<string, SNTag>()
      for (const tag of application.items.getDisplayableTags()) {
        tagByName.set(lower(tag.title), tag)
      }

      const ensureFolder = async (name: string): Promise<SNFolder> => {
        const existing = folderByName.get(lower(name))
        if (existing) {
          return existing
        }
        const template = application.items.createTemplateItem<FolderContent, SNFolder>(FolderContentType, {
          title: name,
        } as unknown as FolderContent)
        const created = await application.mutator.insertItem<SNFolder>(template)
        folderByName.set(lower(name), created)
        return created
      }

      const ensureTag = async (name: string): Promise<SNTag> => {
        const existing = tagByName.get(lower(name))
        if (existing) {
          return existing
        }
        const created = await application.mutator.findOrCreateTag(name)
        tagByName.set(lower(name), created)
        return created
      }

      let foldersAssigned = 0
      let tagsAdded = 0
      for (const assignment of preview.assignments) {
        if (assignment.folder) {
          const folder = await ensureFolder(assignment.folder)
          // Add folder membership without removing the note from any other folder is
          // not what moveNoteToFolder does (folders are single-location), so we add
          // membership directly via the folder mutator — additive, no trashing.
          await application.mutator.changeItem<FolderMutator>(folder, (m) => m.addNote(assignment.note))
          foldersAssigned += 1
        }
        for (const tagName of assignment.tags) {
          const tag = await ensureTag(tagName)
          // Link without syncing per-tag; we sync once at the end.
          await application.linkingController.addTagToItem(tag, assignment.note, false)
          tagsAdded += 1
        }
      }

      await application.sync.sync()

      addToast({
        type: ToastType.Success,
        message: `Organized ${preview.assignments.length} ${
          preview.assignments.length === 1 ? 'note' : 'notes'
        }: ${foldersAssigned} folder assignment${foldersAssigned === 1 ? '' : 's'}, ${tagsAdded} topic${
          tagsAdded === 1 ? '' : 's'
        } added.`,
      })
      close()
    } catch (err) {
      addToast({
        type: ToastType.Error,
        message: err instanceof Error ? `Could not organize: ${err.message}` : 'Could not organize notes.',
      })
    } finally {
      setApplying(false)
    }
  }, [application, preview, close])

  const noPlan = ranOnce && !generating && !error && (!preview || preview.assignments.length === 0)
  const canApply = !!preview && preview.assignments.length > 0 && !applying && !generating

  const titleLabel = mode === 'current-note' ? 'Auto-organize note' : 'Auto-organize all notes'

  return (
    <Modal
      title={titleLabel}
      className="p-4"
      close={close}
      actions={[
        {
          label: 'Cancel',
          type: 'cancel',
          onClick: close,
          mobileSlot: 'left',
        },
        {
          label: applying ? 'Applying…' : 'Apply',
          type: 'primary',
          onClick: () => void apply(),
          disabled: !canApply,
          mobileSlot: 'right',
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* Data-exposure notice — same pattern as Suggest tags / Narrate. */}
        <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm">
          <div className="font-semibold text-warning">Auto-organize sends note content to an AI</div>
          <p className="mt-1">
            {mode === 'current-note'
              ? 'Generating a plan sends this note’s title and text to the AI provider you configured.'
              : `Generating a plan sends a digest of your note titles and short snippets (up to ${DEFAULT_MAX_NOTES} notes) to the AI provider you configured.`}{' '}
            Nothing is changed until you review the plan and confirm below. Creating folders and topics is additive — no
            notes are moved to trash or deleted.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="flex items-center gap-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast disabled:opacity-50"
            onClick={() => void generate()}
            disabled={!aiAvailability.available || generating || applying}
          >
            <Icon type="dashboard" size="small" />
            {generating ? 'Planning…' : ranOnce ? 'Plan again' : 'Generate plan'}
          </button>
        </div>

        {!aiAvailability.available && <p className="text-xs text-passive-0">{aiAvailability.reason}</p>}
        {error && <p className="text-sm text-danger">Could not generate a plan: {error}</p>}
        {noPlan && (
          <p className="text-sm text-passive-0">
            The AI didn’t return a usable organization plan. Try generating again.
          </p>
        )}

        {preview && preview.assignments.length > 0 && (
          <div className="flex flex-col gap-3">
            {mode === 'all-notes' && preview.skippedCount > 0 && (
              <p className="text-xs text-passive-0">
                Considered {preview.consideredCount} note{preview.consideredCount === 1 ? '' : 's'};{' '}
                {preview.skippedCount} not included (library exceeds the {DEFAULT_MAX_NOTES}-note limit or the size
                budget). Run again after organizing to handle the rest.
              </p>
            )}

            {(preview.newFolders.length > 0 || preview.newTags.length > 0) && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">Will create</span>
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  {preview.newFolders.map((name) => (
                    <span key={`f-${name}`} className="flex items-center gap-1 rounded bg-contrast px-2 py-0.5">
                      <Icon type="folder" size="small" className="text-info" />
                      {name}
                    </span>
                  ))}
                  {preview.newTags.map((name) => (
                    <span key={`t-${name}`} className="flex items-center gap-1 rounded bg-contrast px-2 py-0.5">
                      <Icon type="hashtag" size="small" className="text-info" />
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">
                Assignments ({preview.assignments.length} note{preview.assignments.length === 1 ? '' : 's'})
              </span>
              <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
                {preview.assignments.map((assignment) => (
                  <div key={assignment.note.uuid} className="rounded border border-border p-2 text-sm">
                    <div className="font-medium">{assignment.note.title || 'Untitled note'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      {assignment.folder && (
                        <span className="flex items-center gap-1 text-neutral">
                          <Icon type="folder" size="small" />
                          {assignment.folder}
                        </span>
                      )}
                      {assignment.tags.map((tag) => (
                        <span key={tag} className="flex items-center gap-0.5 text-neutral">
                          <Icon type="hashtag" size="small" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
})

const AutoOrganizeModal = ({ application, note, mode, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[36rem]">
      <AutoOrganizeModalContent application={application} note={note} mode={mode} close={close} />
    </ModalOverlay>
  )
}

export default observer(AutoOrganizeModal)
