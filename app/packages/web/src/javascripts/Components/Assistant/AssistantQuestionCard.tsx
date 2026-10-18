import { useState } from 'react'
import {
  MAX_ASSISTANT_USER_ANSWER_LENGTH,
  type AssistantUserQuestion,
  type AssistantUserAnswer,
} from '@/Assistant/assistantUserQuestion'

export default function AssistantQuestionCard({
  question,
  onAnswer,
}: {
  question: AssistantUserQuestion
  onAnswer: (answer: AssistantUserAnswer | null) => void
}) {
  const [custom, setCustom] = useState('')
  const buttonClass =
    'border-border bg-default text-text hover:bg-contrast focus-visible:ring-info min-w-0 max-w-full break-words rounded border px-2 py-1 text-xs focus-visible:ring-2 disabled:opacity-50'
  return (
    <fieldset className="border-border bg-contrast min-w-0 rounded border p-2 text-xs">
      <legend className="text-text px-1 font-medium">A quick question</legend>
      <p className="text-text mb-2 whitespace-pre-wrap">{question.question}</p>
      <div className="flex flex-wrap gap-1">
        {question.options.map((option, optionIndex) => (
          <button
            type="button"
            className={buttonClass}
            key={optionIndex}
            onClick={() => onAnswer({ answer: option, optionIndex })}
          >
            {option}
          </button>
        ))}
      </div>
      <label className="text-text mt-2 block">
        Your own answer
        <textarea
          aria-label="Your own answer"
          rows={2}
          maxLength={MAX_ASSISTANT_USER_ANSWER_LENGTH}
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          className="border-border bg-default text-text mt-1 w-full max-w-full min-w-0 resize-y rounded border px-2 py-1 text-xs break-words"
        />
      </label>
      <div className="mt-1 flex justify-end gap-1">
        <button type="button" className={buttonClass} onClick={() => onAnswer(null)}>
          Cancel
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!custom.trim()}
          onClick={() => onAnswer({ answer: custom.trim() })}
        >
          Send answer
        </button>
      </div>
    </fieldset>
  )
}
