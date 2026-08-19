import {
  AppDataField,
  isLitePayload,
  isNote,
  MutationType,
  NoteMutator,
  PayloadEmitSource,
  SNNote,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { applyAssistantNoteChange, AssistantNoteChange, flushAssistantNoteEditors } from './assistantNoteChanges'
import { sanitizeAssistantNoteChange } from './assistantChatHistory'
import {
  AssistantStructuralEffectLocator,
  AssistantStructuralOperationEffect,
  AssistantSuperRevision,
  redactAssistantEffectFragmentText,
} from './assistantSuperNotePatch'

/**
 * Assistant change history is part of the note's encrypted appData envelope.
 * Normal item sync therefore sees ciphertext only, while another authorized
 * device can render the same audit trail. It is never copied into provider
 * prompts or arbitrary tool results.
 */
export const NoteAssistantChangesKey = 'assistantChanges:v1' as unknown as AppDataField

export const MAX_ASSISTANT_CHANGE_RECORDS = 12
export const ASSISTANT_CHANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000
export const MAX_ASSISTANT_CHANGE_FRAGMENT_CHARS = 2_048
const MAX_ASSISTANT_CHANGE_RECORD_BYTES = 128 * 1_024
const MAX_ASSISTANT_CHANGE_LEDGER_BYTES = 384 * 1_024
const MAX_ASSISTANT_CHANGE_OPERATIONS = 32
const MAX_ASSISTANT_CHANGE_LOCATORS = 32

export type AssistantChangeStatus = 'applied' | 'accepted' | 'dismissed' | 'undone'

export type AssistantChangeSource = {
  assistantMessageId: string
  assistantRunId: string
  toolCallId?: string
}

export type AssistantChangeOperation = {
  operationId: string
  type: AssistantStructuralOperationEffect['type']
  summary: string
  affected: AssistantStructuralEffectLocator[]
  beforeFragment?: string
  afterFragment?: string
  truncated?: boolean
  deleted?: boolean
}

export type AssistantChangeRecord = {
  changeId: string
  noteUuid: string
  source: AssistantChangeSource
  createdAt: string
  updatedAt: string
  baseRevision: AssistantSuperRevision
  newRevision: AssistantSuperRevision
  operations: AssistantChangeOperation[]
  operationIds: string[]
  affectedTodoIds: string[]
  affectedNodeUuids: string[]
  status: AssistantChangeStatus
  /** Full compare-and-swap snapshots remain encrypted inside the note. */
  undo: AssistantNoteChange
}

export type AssistantChangeLedgerEnvelope = {
  version: 1
  records: AssistantChangeRecord[]
}

const emptyLedger = (): AssistantChangeLedgerEnvelope => ({ version: 1, records: [] })

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const containsAsciiControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0)
    return codePoint <= 0x1f || codePoint === 0x7f
  })

const boundedIdentifier = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !containsAsciiControlCharacter(value)

const boundedIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))

const redactFragment = (value: unknown): { value?: string; truncated: boolean } => {
  if (typeof value !== 'string') {
    return { truncated: false }
  }
  const redacted = redactAssistantEffectFragmentText(value)
  return redacted.length <= MAX_ASSISTANT_CHANGE_FRAGMENT_CHARS
    ? { value: redacted, truncated: false }
    : { value: `${redacted.slice(0, MAX_ASSISTANT_CHANGE_FRAGMENT_CHARS)}…`, truncated: true }
}

function sanitizeRevision(value: unknown): AssistantSuperRevision | undefined {
  if (!isRecord(value) || !boundedIdentifier(value.contentHash, 256)) {
    return undefined
  }
  if (value.updatedAt !== undefined && !boundedIsoDate(value.updatedAt)) {
    return undefined
  }
  return {
    contentHash: value.contentHash,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

function sanitizeLocator(value: unknown): AssistantStructuralEffectLocator | undefined {
  if (!isRecord(value) || !Array.isArray(value.path)) {
    return undefined
  }
  if (
    value.path.length > 100 ||
    !value.path.every((segment) => Number.isSafeInteger(segment) && Number(segment) >= 0)
  ) {
    return undefined
  }
  const optionalIds = ['todoId', 'nodeUuid', 'nodeKey'] as const
  if (optionalIds.some((key) => value[key] !== undefined && !boundedIdentifier(value[key], 256))) {
    return undefined
  }
  return {
    path: value.path.map(Number),
    ...(typeof value.todoId === 'string' ? { todoId: value.todoId } : {}),
    ...(typeof value.nodeUuid === 'string' ? { nodeUuid: value.nodeUuid } : {}),
    ...(typeof value.nodeKey === 'string' ? { nodeKey: value.nodeKey } : {}),
  }
}

const OPERATION_TYPES = new Set<AssistantChangeOperation['type']>([
  'insert',
  'replace-text',
  'toggle-checklist',
  'move',
  'delete',
  'update-attrs',
])

function sanitizeOperation(value: unknown): AssistantChangeOperation | undefined {
  if (!isRecord(value) || !boundedIdentifier(value.operationId) || !OPERATION_TYPES.has(value.type as never)) {
    return undefined
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0 || value.summary.length > 512) {
    return undefined
  }
  if (!Array.isArray(value.affected) || value.affected.length > MAX_ASSISTANT_CHANGE_LOCATORS) {
    return undefined
  }
  const affected = value.affected.map(sanitizeLocator)
  if (affected.some((locator) => locator === undefined)) {
    return undefined
  }
  const before = redactFragment(value.beforeFragment)
  const after = redactFragment(value.afterFragment)
  return {
    operationId: value.operationId,
    type: value.type as AssistantChangeOperation['type'],
    summary: value.summary,
    affected: affected as AssistantStructuralEffectLocator[],
    ...(before.value ? { beforeFragment: before.value } : {}),
    ...(after.value ? { afterFragment: after.value } : {}),
    ...(value.truncated === true || before.truncated || after.truncated ? { truncated: true } : {}),
    ...(value.deleted === true ? { deleted: true } : {}),
  }
}

function sanitizeSource(value: unknown): AssistantChangeSource | undefined {
  if (
    !isRecord(value) ||
    !boundedIdentifier(value.assistantMessageId) ||
    !boundedIdentifier(value.assistantRunId) ||
    (value.toolCallId !== undefined && !boundedIdentifier(value.toolCallId))
  ) {
    return undefined
  }
  return {
    assistantMessageId: value.assistantMessageId,
    assistantRunId: value.assistantRunId,
    ...(typeof value.toolCallId === 'string' ? { toolCallId: value.toolCallId } : {}),
  }
}

function sanitizeUndo(value: unknown, noteUuid: string): AssistantNoteChange | undefined {
  const persisted = sanitizeAssistantNoteChange({ ...(isRecord(value) ? value : {}), position: 'after' })
  if (!persisted || persisted.noteUuid !== noteUuid) {
    return undefined
  }
  const { position: _position, ...undo } = persisted
  return undo as AssistantNoteChange
}

export function sanitizeAssistantChangeRecord(
  value: unknown,
  expectedNoteUuid: string,
): AssistantChangeRecord | undefined {
  if (!isRecord(value) || value.noteUuid !== expectedNoteUuid) {
    return undefined
  }
  if (
    !boundedIdentifier(value.changeId) ||
    !boundedIsoDate(value.createdAt) ||
    !boundedIsoDate(value.updatedAt) ||
    !['applied', 'accepted', 'dismissed', 'undone'].includes(String(value.status))
  ) {
    return undefined
  }
  const source = sanitizeSource(value.source)
  const baseRevision = sanitizeRevision(value.baseRevision)
  const newRevision = sanitizeRevision(value.newRevision)
  const undo = sanitizeUndo(value.undo, expectedNoteUuid)
  if (!source || !baseRevision || !newRevision || !undo || !Array.isArray(value.operations)) {
    return undefined
  }
  if (value.operations.length === 0 || value.operations.length > MAX_ASSISTANT_CHANGE_OPERATIONS) {
    return undefined
  }
  const operations = value.operations.map(sanitizeOperation)
  if (operations.some((operation) => operation === undefined)) {
    return undefined
  }
  const safeOperations = operations as AssistantChangeOperation[]
  const operationIds = [...new Set(safeOperations.map((operation) => operation.operationId))]
  if (operationIds.length !== safeOperations.length) {
    return undefined
  }
  const record: AssistantChangeRecord = {
    changeId: value.changeId,
    noteUuid: expectedNoteUuid,
    source,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    baseRevision,
    newRevision,
    operations: safeOperations,
    operationIds,
    affectedTodoIds: [
      ...new Set(safeOperations.flatMap((operation) => operation.affected.flatMap((item) => item.todoId ?? []))),
    ],
    affectedNodeUuids: [
      ...new Set(safeOperations.flatMap((operation) => operation.affected.flatMap((item) => item.nodeUuid ?? []))),
    ],
    status: value.status as AssistantChangeStatus,
    undo,
  }
  return utf8Bytes(JSON.stringify(record)) <= MAX_ASSISTANT_CHANGE_RECORD_BYTES ? record : undefined
}

function trimLedger(records: AssistantChangeRecord[], now = Date.now()): AssistantChangeRecord[] {
  const cutoff = now - ASSISTANT_CHANGE_RETENTION_MS
  const uniqueChanges = new Set<string>()
  const uniqueOperations = new Set<string>()
  const kept: AssistantChangeRecord[] = []
  let bytes = 0
  for (const record of [...records].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))) {
    if (Date.parse(record.createdAt) < cutoff || uniqueChanges.has(record.changeId)) {
      continue
    }
    if (record.operationIds.some((operationId) => uniqueOperations.has(operationId))) {
      continue
    }
    const recordBytes = utf8Bytes(JSON.stringify(record))
    if (kept.length >= MAX_ASSISTANT_CHANGE_RECORDS || bytes + recordBytes > MAX_ASSISTANT_CHANGE_LEDGER_BYTES) {
      continue
    }
    kept.push(record)
    bytes += recordBytes
    uniqueChanges.add(record.changeId)
    record.operationIds.forEach((operationId) => uniqueOperations.add(operationId))
  }
  return kept
}

export function getAssistantChangeLedger(note: SNNote, now = Date.now()): AssistantChangeLedgerEnvelope {
  const raw = note.getAppDomainValue<unknown>(NoteAssistantChangesKey)
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.records)) {
    return emptyLedger()
  }
  const records = raw.records
    .map((record) => sanitizeAssistantChangeRecord(record, note.uuid))
    .filter((record): record is AssistantChangeRecord => Boolean(record))
  return { version: 1, records: trimLedger(records, now) }
}

export function appendAssistantChangeRecord(
  note: SNNote,
  record: AssistantChangeRecord,
  now = Date.now(),
): AssistantChangeLedgerEnvelope {
  const sanitized = sanitizeAssistantChangeRecord(record, note.uuid)
  if (!sanitized) {
    throw new Error('The encrypted assistant change record exceeds its safe storage bounds.')
  }
  return { version: 1, records: trimLedger([sanitized, ...getAssistantChangeLedger(note, now).records], now) }
}

export function findAssistantChangesByOperationIds(
  note: SNNote,
  operationIds: readonly string[],
): AssistantChangeRecord[] {
  if (operationIds.length === 0) {
    return []
  }
  const wanted = new Set(operationIds)
  return getAssistantChangeLedger(note).records.filter((record) =>
    record.operationIds.some((operationId) => wanted.has(operationId)),
  )
}

export function generateAssistantChangeId(prefix: 'change' | 'operation'): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `assistant-${prefix}-${random}`
}

export function createAssistantChangeRecord(input: {
  changeId?: string
  noteUuid: string
  source: AssistantChangeSource
  baseRevision: AssistantSuperRevision
  newRevision: AssistantSuperRevision
  effects: AssistantStructuralOperationEffect[]
  undo: AssistantNoteChange
  createdAt?: string
}): AssistantChangeRecord {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const operations = input.effects.map((effect) => {
    const before = redactFragment(effect.beforeFragment)
    const after = redactFragment(effect.afterFragment)
    return {
      operationId: effect.operationId ?? generateAssistantChangeId('operation'),
      type: effect.type,
      summary: effect.summary,
      affected: effect.affected.slice(0, MAX_ASSISTANT_CHANGE_LOCATORS),
      ...(before.value ? { beforeFragment: before.value } : {}),
      ...(after.value ? { afterFragment: after.value } : {}),
      ...(effect.truncated || before.truncated || after.truncated ? { truncated: true } : {}),
      ...(effect.deleted ? { deleted: true } : {}),
    }
  })
  const record: AssistantChangeRecord = {
    changeId: input.changeId ?? generateAssistantChangeId('change'),
    noteUuid: input.noteUuid,
    source: input.source,
    createdAt,
    updatedAt: createdAt,
    baseRevision: input.baseRevision,
    newRevision: input.newRevision,
    operations,
    operationIds: operations.map((operation) => operation.operationId),
    affectedTodoIds: [
      ...new Set(operations.flatMap((operation) => operation.affected.flatMap((item) => item.todoId ?? []))),
    ],
    affectedNodeUuids: [
      ...new Set(operations.flatMap((operation) => operation.affected.flatMap((item) => item.nodeUuid ?? []))),
    ],
    status: 'applied',
    undo: input.undo,
  }
  const sanitized = sanitizeAssistantChangeRecord(record, input.noteUuid)
  if (!sanitized) {
    throw new Error('The encrypted assistant change record exceeds its safe storage bounds.')
  }
  return sanitized
}

const assistantChangeMutationQueues = new WeakMap<WebApplication, Map<string, Promise<void>>>()

/** Serialize every local ledger read-modify-write for one application/note. */
export async function withAssistantChangeLedgerMutation<T>(
  application: WebApplication,
  noteUuid: string,
  mutation: () => Promise<T>,
): Promise<T> {
  let queues = assistantChangeMutationQueues.get(application)
  if (!queues) {
    queues = new Map()
    assistantChangeMutationQueues.set(application, queues)
  }
  const previous = queues.get(noteUuid) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  queues.set(noteUuid, tail)
  await previous.catch(() => undefined)
  try {
    return await mutation()
  } finally {
    release()
    if (queues.get(noteUuid) === tail) {
      queues.delete(noteUuid)
    }
  }
}

function assertWritable(application: WebApplication, note: SNNote): void {
  if (note.locked || isLitePayload(note.payload) || !application.isAuthorizedToRenderItem(note)) {
    throw new Error('This note is no longer available for an assistant change action.')
  }
  if (application.sessions.isCurrentSessionReadOnly()) {
    throw new Error('This session is read-only.')
  }
  const vault = application.vaults.getItemVault(note)
  if (vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault)) {
    throw new Error('This shared vault is read-only for the current user.')
  }
}

async function persistAssistantChangeStatusUnlocked(
  application: WebApplication,
  noteUuid: string,
  changeId: string,
  status: AssistantChangeStatus,
): Promise<AssistantChangeRecord> {
  await flushAssistantNoteEditors(application, noteUuid)
  const note = application.items.findItem<SNNote>(noteUuid)
  if (!note || !isNote(note)) {
    throw new Error('The changed note no longer exists.')
  }
  assertWritable(application, note)
  const ledger = getAssistantChangeLedger(note)
  const current = ledger.records.find((record) => record.changeId === changeId)
  if (!current) {
    throw new Error('This assistant change is no longer in the retained note history.')
  }
  const updated: AssistantChangeRecord = { ...current, status, updatedAt: new Date().toISOString() }
  const envelope: AssistantChangeLedgerEnvelope = {
    version: 1,
    records: trimLedger(ledger.records.map((record) => (record.changeId === changeId ? updated : record))),
  }
  await application.mutator.changeItem<NoteMutator, SNNote>(
    note,
    (mutator) => mutator.setAppDataItem(NoteAssistantChangesKey, envelope),
    MutationType.NoUpdateUserTimestamps,
    PayloadEmitSource.LocalChanged,
  )
  try {
    void application.sync.sync().catch((error) => console.error('Assistant change status sync failed', error))
  } catch (error) {
    console.error('Assistant change status sync failed', error)
  }
  return updated
}

function persistAssistantChangeStatus(
  application: WebApplication,
  noteUuid: string,
  changeId: string,
  status: AssistantChangeStatus,
): Promise<AssistantChangeRecord> {
  return withAssistantChangeLedgerMutation(application, noteUuid, () =>
    persistAssistantChangeStatusUnlocked(application, noteUuid, changeId, status),
  )
}

export function acceptAssistantChange(
  application: WebApplication,
  noteUuid: string,
  changeId: string,
): Promise<AssistantChangeRecord> {
  return persistAssistantChangeStatus(application, noteUuid, changeId, 'accepted')
}

export function dismissAssistantChange(
  application: WebApplication,
  noteUuid: string,
  changeId: string,
): Promise<AssistantChangeRecord> {
  return persistAssistantChangeStatus(application, noteUuid, changeId, 'dismissed')
}

export async function undoAssistantChange(
  application: WebApplication,
  noteUuid: string,
  changeId: string,
): Promise<AssistantChangeRecord> {
  return withAssistantChangeLedgerMutation(application, noteUuid, async () => {
    const note = application.items.findItem<SNNote>(noteUuid)
    if (!note || !isNote(note) || !application.isAuthorizedToRenderItem(note)) {
      throw new Error('The changed note no longer exists or belongs to this session.')
    }
    const record = getAssistantChangeLedger(note).records.find((candidate) => candidate.changeId === changeId)
    if (!record) {
      throw new Error('This assistant change is no longer in the retained note history.')
    }
    if (record.status === 'undone') {
      return record
    }
    await applyAssistantNoteChange(application, record.undo, 'undo')
    return persistAssistantChangeStatusUnlocked(application, noteUuid, changeId, 'undone')
  })
}
