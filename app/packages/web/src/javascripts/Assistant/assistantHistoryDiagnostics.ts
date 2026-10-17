import { getAssistantChatStorageFailure } from './assistantSyncedChats'

type Failure = ReturnType<typeof getAssistantChatStorageFailure>
export type AssistantHistoryDiagnostics = {
  failures: number
  recoveries: number
  active: boolean
  latest?: Pick<Failure, 'code' | 'stage' | 'cause'>
}

type ScopeLedger = AssistantHistoryDiagnostics & {
  sources: Map<object | string, Pick<Failure, 'code' | 'stage' | 'cause'>>
}
type Ledger = { scopes: Map<string, ScopeLedger>; listeners: Set<() => void> }
const ledgers = new WeakMap<object, Ledger>()
const boundedIncrement = (value: number) => Math.min(1_000_000, value + 1)
function ledgerFor(owner: object): Ledger {
  let ledger = ledgers.get(owner)
  if (!ledger) {
    ledger = { scopes: new Map(), listeners: new Set() }
    ledgers.set(owner, ledger)
  }
  return ledger
}
function notify(ledger: Ledger): void {
  for (const listener of ledger.listeners) {
    try {
      listener()
    } catch {
      /* Diagnostics never affect persistence. */
    }
  }
}

/** Closed codes only. Account scope keys and view-scoped source keys stay internal; no identifiers or raw errors are exported. */
export function reportAssistantHistoryFailure(
  owner: object,
  scope: string | undefined,
  error: unknown,
  source: object | string,
): Failure {
  const failure = getAssistantChatStorageFailure(error)
  if (!scope) {
    return failure
  }
  const ledger = ledgerFor(owner)
  const previous = ledger.scopes.get(scope)
  const sources = previous?.sources ?? new Map<object | string, Pick<Failure, 'code' | 'stage' | 'cause'>>()
  const priorSource = sources.get(source)
  const repeated =
    priorSource?.code === failure.code && priorSource?.stage === failure.stage && priorSource?.cause === failure.cause
  sources.delete(source)
  sources.set(source, { code: failure.code, stage: failure.stage, ...(failure.cause ? { cause: failure.cause } : {}) })
  while (sources.size > 128) {
    sources.delete(sources.keys().next().value!)
  }
  const next = {
    sources,
    failures: boundedIncrement(previous?.failures ?? 0),
    recoveries: previous?.recoveries ?? 0,
    active: true,
    latest: { code: failure.code, stage: failure.stage, ...(failure.cause ? { cause: failure.cause } : {}) },
  }
  ledger.scopes.set(scope, next)
  while (ledger.scopes.size > 16) {
    ledger.scopes.delete(ledger.scopes.keys().next().value!)
  }
  if (!repeated) {
    console.warn(
      `[assistant-history] save-failed stage=${failure.stage} code=${failure.code}${failure.cause ? ` cause=${failure.cause}` : ''}`,
    )
  }
  notify(ledger)
  return failure
}

export function reportAssistantHistoryRecovery(
  owner: object,
  scope: string | undefined,
  source: object | string,
): void {
  if (!scope) {
    return
  }
  const ledger = ledgers.get(owner)
  const previous = ledger?.scopes.get(scope)
  if (!ledger || !previous?.sources.delete(source)) {
    return
  }
  ledger.scopes.set(scope, {
    ...previous,
    active: previous.sources.size > 0,
    latest: previous.sources.size ? [...previous.sources.values()].at(-1) : previous.latest,
    recoveries: boundedIncrement(previous.recoveries),
  })
  // eslint-disable-next-line no-console -- A closed recovery event never carries user content.
  console.info('[assistant-history] save-recovered')
  notify(ledger)
}

export function readAssistantHistoryDiagnostics(owner: object, scope: string | undefined): AssistantHistoryDiagnostics {
  const value = scope ? ledgers.get(owner)?.scopes.get(scope) : undefined
  return value
    ? {
        failures: value.failures,
        recoveries: value.recoveries,
        active: value.active,
        latest: value.latest && { ...value.latest },
      }
    : { failures: 0, recoveries: 0, active: false }
}

export function subscribeAssistantHistoryDiagnostics(owner: object, listener: () => void): () => void {
  const ledger = ledgerFor(owner)
  ledger.listeners.add(listener)
  return () => {
    ledger.listeners.delete(listener)
  }
}
