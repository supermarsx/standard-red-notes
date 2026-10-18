import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_ASSISTANT_USER_ANSWER_LENGTH,
  normalizeAssistantUserQuestion,
  type AssistantUserQuestion,
  type AssistantUserAnswer,
} from '@/Assistant/assistantUserQuestion'

export function useAssistantUserQuestion(identity: string) {
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const mounted = useRef(true)
  const resolver = useRef<((answer: AssistantUserAnswer | null) => void) | null>(null)
  const activeToken = useRef<number | undefined>(undefined)
  const sequence = useRef(0)
  const [pending, setPending] = useState<{ identity: string; question: AssistantUserQuestion; token: number }>()
  const request = useCallback(
    (value: AssistantUserQuestion, signal?: AbortSignal): Promise<AssistantUserAnswer | null> => {
      const question = normalizeAssistantUserQuestion(value)
      if (!question || !mounted.current || signal?.aborted || currentIdentity.current !== identity) {
        return Promise.resolve(null)
      }
      resolver.current?.(null)
      return new Promise((resolve) => {
        let settled = false
        const finish = (answer: AssistantUserAnswer | null) => {
          if (settled) {
            return
          }
          settled = true
          signal?.removeEventListener('abort', abort)
          if (resolver.current === finish) {
            resolver.current = null
            activeToken.current = undefined
            if (mounted.current) {
              setPending(undefined)
            }
          }
          resolve(currentIdentity.current === identity && !signal?.aborted ? answer : null)
        }
        const abort = () => finish(null)
        resolver.current = finish
        const token = ++sequence.current
        activeToken.current = token
        setPending({ identity, question, token })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) {
          abort()
        }
      })
    },
    [identity],
  )
  const answer = useCallback(
    (value: AssistantUserAnswer | null) => {
      if (!pending || pending.identity !== currentIdentity.current || pending.token !== activeToken.current) {
        return
      }
      if (value) {
        const text = value.answer.trim()
        if (!text || text.length > MAX_ASSISTANT_USER_ANSWER_LENGTH) {
          return
        }
        if (
          value.optionIndex !== undefined &&
          (!Number.isInteger(value.optionIndex) || pending.question.options[value.optionIndex] !== text)
        ) {
          return
        }
        resolver.current?.({ ...value, answer: text })
      } else {
        resolver.current?.(null)
      }
    },
    [pending],
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      resolver.current?.(null)
    }
  }, [identity])
  return { request, answer, pending: pending?.identity === identity ? pending : undefined }
}
