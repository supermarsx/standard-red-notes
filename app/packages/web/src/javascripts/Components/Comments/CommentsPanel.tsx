import { FunctionComponent, useMemo, useState } from 'react'
import { SNNote } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import { useNoteComments } from '@/Comments/useNoteComments'
import { useMentionCandidates } from '@/Comments/useMentionCandidates'
import { buildCommentThreads, NoteComment } from '@/Comments/comments'
import { segmentCommentText } from '@/Comments/mentions'
import { collaboratorColor, collaboratorInitials } from '@/Components/SuperEditor/Collaboration/collaboratorColor'
import CommentComposer from './CommentComposer'

type Props = {
  note: SNNote
}

function formatTime(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed) || parsed === 0) {
    return ''
  }
  return new Date(parsed).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Render comment text, turning @[name](uuid) tokens into highlighted chips. */
const CommentBody: FunctionComponent<{ text: string }> = ({ text }) => {
  const segments = useMemo(() => segmentCommentText(text), [text])
  return (
    <span className="whitespace-pre-wrap break-words text-sm text-text">
      {segments.map((segment, index) =>
        segment.type === 'mention' ? (
          <span key={index} className="rounded bg-info-backdrop px-1 font-medium text-info">
            @{segment.name}
          </span>
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )}
    </span>
  )
}

const CommentRow: FunctionComponent<{
  comment: NoteComment
  isSelf: boolean
  isReply?: boolean
  onDelete: () => void
  onToggleResolved?: () => void
  onReply?: () => void
}> = ({ comment, isSelf, isReply, onDelete, onToggleResolved, onReply }) => {
  const color = collaboratorColor(comment.authorUuid)
  return (
    <div className={`flex gap-2 ${isReply ? 'ml-6' : ''} ${comment.resolved ? 'opacity-60' : ''}`}>
      <div
        className="mt-0.5 flex h-6 w-6 flex-shrink-0 select-none items-center justify-center rounded-full text-[0.6rem] font-bold text-white"
        style={{ backgroundColor: color }}
        aria-hidden
      >
        {collaboratorInitials(comment.authorName)}
      </div>
      <div className="min-w-0 flex-grow">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-semibold text-text">{isSelf ? 'You' : comment.authorName}</span>
          <span className="text-xs text-passive-2">{formatTime(comment.createdAt)}</span>
          {comment.anchor?.kind === 'super' && (
            <span className="rounded bg-contrast px-1 text-[0.6rem] text-passive-1" title="Inline comment">
              inline
            </span>
          )}
          {comment.resolved && <span className="text-[0.6rem] uppercase text-success">resolved</span>}
        </div>
        {comment.anchor?.snippet && (
          <div className="mt-0.5 border-l-2 border-border pl-2 text-xs italic text-passive-1">
            “{comment.anchor.snippet}”
          </div>
        )}
        <div className="mt-0.5">
          <CommentBody text={comment.text} />
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-passive-1">
          {onReply && (
            <button type="button" onClick={onReply} className="hover:text-info">
              Reply
            </button>
          )}
          {onToggleResolved && (
            <button type="button" onClick={onToggleResolved} className="hover:text-info">
              {comment.resolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
          {isSelf && (
            <button type="button" onClick={onDelete} className="hover:text-danger">
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Standard Red Notes: per-note comments thread + @mentions.
 *
 * Lists the note's comment threads (top-level comments each with their replies),
 * with add / reply / resolve / delete. Comments are stored end-to-end encrypted
 * in the note's appData and — in a shared vault — pushed live over the relay
 * (see useNoteComments). @mentions autocomplete the note's vault members.
 *
 * First version: comments are note-level (or carry a `super` block anchor passed
 * in by a future CommentsPlugin). Inline range anchoring + scroll-to is a
 * follow-up; the data model already carries the anchor so the panel can show an
 * "inline" badge + snippet today.
 */
export const CommentsPanel: FunctionComponent<Props> = ({ note }) => {
  const { comments, addComment, removeComment, setResolved, selfUuid } = useNoteComments(note)
  const candidates = useMentionCandidates(note)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)

  const threads = useMemo(() => buildCommentThreads(comments), [comments])
  const visibleThreads = useMemo(
    () => (showResolved ? threads : threads.filter((t) => !t.comment.resolved)),
    [threads, showResolved],
  )
  const resolvedCount = useMemo(() => threads.filter((t) => t.comment.resolved).length, [threads])

  const isSelf = (comment: NoteComment): boolean => comment.authorUuid === selfUuid

  return (
    <div className="rounded border border-border bg-default p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-passive-0">
          <Icon type="chat-bubble" size="small" />
          Comments
          {comments.length > 0 && <span className="text-passive-1">({comments.length})</span>}
        </div>
        {resolvedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowResolved((s) => !s)}
            className="text-xs text-passive-1 hover:text-info"
          >
            {showResolved ? 'Hide resolved' : `Show resolved (${resolvedCount})`}
          </button>
        )}
      </div>

      <div className="mb-2.5 max-h-80 space-y-3 overflow-y-auto overscroll-contain">
        {visibleThreads.length === 0 ? (
          <div className="py-2 text-center text-xs text-passive-2">No comments yet. Start the conversation.</div>
        ) : (
          visibleThreads.map(({ comment, replies }) => (
            <div key={comment.id} className="space-y-2">
              <CommentRow
                comment={comment}
                isSelf={isSelf(comment)}
                onDelete={() => void removeComment(comment.id)}
                onToggleResolved={() => void setResolved(comment.id, !comment.resolved)}
                onReply={() => setReplyingTo((id) => (id === comment.id ? null : comment.id))}
              />
              {replies.map((reply) => (
                <CommentRow
                  key={reply.id}
                  comment={reply}
                  isSelf={isSelf(reply)}
                  isReply
                  onDelete={() => void removeComment(reply.id)}
                />
              ))}
              {replyingTo === comment.id && (
                <div className="ml-6">
                  <CommentComposer
                    candidates={candidates}
                    autoFocus
                    submitLabel="Reply"
                    placeholder="Write a reply…"
                    onSubmit={(text) => {
                      void addComment({ text, parentId: comment.id })
                      setReplyingTo(null)
                    }}
                    onCancel={() => setReplyingTo(null)}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <CommentComposer candidates={candidates} onSubmit={(text) => void addComment({ text })} />
    </div>
  )
}

export default CommentsPanel
