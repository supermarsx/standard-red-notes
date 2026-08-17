import { DEFAULT_SAMPLING_SETTINGS, getMaxRunTimeMs } from './samplingSettings'
import {
  AssistantToolCall,
  ChatMessage,
  Provider,
  ProviderReplayState,
  ProviderStopReason,
  ToolDescriptor,
  ToolExecutionOutcome,
  ToolSession,
} from './types'

/** Live controls for an in-flight assistant run. */
export interface AgentControl {
  /** Drain guidance queued since the previous model boundary. */
  drainSteers(): string[]
}

export interface AgentOptions {
  provider: Provider
  session: ToolSession
  /** Step cap; 0 means unlimited. Defaults to the user's bounded setting. */
  maxSteps?: number
  /** Wall-clock limit in milliseconds. 0/undefined uses the configured limit. */
  maxRunTimeMs?: number
  systemPrompt: string
  signal?: AbortSignal
  control?: AgentControl
  onTextDelta?: (chunk: string) => void
  onToolCall?: (call: AssistantToolCall) => void
  onToolResult?: (callId: string, result: string, outcome: ToolExecutionOutcome) => void
  onAssistantMessage?: (text: string) => void
  onSteer?: (text: string) => void
}

export interface AgentResult {
  finalText: string
  steps: number
  stopReason: 'end_turn' | 'max_tokens' | 'max_steps' | 'time_limit' | 'error' | 'aborted'
}

const RUN_CANCELLED = Symbol('assistant-run-cancelled')

function isDeniedToolResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'cancelled' in result &&
    (result as { cancelled?: unknown }).cancelled === true
  )
}

interface RunCancellation {
  signal: AbortSignal
  checkDeadline(): void
  deadlineReached(): boolean
  dispose(): void
}

/** Combine the caller's Stop signal with a real wall-clock deadline. */
function createRunCancellation(userSignal: AbortSignal | undefined, maxRunTimeMs: number): RunCancellation {
  const controller = new AbortController()
  let didReachDeadline = false
  const deadlineAt = maxRunTimeMs > 0 ? Date.now() + maxRunTimeMs : undefined

  const abortFromUser = () => {
    if (!controller.signal.aborted) {
      controller.abort(userSignal?.reason)
    }
  }
  if (userSignal?.aborted) {
    abortFromUser()
  } else {
    userSignal?.addEventListener('abort', abortFromUser, { once: true })
  }

  const abortForDeadline = () => {
    if (!controller.signal.aborted) {
      didReachDeadline = true
      const error = new Error('Assistant run-time limit reached.')
      error.name = 'TimeoutError'
      controller.abort(error)
    }
  }
  const deadlineTimer = maxRunTimeMs > 0 ? setTimeout(abortForDeadline, maxRunTimeMs) : undefined

  return {
    signal: controller.signal,
    checkDeadline: () => {
      // Browsers can heavily throttle timers in background tabs. Date.now is
      // checked whenever execution resumes so a delayed timer cannot authorize
      // another provider call or tool after the original wall-clock deadline.
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        abortForDeadline()
      }
    },
    deadlineReached: () => didReachDeadline,
    dispose: () => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer)
      }
      userSignal?.removeEventListener('abort', abortFromUser)
    },
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw RUN_CANCELLED
  }
}

/** Race an await against Stop/deadline while handling the original promise. */
function awaitWithCancellation<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(RUN_CANCELLED)
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(RUN_CANCELLED)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then(
      (result) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(result)
      },
      (error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

/** Stop awaiting a stalled provider stream when cancellation/deadline fires. */
async function* providerEventsWithCancellation<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  checkBoundary: () => void,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]()
  let completed = false
  try {
    while (true) {
      checkBoundary()
      const next = await awaitWithCancellation(iterator.next(), signal)
      checkBoundary()
      if (next.done) {
        completed = true
        return
      }
      yield next.value
    }
  } finally {
    if (!completed && iterator.return) {
      // Async-generator return can wait for an in-flight network read. Request
      // cleanup without allowing that read to defeat the cancellation bound.
      try {
        void Promise.resolve(iterator.return()).catch(() => undefined)
      } catch {
        // Best-effort transport cleanup; the run is already cancelled.
      }
    }
  }
}

export async function run(messages: ChatMessage[], opts: AgentOptions): Promise<AgentResult> {
  const { provider, session } = opts
  // Account-scoped runtime settings are resolved by the application-facing
  // caller. The generic agent has no principal, so its fallback must never read
  // another account's device-local settings.
  const maxSteps = opts.maxSteps ?? DEFAULT_SAMPLING_SETTINGS.maxSteps
  const unlimitedSteps = maxSteps <= 0
  const maxRunTimeMs =
    opts.maxRunTimeMs && opts.maxRunTimeMs > 0 ? opts.maxRunTimeMs : getMaxRunTimeMs(DEFAULT_SAMPLING_SETTINGS)
  const cancellation = createRunCancellation(opts.signal, maxRunTimeMs)
  const systemPrompt = opts.systemPrompt
  const history: ChatMessage[] = [...messages]
  let finalText = ''
  let activeAssistantText = ''
  let currentStep = 0

  const drainSteers = (): string[] => {
    const steers = opts.control?.drainSteers() ?? []
    return steers.filter((steer) => steer.trim().length > 0)
  }
  const appendSteers = (steers: string[]): void => {
    for (const steer of steers) {
      history.push({ role: 'user', content: steer })
      opts.onSteer?.(steer)
    }
  }
  const injectSteers = (): number => {
    const steers = drainSteers()
    appendSteers(steers)
    return steers.length
  }
  const checkBoundary = (): void => {
    cancellation.checkDeadline()
    throwIfCancelled(cancellation.signal)
  }

  try {
    checkBoundary()
    const abortAwareSession = session as ToolSession & { setAbortSignal?: (signal: AbortSignal) => void }
    abortAwareSession.setAbortSignal?.(cancellation.signal)
    checkBoundary()
    const tools = describeTools(session.tools())
    checkBoundary()

    for (let step = 1; ; step++) {
      checkBoundary()
      if (!unlimitedSteps && step > maxSteps) {
        break
      }
      currentStep = step

      injectSteers()
      checkBoundary()

      let assistantText = ''
      activeAssistantText = ''
      const toolCalls: AssistantToolCall[] = []
      let stopReason: ProviderStopReason | undefined
      let providerReplay: ProviderReplayState | undefined

      checkBoundary()
      const stream = provider.send({ system: systemPrompt, messages: history, tools, signal: cancellation.signal })
      checkBoundary()
      for await (const event of providerEventsWithCancellation(stream, cancellation.signal, checkBoundary)) {
        checkBoundary()
        if (event.kind === 'text-delta') {
          assistantText += event.delta
          activeAssistantText = assistantText
          opts.onTextDelta?.(event.delta)
        } else if (event.kind === 'tool-call') {
          toolCalls.push({ id: event.id, name: event.name, args: event.args })
        } else if (event.kind === 'finish') {
          stopReason = event.stopReason
          providerReplay = event.providerReplay
        } else if (event.kind === 'error') {
          return { finalText: event.message, steps: step, stopReason: 'error' }
        }
      }

      if (!stopReason) {
        return {
          finalText: 'The assistant provider ended before reporting a completion reason.',
          steps: step,
          stopReason: 'error',
        }
      }

      if (assistantText) {
        opts.onAssistantMessage?.(assistantText)
      }

      if (toolCalls.length === 0) {
        if (stopReason === 'tool_use') {
          return {
            finalText:
              'The assistant provider completed a tool-use turn without returning a tool call. No tools were run.',
            steps: step,
            stopReason: 'error',
          }
        }
        if (stopReason === 'error') {
          return {
            finalText: assistantText || 'The assistant provider ended with an error.',
            steps: step,
            stopReason: 'error',
          }
        }

        finalText = assistantText
        // Capture a steer that arrived during the terminal stream. Preserve the
        // completed assistant turn before the steer, then continue this run.
        const lateSteers = drainSteers()
        if (lateSteers.length > 0) {
          if (assistantText) {
            history.push({ role: 'assistant', content: assistantText })
          }
          appendSteers(lateSteers)
          checkBoundary()
          continue
        }

        return { finalText, steps: step, stopReason: stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn' }
      }

      // Never execute a partial/incomplete model tool-use turn.
      if (stopReason !== 'tool_use') {
        return {
          finalText:
            'The assistant provider returned tool calls without completing a tool-use turn. No tools were run.',
          steps: step,
          stopReason: 'error',
        }
      }

      // A correction received before tool execution supersedes this proposed
      // tool turn. Preserve only the assistant's readable plan; replaying the
      // stale tool calls would either execute against the user's correction or
      // leave an invalid assistant-tool history pair.
      const supersedingSteers = drainSteers()
      if (supersedingSteers.length > 0) {
        if (assistantText) {
          history.push({ role: 'assistant', content: assistantText })
        }
        appendSteers(supersedingSteers)
        checkBoundary()
        continue
      }

      history.push({
        role: 'assistant',
        content: assistantText,
        toolCalls,
        ...(providerReplay ? { providerReplay } : {}),
      })

      let steeredAfterTool = false
      for (const [toolIndex, toolCall] of toolCalls.entries()) {
        // Stop is a hard boundary: no callback or later tool starts after it,
        // including when it arrives while the preceding tool is awaiting.
        checkBoundary()
        opts.onToolCall?.(toolCall)
        checkBoundary()
        try {
          checkBoundary()
          // ToolSession operations can include non-cancellable local mutations.
          // Do not detach them on abort: wait for settlement, then enforce the
          // boundary so no mutation keeps running after the agent reports that
          // the run has stopped.
          const result = await session.call(toolCall.name, toolCall.args, toolCall.id)
          const serialized = typeof result === 'string' ? result : JSON.stringify(result)
          history.push({ role: 'tool', content: serialized, toolCallId: toolCall.id, name: toolCall.name })
          opts.onToolResult?.(toolCall.id, serialized, isDeniedToolResult(result) ? 'denied' : 'succeeded')
          // A non-cancellable local mutation may have committed while Stop was
          // requested. Report that settled result truthfully before stopping;
          // the boundary still prevents every later tool/provider action.
          checkBoundary()
        } catch (error) {
          if (error === RUN_CANCELLED || cancellation.signal.aborted) {
            throw RUN_CANCELLED
          }
          const message = `error: ${error instanceof Error ? error.message : String(error)}`
          history.push({ role: 'tool', content: message, toolCallId: toolCall.id, name: toolCall.name })
          opts.onToolResult?.(toolCall.id, message, 'failed')
        }
        checkBoundary()
        const betweenToolSteers = drainSteers()
        if (betweenToolSteers.length > 0) {
          for (const skippedCall of toolCalls.slice(toolIndex + 1)) {
            const skipped = JSON.stringify({
              ok: false,
              cancelled: true,
              message: 'Superseded by newer user guidance before execution.',
            })
            opts.onToolCall?.(skippedCall)
            history.push({
              role: 'tool',
              content: skipped,
              toolCallId: skippedCall.id,
              name: skippedCall.name,
            })
            opts.onToolResult?.(skippedCall.id, skipped, 'denied')
          }
          appendSteers(betweenToolSteers)
          steeredAfterTool = true
          break
        }
      }
      if (steeredAfterTool) {
        checkBoundary()
        continue
      }
    }

    // The normal step cap gets one tool-less summary, still within the same
    // cancellation/deadline boundary.
    injectSteers()
    checkBoundary()
    activeAssistantText = ''
    const summaryStream = provider.send({
      system: systemPrompt + '\n\nYou have reached the step cap. Answer with what you have.',
      messages: history,
      tools: [],
      signal: cancellation.signal,
    })
    checkBoundary()
    for await (const event of providerEventsWithCancellation(summaryStream, cancellation.signal, checkBoundary)) {
      checkBoundary()
      if (event.kind === 'text-delta') {
        activeAssistantText += event.delta
        opts.onTextDelta?.(event.delta)
      }
    }
    finalText = activeAssistantText || finalText
    if (activeAssistantText) {
      opts.onAssistantMessage?.(activeAssistantText)
    }
    return { finalText, steps: currentStep, stopReason: 'max_steps' }
  } catch (error) {
    if (error !== RUN_CANCELLED && !cancellation.signal.aborted) {
      throw error
    }
    const stopReason = cancellation.deadlineReached() ? 'time_limit' : 'aborted'
    const fallback = stopReason === 'time_limit' ? 'The assistant stopped after reaching the run-time limit.' : ''
    return {
      finalText: activeAssistantText || finalText || fallback,
      steps: currentStep || 1,
      stopReason,
    }
  } finally {
    cancellation.dispose()
    // A steer typed against a run that just ended must never become an
    // instruction in the next, unrelated request.
    try {
      opts.control?.drainSteers()
    } catch {
      // Control cleanup must not replace the run result.
    }
  }
}

function describeTools(entries: ReturnType<ToolSession['tools']>): ToolDescriptor[] {
  return entries.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}
