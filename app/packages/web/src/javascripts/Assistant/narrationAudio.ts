// Persisting a produced narration so it is reproducible/playable later.
//
// PRIMARY PATH: attach the generated TTS audio Blob to the note as a real file via
// the files controller (same mechanism as AudioRecorderModal's "Save to note"). The
// attachment is encrypted + synced in the user's own Standard Red Notes storage and
// survives reloads. We also record lightweight, device-local metadata (note uuid,
// created date, voice, language, the attached file's uuid) so produced narrations
// can be listed and re-found.
//
// Only model-TTS produces a downloadable audio Blob. Web Speech synthesizes on the
// device with no capturable stream, so there is nothing to attach for that backend.

import { FileItem, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { FilesController } from '@/Controllers/FilesController'
import { formatDateAndTimeForNote } from '@/Utils/DateUtils'

const METADATA_KEY = 'standardnotes.narration.audio.v1'
const MAX_METADATA_ENTRIES = 200

export interface NarrationAudioRecord {
  /** Uuid of the note the narration was produced from. */
  noteUuid: string
  /** Uuid of the attached file (when the attach succeeded). */
  fileUuid?: string
  /** Display file name used for the attachment. */
  fileName: string
  /** Epoch ms the narration was created. */
  createdAt: number
  /** Model-TTS voice name used (e.g. 'alloy'), if any. */
  voice: string
  /** Free-text language/dialect label, or '' when none. */
  language: string
}

function sanitizeTitle(title: string): string {
  const trimmed = (title || 'Untitled').replace(/[\\/:*?"<>|]/g, ' ').trim()
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'Untitled'
}

function extensionForBlob(blob: Blob): string {
  if (blob.type.includes('wav')) {
    return 'wav'
  }
  if (blob.type.includes('ogg')) {
    return 'ogg'
  }
  return 'mp3'
}

/** Build a sensible attachment name, e.g. "Narration — My note — 2026-01-02 …". */
export function buildNarrationFileName(noteTitle: string, blob: Blob, when = new Date()): string {
  return `Narration — ${sanitizeTitle(noteTitle)} — ${formatDateAndTimeForNote(when)}.${extensionForBlob(blob)}`
}

function loadRecords(): NarrationAudioRecord[] {
  try {
    const raw = localStorage.getItem(METADATA_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as NarrationAudioRecord[]) : []
  } catch {
    return []
  }
}

function saveRecords(records: NarrationAudioRecord[]): void {
  try {
    localStorage.setItem(METADATA_KEY, JSON.stringify(records.slice(-MAX_METADATA_ENTRIES)))
  } catch {
    /* storage may be unavailable; metadata is best-effort */
  }
}

/** All persisted narration-audio records for a given note, newest first. */
export function listNarrationAudioForNote(noteUuid: string): NarrationAudioRecord[] {
  return loadRecords()
    .filter((record) => record.noteUuid === noteUuid)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function appendRecord(record: NarrationAudioRecord): void {
  const records = loadRecords()
  records.push(record)
  saveRecords(records)
}

export interface SaveNarrationOptions {
  voice?: string
  language?: string
}

export interface SaveNarrationResult {
  attached: boolean
  fileUuid?: string
  fileName: string
  error?: string
}

/**
 * Attach a produced narration Blob to `note` as a file and record its metadata.
 * Returns whether the attach succeeded. On failure the metadata is still recorded
 * (without a fileUuid) so the produced narration is at least logged.
 */
export async function saveNarrationToNote(
  filesController: FilesController,
  note: SNNote,
  blob: Blob,
  options: SaveNarrationOptions = {},
): Promise<SaveNarrationResult> {
  const createdAt = Date.now()
  const fileName = buildNarrationFileName(note.title ?? '', blob, new Date(createdAt))
  const baseRecord: NarrationAudioRecord = {
    noteUuid: note.uuid,
    fileName,
    createdAt,
    voice: options.voice ?? '',
    language: options.language ?? '',
  }

  try {
    const file = new File([blob], fileName, { type: blob.type || 'audio/mpeg' })
    const uploaded = await filesController.uploadNewFile(file, { note, showToast: false })
    if (!uploaded) {
      appendRecord(baseRecord)
      return { attached: false, fileName, error: 'Upload returned no file.' }
    }
    appendRecord({ ...baseRecord, fileUuid: uploaded.uuid })
    return { attached: true, fileUuid: uploaded.uuid, fileName }
  } catch (error) {
    appendRecord(baseRecord)
    return { attached: false, fileName, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Fetch a previously-attached narration's audio Blob for replay (by file uuid). */
export async function getNarrationAudioBlob(
  application: WebApplication,
  fileUuid: string,
): Promise<Blob | undefined> {
  const file = application.items.findItem<FileItem>(fileUuid)
  if (!file) {
    return undefined
  }
  return application.filesController.getFileBlob(file)
}
