import { ContentType, SNNote, NoteContent, isNote } from '@standardnotes/snjs'
import { NoteType } from '@standardnotes/features'
import type { WebApplication } from '@/Application/WebApplication'
import { AssistantTools } from './tools'
import { AssistantNoteSnapshot, captureAssistantNoteSnapshot, flushAssistantNoteEditors } from './assistantNoteChanges'
import { captureAssistantSessionPrincipal, assistantSessionPrincipalMatches } from './assistantSessionPrincipal'
import { assistantSuperRevision, AssistantStructureRead } from './assistantSuperNotePatch'

export type ResearchReportTarget = { kind: 'new'; title: string } | { kind: 'existing'; noteUuid: string }
export function researchReportTargets(application: WebApplication): SNNote[] {
  return application.items
    .getItems<SNNote>(ContentType.TYPES.Note)
    .filter((note) => !note.trashed && !note.locked && application.isAuthorizedToRenderItem(note))
}

/** An explicit Save click authorizes only this target; it never reuses a long-running agent's scope. */
export async function saveResearchReport(
  application: WebApplication,
  input: { report: string; reportId: string; target: ResearchReportTarget },
  signal?: AbortSignal,
): Promise<string> {
  if (!input.report.trim()) {
    throw new Error('There are no findings to save.')
  }
  const principal = captureAssistantSessionPrincipal(application.sessions)
  const current = () =>
    !signal?.aborted &&
    assistantSessionPrincipalMatches(principal, captureAssistantSessionPrincipal(application.sessions))
  const check = () => {
    if (!current()) {
      throw new Error('The account changed or saving was cancelled. Try again in the current account.')
    }
  }
  check()
  if (input.target.kind === 'new') {
    if (application.sessions.isCurrentSessionReadOnly?.()) {
      throw new Error('The current session is read-only; findings cannot be saved to a new note.')
    }
    // This is an explicit user export, not an agent edit. Preserve the complete
    // Markdown verbatim without the reversible tool ledger's per-note size cap.
    const items = application.items
    const mutator = application.mutator
    const template = items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
      title: input.target.title.trim() || 'Research findings',
      text: input.report,
      references: [],
    })
    check()
    const discard = async () => {
      await mutator.setItemToBeDeleted(template)
      if (items.findItem(template.uuid)) {
        throw new Error('The generated note could not safely be discarded after saving was interrupted.')
      }
    }
    try {
      await mutator.insertItem<SNNote>(template)
    } catch (error) {
      await discard()
      throw error
    }
    if (!current()) {
      await discard()
      check()
    }
    return template.uuid
  }
  const selected = new Set<string>()
  const snapshots = new Map<string, AssistantNoteSnapshot>()
  let note: SNNote | undefined
  if (input.target.kind === 'existing') {
    selected.add(input.target.noteUuid)
    const candidate = application.items.findItem(input.target.noteUuid)
    if (
      !candidate ||
      !isNote(candidate) ||
      candidate.trashed ||
      candidate.locked ||
      !application.isAuthorizedToRenderItem(candidate)
    ) {
      throw new Error('This note is not available for saving findings.')
    }
    await flushAssistantNoteEditors(application, candidate.uuid)
    check()
    const latest = application.items.findItem(candidate.uuid)
    if (
      !latest ||
      !isNote(latest) ||
      latest.trashed ||
      latest.locked ||
      !application.isAuthorizedToRenderItem(latest)
    ) {
      throw new Error('This note is no longer available.')
    }
    note = latest
    snapshots.set(note.uuid, captureAssistantNoteSnapshot(note))
  }
  const tools = new AssistantTools(
    application,
    {
      signal,
      isSessionCurrent: current,
      selectedNoteUuids: selected,
      expectedNoteSnapshots: snapshots,
      assistantMessageId: input.reportId,
      assistantRunId: `save-report:${input.reportId}`,
      confirmBeforeWrite: false,
      shouldRequestConfirmation: () => false,
      requestConfirmation: async () => false,
      presentPane: () => {},
    },
    false,
  )
  let result: unknown
  if (note?.noteType === NoteType.Super) {
    if (input.report.length > 16384) {
      throw new Error(
        'Appending to an existing rich note supports findings up to 16,384 characters. Save the complete report to a new note instead.',
      )
    }
    const structure = (await tools.call('notes.readBlocks', {
      uuid: note.uuid,
      view: 'blocks',
      limit: 100,
    })) as AssistantStructureRead
    check()
    // Parse only the already-authorized snapshot to locate the final top-level block,
    // even when the structural read's display limit omits it. The returned revision guards the patch.
    const snapshotRevision = await assistantSuperRevision(note.text)
    if (snapshotRevision.contentHash !== structure.revision.contentHash) {
      throw new Error('The note changed while preparing the save. Try again.')
    }
    const parsed = JSON.parse(note.text) as { root?: { children?: unknown[] } }
    const children = parsed.root?.children
    if (!Array.isArray(children)) {
      throw new Error('The note structure could not be read safely.')
    }
    if (!children.length) {
      result = await tools.call('notes.updateSuper', { uuid: note.uuid, markdown: input.report, fullReplacement: true })
    } else {
      result = await tools.call('notes.patchBlocks', {
        uuid: note.uuid,
        base: structure.revision,
        operations: [
          {
            type: 'insert',
            position: 'after',
            target: { path: [children.length - 1] },
            block: { kind: 'markdown-fragment', markdown: input.report },
          },
        ],
      })
    }
  } else if (note) {
    result = await tools.call('notes.update', {
      uuid: note.uuid,
      text: note.text ? `${note.text}\n\n${input.report}` : input.report,
    })
  }
  const response = result as
    { ok?: boolean; cancelled?: boolean; reason?: string; note?: { uuid?: string } } | undefined
  if (!response?.ok || response.cancelled) {
    throw new Error(response?.reason || 'The findings could not be saved. Reopen the note and try again.')
  }
  const uuid = response.note?.uuid ?? note?.uuid
  if (!uuid) {
    throw new Error('The saved note could not be identified.')
  }
  return uuid
}
