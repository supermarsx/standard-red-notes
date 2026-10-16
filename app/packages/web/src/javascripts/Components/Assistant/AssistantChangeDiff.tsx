import { memo, useState } from 'react'
import { classNames } from '@standardnotes/utils'

/** Collapsed changes must not allocate a DOM row for every line of a large note. */
export default memo(function AssistantChangeDiff({ patch, noteTitle }: { patch: string; noteTitle: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="text-passive-0 cursor-pointer select-none">Git-style diff</summary>
      {expanded && (
        <pre
          className="border-border bg-default mt-1 max-h-72 overflow-auto rounded border p-2 font-mono text-[11px] leading-4"
          aria-label={`Changes made to ${noteTitle}`}
        >
          {patch.split('\n').map((line, index) => (
            <span
              key={`${index}-${line.slice(0, 16)}`}
              className={classNames(
                'block min-w-max whitespace-pre',
                line.startsWith('+') && !line.startsWith('+++') && 'bg-success/10 text-success',
                line.startsWith('-') && !line.startsWith('---') && 'bg-danger/10 text-danger',
                line.startsWith('@@') && 'text-info',
                (line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++')) &&
                  'text-passive-0 font-semibold',
              )}
            >
              {line || ' '}
            </span>
          ))}
        </pre>
      )}
    </details>
  )
})
