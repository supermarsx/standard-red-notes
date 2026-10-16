import type { WebApplication } from '@/Application/WebApplication'
export type AssistantChatRunProof = { chatId: string; requestId: string; leaseId: string; fence: number }
export type AssistantChatRunGuard = { proof: AssistantChatRunProof; isCurrent(): boolean; release(): Promise<void> }

/** Server authority is required across devices; a socket reconnect never replays a model run. */
export async function acquireAssistantChatRun(
  application: WebApplication,
  chatId: string,
  controller: AbortController,
): Promise<AssistantChatRunGuard> {
  const account = application.sessions.getUser()?.uuid
  const requestId = crypto.randomUUID()
  const request = <T>(operation: string, body: unknown, signal?: AbortSignal) =>
    application.serverJsonRequest<T>(`/v1/assistant/chats/run-lease/${operation}`, body, signal)
  const result = await request<{ acquired?: boolean; leaseId?: string; fence?: number; expiresAt?: number }>(
    'acquire',
    { chatId, requestId },
    controller.signal,
  )
  const data = result.data ?? {}
  if (
    !result.ok ||
    !data.acquired ||
    typeof data.leaseId !== 'string' ||
    !Number.isSafeInteger(data.fence) ||
    data.fence! < 1 ||
    typeof data.expiresAt !== 'number' ||
    !Number.isFinite(data.expiresAt) ||
    data.expiresAt <= Date.now()
  ) {
    throw new Error(
      data.acquired === false
        ? 'This chat is already generating on another device. Wait for that response before sending.'
        : 'The server could not reserve this chat safely. Try again when the connection is available.',
    )
  }
  const proof: AssistantChatRunProof = { chatId, requestId, leaseId: data.leaseId, fence: data.fence! }
  let expiresAt = data.expiresAt,
    released = false,
    renewing = false,
    timer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const isCurrent = () =>
    !released &&
    !controller.signal.aborted &&
    application.sessions.getUser()?.uuid === account &&
    Date.now() < expiresAt - 500
  const lose = () => {
    released = true
    clearTimeout(timer)
    clearTimeout(expiryTimer)
    controller.abort(new Error('Chat run ownership expired. The response stopped safely; it will not be replayed.'))
  }
  const armExpiry = () => {
    clearTimeout(expiryTimer)
    expiryTimer = setTimeout(lose, Math.max(1, expiresAt - Date.now() - 500))
  }
  const renew = async () => {
    if (!isCurrent()) {
      lose()
      return
    }
    if (renewing) {
      return
    }
    renewing = true
    try {
      const response = await request<{ renewed?: boolean; expiresAt?: number }>('renew', proof, controller.signal)
      if (
        !response.ok ||
        !response.data.renewed ||
        typeof response.data.expiresAt !== 'number' ||
        response.data.expiresAt <= Date.now()
      ) {
        lose()
        return
      }
      expiresAt = response.data.expiresAt
      armExpiry()
      if (!isCurrent()) {
        lose()
        return
      }
      timer = setTimeout(() => void renew(), Math.min(10000, Math.max(1, expiresAt - Date.now() - 1000)))
    } catch {
      lose()
    } finally {
      renewing = false
    }
  }
  const stop = () => {
    clearTimeout(timer)
    clearTimeout(expiryTimer)
  }
  controller.signal.addEventListener('abort', stop, { once: true })
  armExpiry()
  timer = setTimeout(() => void renew(), Math.min(10000, Math.max(1, expiresAt - Date.now() - 1000)))
  return {
    proof,
    isCurrent,
    release: async () => {
      released = true
      clearTimeout(timer)
      clearTimeout(expiryTimer)
      controller.signal.removeEventListener('abort', stop)
      if (application.sessions.getUser()?.uuid !== account) {
        return
      }
      const releaseController = new AbortController()
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          request('release', proof, releaseController.signal),
          new Promise<void>((resolve) => {
            deadline = setTimeout(() => {
              releaseController.abort()
              resolve()
            }, 5000)
          }),
        ])
      } catch {
        /* Redis expiry safely releases an unreachable lease. */
      } finally {
        clearTimeout(deadline)
      }
    },
  }
}
