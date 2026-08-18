import {
  applyAssistantSuperPatch,
  AssistantBlockLocator,
  AssistantStructuralPatchOperation,
  AssistantStructureBlock,
  AssistantStructureOutlineEntry,
  AssistantStructureRead,
  AssistantSuperPatchRequest,
  AssistantSuperPatchResult,
  readAssistantSuperStructure,
} from './assistantSuperNotePatch'

export type AssistantLiveSuperSnapshot = {
  /** Exact serialized Lexical state captured from the mounted editor. */
  text: string
  /** Runtime Lexical node key -> serialized child path for this exact snapshot. */
  pathsByNodeKey: ReadonlyMap<string, readonly number[]>
}

export type AssistantLiveSuperReadOptions = {
  view: 'outline' | 'section' | 'blocks'
  section?: AssistantBlockLocator
  limit?: number
  updatedAt?: string
}

export interface AssistantSuperNoteLiveBridge {
  read(options: AssistantLiveSuperReadOptions): Promise<AssistantStructureRead>
  preparePatch(
    request: AssistantSuperPatchRequest,
    options?: { updatedAt?: string; createTodoId?: () => string },
  ): Promise<AssistantSuperPatchResult>
}

type RegisteredBridge = {
  id: symbol
  bridge: AssistantSuperNoteLiveBridge
}

/**
 * Mounted interactive Super editors register here by note UUID. The stack keeps
 * StrictMode remounts and overlapping React cleanup safe: an old disposer can
 * never unregister the newer editor lifetime that replaced it.
 */
const liveBridges = new Map<string, RegisteredBridge[]>()

export function registerAssistantSuperNoteLiveBridge(
  noteUuid: string,
  bridge: AssistantSuperNoteLiveBridge,
): () => void {
  const registered = { id: Symbol(noteUuid), bridge }
  const entries = liveBridges.get(noteUuid) ?? []
  liveBridges.set(noteUuid, [...entries, registered])
  return () => {
    const current = liveBridges.get(noteUuid)
    if (!current) {
      return
    }
    const remaining = current.filter((entry) => entry.id !== registered.id)
    if (remaining.length > 0) {
      liveBridges.set(noteUuid, remaining)
    } else {
      liveBridges.delete(noteUuid)
    }
  }
}

export function getAssistantSuperNoteLiveBridge(noteUuid: string): AssistantSuperNoteLiveBridge | undefined {
  return liveBridges.get(noteUuid)?.at(-1)?.bridge
}

function pathIdentity(path: readonly number[]): string {
  return path.join('.')
}

function nodeKeysByPath(snapshot: AssistantLiveSuperSnapshot): Map<string, string> {
  const result = new Map<string, string>()
  for (const [nodeKey, path] of snapshot.pathsByNodeKey) {
    result.set(pathIdentity(path), nodeKey)
  }
  return result
}

function promotePathLocator(
  locator: AssistantBlockLocator,
  keysByPath: ReadonlyMap<string, string>,
): AssistantBlockLocator {
  if (!('path' in locator)) {
    return locator
  }
  const nodeKey = keysByPath.get(pathIdentity(locator.path))
  return nodeKey ? { nodeKey } : locator
}

function promoteOutline(
  outline: AssistantStructureOutlineEntry[],
  keysByPath: ReadonlyMap<string, string>,
): AssistantStructureOutlineEntry[] {
  return outline.map((entry) => ({ ...entry, locator: promotePathLocator(entry.locator, keysByPath) }))
}

function promoteBlocks(
  blocks: AssistantStructureBlock[] | undefined,
  keysByPath: ReadonlyMap<string, string>,
): AssistantStructureBlock[] | undefined {
  return blocks?.map((block) => ({ ...block, locator: promotePathLocator(block.locator, keysByPath) }))
}

function demoteNodeKeyLocator(
  locator: AssistantBlockLocator,
  pathsByNodeKey: ReadonlyMap<string, readonly number[]>,
): AssistantBlockLocator {
  if (!('nodeKey' in locator)) {
    return locator
  }
  const path = pathsByNodeKey.get(locator.nodeKey)
  return path ? { path: [...path] } : locator
}

function translateOperation(
  operation: AssistantStructuralPatchOperation,
  pathsByNodeKey: ReadonlyMap<string, readonly number[]>,
): AssistantStructuralPatchOperation {
  const target = demoteNodeKeyLocator(operation.target, pathsByNodeKey)
  if (operation.type === 'move') {
    return {
      ...operation,
      target,
      destination: {
        ...operation.destination,
        target: demoteNodeKeyLocator(operation.destination.target, pathsByNodeKey),
      },
    }
  }
  return { ...operation, target }
}

/** Project a mounted editor snapshot while preferring its real runtime keys. */
export async function readAssistantLiveSuperStructure(
  snapshot: AssistantLiveSuperSnapshot,
  options: AssistantLiveSuperReadOptions,
): Promise<AssistantStructureRead> {
  const section = options.section ? demoteNodeKeyLocator(options.section, snapshot.pathsByNodeKey) : undefined
  const structure = await readAssistantSuperStructure(snapshot.text, {
    ...options,
    ...(section ? { section } : {}),
  })
  const keysByPath = nodeKeysByPath(snapshot)
  return {
    ...structure,
    outline: promoteOutline(structure.outline, keysByPath),
    ...(structure.blocks ? { blocks: promoteBlocks(structure.blocks, keysByPath) } : {}),
  }
}

/**
 * Resolve runtime node keys against the same mounted-editor snapshot used for
 * the revision check, then run the detached all-or-nothing patcher. The caller
 * persists the returned text through PayloadEmitSource.AssistantChanged, whose
 * SuperEditor observer applies one history-tagged Lexical/Yjs transaction.
 */
export async function prepareAssistantLiveSuperPatch(
  snapshot: AssistantLiveSuperSnapshot,
  request: AssistantSuperPatchRequest,
  options: { updatedAt?: string; createTodoId?: () => string } = {},
): Promise<AssistantSuperPatchResult> {
  const translatedRequest: AssistantSuperPatchRequest = {
    ...request,
    operations: request.operations.map((operation) => translateOperation(operation, snapshot.pathsByNodeKey)),
  }
  const result = await applyAssistantSuperPatch(snapshot.text, translatedRequest, options)
  if (result.ok || result.status === 'refused') {
    return result
  }
  const keysByPath = nodeKeysByPath(snapshot)
  if (result.status === 'conflict') {
    return {
      ...result,
      rebase: { outline: promoteOutline(result.rebase.outline, keysByPath) },
    }
  }
  return {
    ...result,
    ...(result.candidates ? { candidates: promoteBlocks(result.candidates, keysByPath) } : {}),
  }
}
