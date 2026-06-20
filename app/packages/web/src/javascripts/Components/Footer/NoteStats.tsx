import { WebApplication } from '@/Application/WebApplication'
import { FunctionComponent } from 'react'
import { useNoteStats } from '@/Hooks/useNoteStats'

type Props = {
  application: WebApplication
}

const formatCount = (value: number): string => value.toLocaleString()

const NoteStats: FunctionComponent<Props> = ({ application }) => {
  const stats = useNoteStats(application)

  if (!stats) {
    return null
  }

  const tooltip = [
    `${formatCount(stats.characters)} characters`,
    `${formatCount(stats.charactersNoSpaces)} characters (no spaces)`,
    `${formatCount(stats.words)} words`,
    `${formatCount(stats.lines)} lines`,
    `${formatCount(stats.paragraphs)} paragraphs`,
  ].join('\n')

  const compact = `${formatCount(stats.words)} words · ${formatCount(stats.characters)} chars · ${formatCount(
    stats.lines,
  )} lines`

  return (
    <div
      title={tooltip}
      className="flex select-none items-center whitespace-nowrap text-xs font-bold text-neutral"
      role="status"
      aria-label={`${stats.words} words, ${stats.characters} characters, ${stats.lines} lines, ${stats.paragraphs} paragraphs`}
    >
      {/* Narrow widths: only the word count. Wider widths: full compact line. */}
      <span className="lg:hidden">{formatCount(stats.words)} words</span>
      <span className="hidden lg:inline">{compact}</span>
    </div>
  )
}

export default NoteStats
