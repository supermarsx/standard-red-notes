import { parseEditorResume, type EditorResumeState } from './EditorResumeState'

const memory = new Map<string, EditorResumeState>()
const deviceKey = 'srn-editor-resume-device-v1'
let deviceId: string | undefined

export function editorResumeStorageKey(applicationId: string, accountId: string, noteUuid: string): string {
  if (!deviceId) {
    try {
      deviceId =
        localStorage.getItem(deviceKey) ||
        (typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(
              '',
            ))
      localStorage.setItem(deviceKey, deviceId)
    } catch {
      deviceId ||= `session-${Date.now()}`
    }
  }
  return `srn-editor-resume-v1:${[applicationId, accountId, deviceId, noteUuid].map(encodeURIComponent).join(':')}`
}

export function readEditorResume(key: string): EditorResumeState | undefined {
  try {
    return parseEditorResume(localStorage.getItem(key)) ?? memory.get(key)
  } catch {
    return memory.get(key)
  }
}

export function writeEditorResume(key: string, state: EditorResumeState): void {
  const current = readEditorResume(key)
  if ((current?.lastInteractionAt ?? 0) > (state.lastInteractionAt ?? 0)) {
    return
  }
  memory.set(key, state)
  // View metadata is best effort; a blocked/quota-limited store cannot block editing.
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Reopening in this process can still use the memory copy.
  }
}
