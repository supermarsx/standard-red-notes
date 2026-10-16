import type { AssistantImageAttachment } from './attachments'
import type { WebApplication } from '@/Application/WebApplication'
import { run, AgentOptions, AgentResult } from './agent'
import type { AssistantConversationMode } from './conversationModes'
import type { ChatMessage, ToolSession } from './types'
import { runResearchMode } from './researchMode'
import { DEEP_RESEARCH_REFINE_SYSTEM_PROMPT, runDeepResearch } from './deepResearch'
import { gatherResearchWebEvidence, ResearchWebEvidence } from './researchWebEvidence'
import { DEFAULT_SAMPLING_SETTINGS, getMaxRunTimeMs } from './samplingSettings'
import { wrapUntrustedNoteContext } from './prompts'

export interface ConversationModeExtras {
  application: WebApplication
  /** User-authored instruction only. Never a directive prompt containing a private excerpt. */
  prompt: string
  /** Already scoped and authorized context; this runner never reads the note library. */
  contextText: string
  images?: AssistantImageAttachment[]
  isCurrent: () => boolean
  /** Must use the chat approval path, including remembered tool denials. Absence disables web. */
  requestWebConfirmation?: (action: 'search' | 'fetch', value: string) => Promise<boolean>
}

type AbortAwareSession = ToolSession & { setAbortSignal?: (signal: AbortSignal) => void }
class ModeOutputLimit extends Error {
  constructor(readonly partial: string) {
    super('The model reached its output limit. This report is incomplete.')
  }
}
class ModeBoundary extends Error {
  constructor(readonly stopReason: 'aborted' | 'time_limit' | 'max_steps') {
    super(
      stopReason === 'time_limit'
        ? 'Research stopped after reaching the run-time limit.'
        : stopReason === 'max_steps'
          ? 'Research stopped after reaching the model-call limit.'
          : 'Research was stopped.',
    )
  }
}

function restrictSession(session: ToolSession, mode: 'chat' | 'plan', isCurrent: () => boolean): AbortAwareSession {
  const available = () => (mode === 'chat' ? [] : session.tools().filter((tool) => !tool.mutating))
  return {
    tools: available,
    setAbortSignal: (signal) => (session as AbortAwareSession).setAbortSignal?.(signal),
    async call(name, args, callId) {
      if (!isCurrent() || !available().some((tool) => tool.name === name)) {
        return { cancelled: true, reason: `This tool is not available in ${mode} mode.` }
      }
      return session.call(name, args, callId)
    },
  }
}

/** Mode restrictions are execution guards, independent of model instructions or approval policy. */
export async function runConversationMode(
  mode: AssistantConversationMode,
  history: ChatMessage[],
  options: AgentOptions,
  extras: ConversationModeExtras,
): Promise<AgentResult> {
  if (mode === 'agent' || mode === 'chat' || mode === 'plan') {
    return run(history, {
      ...options,
      session: mode === 'agent' ? options.session : restrictSession(options.session, mode, extras.isCurrent),
      systemPrompt:
        mode === 'plan'
          ? `${options.systemPrompt}\n\nPlan the work and explain proposed changes. Do not make changes.`
          : options.systemPrompt,
    })
  }

  const controller = new AbortController()
  const configuredTime = options.maxRunTimeMs
  const budgetMs =
    typeof configuredTime === 'number' && Number.isFinite(configuredTime) && configuredTime > 0
      ? configuredTime
      : getMaxRunTimeMs(DEFAULT_SAMPLING_SETTINGS)
  const deadlineAt = Date.now() + budgetMs
  const maxCalls =
    Number.isFinite(options.maxSteps) && (options.maxSteps ?? 0) > 0
      ? Math.max(1, Math.min(6, Math.floor(options.maxSteps!)))
      : 6
  let calls = 0
  let partialFinal = ''
  let deadlineReached = false
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) {
    abortFromCaller()
  } else {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timer = setTimeout(() => {
    deadlineReached = true
    controller.abort()
  }, budgetMs)
  ;(options.session as AbortAwareSession).setAbortSignal?.(controller.signal)
  const check = () => {
    if (Date.now() >= deadlineAt) {
      deadlineReached = true
      controller.abort()
    }
    if (deadlineReached) {
      throw new ModeBoundary('time_limit')
    }
    if (controller.signal.aborted || !extras.isCurrent()) {
      throw new ModeBoundary('aborted')
    }
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    check()
    let removeAbort = () => {}
    const aborted = new Promise<never>((_, reject) => {
      const rejectAbort = () => reject(new ModeBoundary(deadlineReached ? 'time_limit' : 'aborted'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
      removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort)
    })
    try {
      const result = await Promise.race([Promise.resolve().then(work), aborted])
      check()
      return result
    } finally {
      removeAbort()
    }
  }

  const complete = async (system: string, user: string): Promise<string> => {
    check()
    if (calls >= maxCalls) {
      throw new ModeBoundary('max_steps')
    }
    calls += 1
    const steers = options.control?.drainSteers().filter((value) => value.trim()) ?? []
    steers.forEach((value) => options.onSteer?.(value))
    const iterator = options.provider
      .send({
        system,
        messages: [
          { role: 'user', content: user, ...(extras.images?.length ? { images: extras.images } : {}) },
          ...steers.map((content) => ({ role: 'user' as const, content })),
        ],
        tools: [],
        signal: controller.signal,
      })
      [Symbol.asyncIterator]()
    let text = ''
    let finished = false
    let outputLimited = false
    let completed = false
    const finalPhase = system !== DEEP_RESEARCH_REFINE_SYSTEM_PROMPT
    try {
      for (;;) {
        const next = await guarded(() => iterator.next())
        if (next.done) {
          completed = true
          break
        }
        const event = next.value
        if (event.kind === 'text-delta') {
          text += event.delta
          if (text.length > 240_000) {
            throw new Error('Research response exceeded its text limit.')
          }
          if (finalPhase) {
            partialFinal = text
          }
        } else if (event.kind === 'error') {
          throw new Error(event.message)
        } else if (event.kind === 'tool-call') {
          throw new Error('Research returned a tool call instead of a report. No tool was executed.')
        } else if (event.kind === 'finish') {
          if (event.stopReason === 'error' || event.stopReason === 'tool_use') {
            throw new Error('Research did not complete a text response. No tool was executed.')
          }
          outputLimited = event.stopReason === 'max_tokens'
          finished = true
        }
      }
      if (!finished) {
        throw new Error('Research response ended before reporting completion.')
      }
      check()
      if (outputLimited) {
        throw new ModeOutputLimit(text)
      }
      return text
    } finally {
      if (!completed && iterator.return) {
        try {
          void Promise.resolve(iterator.return()).catch(() => undefined)
        } catch {
          /* Cleanup cannot override an authoritative cancellation or failure. */
        }
      }
    }
  }

  try {
    check()
    const hasWebTool = (action: 'search' | 'fetch') =>
      options.session.tools().some((tool) => tool.name === `web.${action}` && !tool.mutating)
    const webEvidence: ResearchWebEvidence =
      extras.requestWebConfirmation && hasWebTool('search')
        ? await guarded(() =>
            gatherResearchWebEvidence(extras.application, extras.prompt, {
              signal: controller.signal,
              isCurrent: () => extras.isCurrent() && !controller.signal.aborted,
              requestConfirmation: async (action, value) => {
                check()
                if (!hasWebTool(action)) {
                  return false
                }
                const approved = await guarded(() => extras.requestWebConfirmation!(action, value))
                check()
                return approved && hasWebTool(action)
              },
            }),
          )
        : { sources: [], status: 'unavailable' }
    const context = extras.contextText.slice(0, 24_000)
    let finalText: string
    if (mode === 'research') {
      const result = await runResearchMode(
        extras.prompt,
        (system, user) =>
          complete(
            system,
            `${user}${context ? `\n\nExplicitly selected private context (not a web search query):\n${wrapUntrustedNoteContext(context)}` : ''}`,
          ),
        { signal: controller.signal, webEvidence },
      )
      check()
      finalText = result?.body ?? 'No research topic was provided.'
    } else {
      const corpus = []
      for (let offset = 0; offset < context.length; offset += 4_000) {
        corpus.push({
          uuid: `scoped-context-${offset / 4_000 + 1}`,
          title: `Selected context excerpt ${offset / 4_000 + 1}`,
          text: context.slice(offset, offset + 4_000),
        })
      }
      const result = await runDeepResearch(extras.prompt, corpus, complete, {
        signal: controller.signal,
        webEvidence,
        limits: {
          maxRounds: Math.max(1, Math.min(4, maxCalls - 1)),
          maxNotes: 6,
          initialNotes: maxCalls === 1 ? 6 : 2,
          snippetChars: 4_000,
        },
        retrieve: (docs, _query, limit) =>
          docs.slice(0, limit).map((doc) => ({ noteUuid: doc.uuid, noteTitle: doc.title })),
      })
      check()
      finalText =
        result.stopReason === 'no-candidates'
          ? 'No readable content was included in the selected context, and no approved web pages were available. Choose context or approve web research to continue.'
          : result.report
      if (result.sources.length) {
        finalText += `\n\n## Selected context sources\n\n${result.sources.map((source, index) => `- [${index + 1}] ${source.title}`).join('\n')}`
      }
    }
    options.onTextDelta?.(finalText)
    options.onAssistantMessage?.(finalText)
    return { finalText, steps: calls, stopReason: 'end_turn' }
  } catch (error) {
    if (error instanceof ModeOutputLimit && extras.isCurrent() && !controller.signal.aborted) {
      const finalText = `${error.partial}\n\n> ${error.message}`
      options.onTextDelta?.(finalText)
      options.onAssistantMessage?.(finalText)
      return { finalText, steps: calls, stopReason: 'max_tokens' }
    }
    const failure =
      !(error instanceof ModeBoundary) && (controller.signal.aborted || !extras.isCurrent())
        ? new ModeBoundary(deadlineReached ? 'time_limit' : 'aborted')
        : error
    if (failure instanceof ModeBoundary) {
      const finalText = partialFinal
        ? `${partialFinal}\n\n> ${failure.message} This report is incomplete.`
        : failure.message
      if (extras.isCurrent()) {
        options.onTextDelta?.(finalText)
      }
      return { finalText, steps: calls, stopReason: failure.stopReason }
    }
    if (partialFinal && extras.isCurrent()) {
      options.onTextDelta?.(partialFinal)
    }
    return {
      finalText: failure instanceof Error ? failure.message : 'Research failed.',
      steps: calls,
      stopReason: 'error',
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}
