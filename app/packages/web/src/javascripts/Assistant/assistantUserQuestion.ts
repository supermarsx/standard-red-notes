export type AssistantUserQuestion = { question: string; options: [string, string, string] }
export type AssistantUserAnswer = { answer: string; optionIndex?: number }
export const MAX_ASSISTANT_USER_ANSWER_LENGTH = 2000

export function normalizeAssistantUserQuestion(value: unknown): AssistantUserQuestion | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Partial<AssistantUserQuestion>
  if (
    typeof raw.question !== 'string' ||
    !raw.question.trim() ||
    raw.question.length > 1000 ||
    !Array.isArray(raw.options) ||
    raw.options.length !== 3 ||
    raw.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 200)
  ) {
    return undefined
  }
  const options = raw.options.map((option) => option.trim()) as [string, string, string]
  if (new Set(options.map((option) => option.toLowerCase())).size !== 3) {
    return undefined
  }
  return { question: raw.question.trim(), options }
}
