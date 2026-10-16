/** An explicit permission/policy refusal, distinct from a retryable tool failure. */
export class AssistantActionNotAllowedError extends Error {
  readonly code = 'ASSISTANT_ACTION_NOT_ALLOWED'
  constructor(message: string) {
    super(message)
    this.name = 'AssistantActionNotAllowedError'
  }
}

export function isAssistantActionNotAllowedError(error: unknown): error is AssistantActionNotAllowedError {
  return error instanceof AssistantActionNotAllowedError
}
