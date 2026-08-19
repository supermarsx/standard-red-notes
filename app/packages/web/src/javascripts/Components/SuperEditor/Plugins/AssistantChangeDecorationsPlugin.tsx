import { AssistantChangeRecord } from '@/Assistant/assistantChangeLedger'
import { assistantNoteSnapshotMatches } from '@/Assistant/assistantNoteChanges'
import { AssistantStructuralEffectLocator } from '@/Assistant/assistantSuperNotePatch'
import { useAssistantChangeLedger } from '@/Assistant/useAssistantChangeLedger'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $isListItemNode } from '@lexical/list'
import { SNNote } from '@standardnotes/snjs'
import { $getNodeByKey, $getRoot, $isElementNode, LexicalEditor, LexicalNode } from 'lexical'
import { useEffect, useMemo, useRef, useState } from 'react'
import { $getChecklistTodoId } from '../Lexical/Nodes/ChecklistItemNode'

export const ASSISTANT_CHANGE_DECORATION_MS = 6_000
export const ASSISTANT_CHANGE_RECENCY_MS = 15_000

type NodeRecord = {
  node: LexicalNode
  path: number[]
  todoId?: string
  nodeUuid?: string
}

function serializedIdentifier(node: LexicalNode): string | undefined {
  const serialized = node.exportJSON() as unknown as Record<string, unknown>
  const state =
    typeof serialized.$ === 'object' && serialized.$ !== null ? (serialized.$ as Record<string, unknown>) : undefined
  const candidates = [serialized.uuid, serialized.id, serialized.nodeUuid, state?.uuid, state?.nodeUuid]
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
}

function collectNodeRecords(): NodeRecord[] {
  const records: NodeRecord[] = []
  const visit = (node: LexicalNode, path: number[]): void => {
    records.push({
      node,
      path,
      ...($isListItemNode(node) && $getChecklistTodoId(node) ? { todoId: $getChecklistTodoId(node) } : {}),
      ...(serializedIdentifier(node) ? { nodeUuid: serializedIdentifier(node) } : {}),
    })
    if ($isElementNode(node)) {
      node.getChildren().forEach((child, index) => visit(child, [...path, index]))
    }
  }
  visit($getRoot(), [])
  return records
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

function resolveLocator(
  records: NodeRecord[],
  locator: AssistantStructuralEffectLocator,
  allowUnstableFallback: boolean,
): LexicalNode | undefined {
  if (locator.todoId) {
    const byTodoId = records.find((record) => record.todoId === locator.todoId)
    if (byTodoId) {
      return byTodoId.node
    }
  }
  if (locator.nodeUuid) {
    const byUuid = records.find((record) => record.nodeUuid === locator.nodeUuid)
    if (byUuid) {
      return byUuid.node
    }
  }
  if (!allowUnstableFallback) {
    return undefined
  }
  if (locator.nodeKey) {
    const byKey = $getNodeByKey(locator.nodeKey)
    if (byKey) {
      return byKey
    }
  }
  return records.find((record) => samePath(record.path, locator.path))?.node
}

/** Resolve retained stable locators against the current editor without mutating its document. */
export function resolveAssistantChangeNodeKeys(
  editor: LexicalEditor,
  record: AssistantChangeRecord,
  currentNote?: SNNote,
): string[] {
  const keys = new Set<string>()
  const editorText = JSON.stringify(editor.getEditorState().toJSON())
  const allowUnstableFallback =
    Boolean(currentNote && currentNote.uuid === record.noteUuid) &&
    Boolean(currentNote && assistantNoteSnapshotMatches(currentNote, record.undo.after)) &&
    editorText === record.undo.after.text
  editor.getEditorState().read(() => {
    const nodes = collectNodeRecords()
    for (const operation of record.operations) {
      if (operation.deleted) {
        continue
      }
      for (const locator of operation.affected) {
        const node = resolveLocator(nodes, locator, allowUnstableFallback)
        if (node && node.getKey() !== 'root') {
          keys.add(node.getKey())
        }
      }
    }
  })
  return [...keys]
}

export function getAssistantChangeElements(
  editor: LexicalEditor,
  record: AssistantChangeRecord,
  currentNote?: SNNote,
): HTMLElement[] {
  return resolveAssistantChangeNodeKeys(editor, record, currentNote)
    .map((key) => editor.getElementByKey(key))
    .filter((element): element is HTMLElement => Boolean(element))
}

/**
 * Scroll an existing block into view. Deleted blocks deliberately do not get a
 * synthetic replacement; their before state remains available in the diff.
 */
export function assistantChangeScrollBehavior(): ScrollBehavior {
  return typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
}

export function jumpToAssistantChange(
  editor: LexicalEditor,
  record: AssistantChangeRecord,
  currentNote?: SNNote,
): boolean {
  const target = getAssistantChangeElements(editor, record, currentNote)[0]
  if (!target) {
    return false
  }
  target.scrollIntoView({ behavior: assistantChangeScrollBehavior(), block: 'center', inline: 'nearest' })
  target.classList.add('assistant-change-jump-target')
  globalThis.setTimeout(() => target.classList.remove('assistant-change-jump-target'), 1_600)
  editor.focus()
  return true
}

function activeRecentRecord(records: AssistantChangeRecord[], now: number): AssistantChangeRecord | undefined {
  return records.find(
    (record) =>
      record.status === 'applied' &&
      now - Date.parse(record.createdAt) >= 0 &&
      now - Date.parse(record.createdAt) <= ASSISTANT_CHANGE_RECENCY_MS,
  )
}

export function AssistantChangeDecorationsPlugin({ noteUuid }: { noteUuid: string }) {
  const [editor] = useLexicalComposerContext()
  const { note, records } = useAssistantChangeLedger(noteUuid)
  const [announcement, setAnnouncement] = useState('')
  const announcedChangeRef = useRef<string | undefined>(undefined)
  const record = useMemo(() => activeRecentRecord(records, Date.now()), [records])

  useEffect(() => {
    if (!record) {
      return
    }

    const decorated = new Set<HTMLElement>()
    let active = true
    let unregisterUpdate: (() => void) | undefined
    const stopUpdates = (): void => {
      active = false
      unregisterUpdate?.()
      unregisterUpdate = undefined
    }
    const clearDecorations = (): void => {
      for (const element of decorated) {
        if (element.dataset.assistantChangeId !== record.changeId) {
          continue
        }
        delete element.dataset.assistantChangeId
        delete element.dataset.assistantChangeMarker
        element.classList.remove('assistant-change-highlight')
      }
      decorated.clear()
    }
    const decorate = (): void => {
      if (!active) {
        return
      }
      for (const element of getAssistantChangeElements(editor, record, note)) {
        if (element.dataset.assistantChangeId === record.changeId) {
          continue
        }
        element.dataset.assistantChangeId = record.changeId
        element.dataset.assistantChangeMarker = 'AI changed'
        element.classList.add('assistant-change-highlight')
        decorated.add(element)
      }
      if (decorated.size > 0 && announcedChangeRef.current !== record.changeId) {
        announcedChangeRef.current = record.changeId
        setAnnouncement(`AI changed ${decorated.size} ${decorated.size === 1 ? 'block' : 'blocks'} in this note.`)
      }
    }

    decorate()
    unregisterUpdate = editor.registerUpdateListener(decorate)
    const retryTimer = globalThis.setTimeout(decorate, 0)
    const clearTimer = globalThis.setTimeout(() => {
      stopUpdates()
      clearDecorations()
    }, ASSISTANT_CHANGE_DECORATION_MS)

    return () => {
      stopUpdates()
      globalThis.clearTimeout(retryTimer)
      globalThis.clearTimeout(clearTimer)
      clearDecorations()
    }
  }, [editor, note, record])

  return (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </span>
  )
}
