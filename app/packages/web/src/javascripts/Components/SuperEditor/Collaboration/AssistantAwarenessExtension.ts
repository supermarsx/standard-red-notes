import { modifyAwarenessUpdate } from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'

type Activity = { runId: string; status: 'working' | 'reading' | 'editing' }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
function activities(value: unknown): Activity[] | undefined {
  if (!Array.isArray(value) || value.length > 8) {
    return undefined
  }
  const result: Activity[] = []
  for (const entry of value) {
    if (
      !record(entry) ||
      Object.keys(entry).some((key) => !['runId', 'status'].includes(key)) ||
      typeof entry.runId !== 'string' ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(entry.runId) ||
      !['working', 'reading', 'editing'].includes(entry.status as string)
    ) {
      return undefined
    }
    result.push({ runId: entry.runId, status: entry.status as Activity['status'] })
  }
  return result
}

export const assistantAwarenessAAD = (room: string, humanCiphertext: string): Uint8Array =>
  new TextEncoder().encode(JSON.stringify([room, 'assistant-awareness-v1', humanCiphertext]))

/** The normal awareness payload remains byte-compatible with older clients. */
export function splitAssistantAwareness(update: Uint8Array): { human: Uint8Array; extension?: Uint8Array } {
  const decoder = decoding.createDecoder(update)
  const count = decoding.readVarUint(decoder)
  const clientId = count === 1 ? decoding.readVarUint(decoder) : undefined
  let selected: Activity[] | undefined
  const human = modifyAwarenessUpdate(update, (state) => {
    if (!record(state) || !record(state.awarenessData)) {
      return state
    }
    const { assistantActivity, ...metadata } = state.awarenessData
    selected = activities(assistantActivity)
    return { ...state, awarenessData: metadata }
  })
  return {
    human,
    ...(clientId !== undefined && selected
      ? { extension: new TextEncoder().encode(JSON.stringify({ clientId, activities: selected })) }
      : {}),
  }
}

/** Invalid optional decoration is ignored; it must never invalidate human presence. */
export function mergeAssistantAwareness(update: Uint8Array, extension: Uint8Array): Uint8Array {
  try {
    if (extension.byteLength > 4096) {
      return update
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(extension))
    if (
      !record(parsed) ||
      Object.keys(parsed).some((key) => !['clientId', 'activities'].includes(key)) ||
      !Number.isSafeInteger(parsed.clientId) ||
      (parsed.clientId as number) < 0
    ) {
      return update
    }
    const selected = activities(parsed.activities)
    if (!selected) {
      return update
    }
    const decoder = decoding.createDecoder(update)
    if (decoding.readVarUint(decoder) !== 1 || decoding.readVarUint(decoder) !== parsed.clientId) {
      return update
    }
    return modifyAwarenessUpdate(update, (state) => {
      return record(state) && record(state.awarenessData) && typeof state.awarenessData.userUuid === 'string'
        ? { ...state, awarenessData: { ...state.awarenessData, assistantActivity: selected } }
        : state
    })
  } catch {
    return update
  }
}
