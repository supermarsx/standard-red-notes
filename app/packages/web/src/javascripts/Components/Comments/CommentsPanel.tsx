import Dropdown from '@/Components/Dropdown/Dropdown'
import { FunctionComponent, useMemo, useState } from 'react'
import { SNNote } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import { CommentsApi, useNoteComments } from '@/Comments/useNoteComments'
import { useMentionCandidates } from '@/Comments/useMentionCandidates'
import { buildCommentThreads, CommentAnchor, CommentScope } from '@/Comments/comments'
import { usePrivateNoteComments } from '@/Comments/usePrivateNoteComments'
import { useApplication } from '@/Components/ApplicationProvider'
import { MentionCandidate, segmentCommentText } from '@/Comments/mentions'
import { collaboratorColor, collaboratorInitials } from '@/Components/SuperEditor/Collaboration/collaboratorColor'
import CommentComposer from './CommentComposer'
import type { DisplayNoteComment } from '@/Comments/CommentAuthorship'

type Props = {
  note: SNNote
  anchor?: CommentAnchor
  onNavigate?: (anchor: CommentAnchor) => void
}
function commentContextKey(anchor?: CommentAnchor): string {
  if (anchor?.kind === 'checklist') {
    return `checklist:${anchor.todoId}`
  }
  if (anchor?.kind === 'super') {
    return `super:${anchor.blockKey}`
  }
  return 'note'
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
    <span className="text-text text-sm break-words whitespace-pre-wrap">
      {segments.map((segment, index) => {
        return segment.type === 'mention' ? (
          <span key={index} className="bg-info-backdrop text-info rounded px-1 font-medium">
            @{segment.name}
          </span>
        ) : (
          <span key={index}>{segment.value}</span>
        )
      })}
    </span>
  )
}

const CommentRow: FunctionComponent<{
  comment: DisplayNoteComment
  isSelf: boolean
  isReply?: boolean
  onDelete: () => void
  onToggleResolved?: () => void
  onReply?: () => void
  onNavigate?: (anchor: CommentAnchor) => void
}> = ({ comment, isSelf, isReply, onDelete, onToggleResolved, onReply, onNavigate }) => {
  const color = collaboratorColor(comment.verifiedAuthorUuid ?? 'legacy-comment')
  return (
    <div className={`flex gap-2 ${isReply ? 'ml-6' : ''} ${comment.resolved ? 'opacity-60' : ''}`}>
      <div
        className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[0.6rem] font-bold text-white select-none"
        style={{ backgroundColor: color }}
        aria-hidden
      >
        {collaboratorInitials(comment.displayAuthorName)}
      </div>
      <div className="min-w-0 flex-grow">
        <div className="flex items-center gap-2">
          <span className="text-text truncate text-xs font-semibold">{isSelf ? 'You' : comment.displayAuthorName}</span>
          <span className="text-passive-2 text-xs">{formatTime(comment.createdAt)}</span>
          {comment.authorshipStatus === 'legacy' && (
            <span className="bg-contrast text-passive-1 rounded px-1 text-[0.6rem]" title="Author not verified">
              legacy
            </span>
          )}
          {comment.anchor?.kind === 'super' && (
            <span className="bg-contrast text-passive-1 rounded px-1 text-[0.6rem]" title="Inline comment">
              inline
            </span>
          )}
          {comment.resolved && <span className="text-success text-[0.6rem] uppercase">resolved</span>}
        </div>
        {comment.anchor?.snippet && (
          <button
            type="button"
            disabled={!onNavigate}
            onClick={() => comment.anchor && onNavigate?.(comment.anchor)}
            className="border-border text-passive-1 hover:text-info mt-0.5 border-l-2 pl-2 text-left text-xs italic"
            aria-label="Go to commented text"
          >
            “{comment.anchor.snippet}”
          </button>
        )}
        <div className="mt-0.5">
          <CommentBody text={comment.text} />
        </div>
        <div className="text-passive-1 mt-1 flex items-center gap-3 text-xs">
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
type ScopedProps = Props & { scope: CommentScope; setScope: (scope: CommentScope) => void }
const CommentsPanelContent: FunctionComponent<ScopedProps & { api: CommentsApi; candidates: MentionCandidate[] }> = ({
  note,
  anchor,
  scope,
  setScope,
  api,
  candidates,
  onNavigate,
}) => {
  const application = useApplication()
  const { quarantinedCount, addComment, removeComment, setResolved, selfUuid } = api
  const draftKey = `${scope}:${note.uuid}:${commentContextKey(anchor)}`
  const comments = api.comments.filter((comment) => {
    return anchor?.kind === 'checklist'
      ? comment.anchor?.kind === 'checklist' && comment.anchor.todoId === anchor.todoId
      : comment.anchor?.kind !== 'checklist'
  })
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [error, setError] = useState<string>()
  let canWrite = Boolean(
    selfUuid &&
    !note.trashed &&
    application.isAuthorizedToRenderItem(note) &&
    !application.sessions.isCurrentSessionReadOnly(),
  )
  if (scope === 'collaborative') {
    const vault = application.vaults.getItemVault(note)
    canWrite =
      canWrite &&
      !note.locked &&
      !(vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault))
  }
  const perform = (work: Promise<unknown>) => {
    setError(undefined)
    void work.catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : 'The comment could not be saved. Try again.'),
    )
  }
  const submit = async (text: string, parentId?: string) => {
    if (!canWrite) {
      return
    }
    const saved = await addComment({ text, parentId, anchor })
    if (!saved) {
      throw new Error('The comment could not be saved. Check that the note is unlocked and you still have access.')
    }
  }

  const threads = useMemo(() => buildCommentThreads(comments), [comments])
  const visibleThreads = useMemo(
    () => (showResolved ? threads : threads.filter((t) => !t.comment.resolved)),
    [threads, showResolved],
  )
  const resolvedCount = useMemo(() => threads.filter((t) => t.comment.resolved).length, [threads])

  const isSelf = (comment: DisplayNoteComment): boolean => canWrite && comment.verifiedAuthorUuid === selfUuid

  return (
    <div className="border-border bg-default rounded border p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-passive-0 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
          <Icon type="comment" size="small" />
          {anchor?.kind === 'checklist' ? 'Item comments' : 'Note comments'}
          {comments.length > 0 && <span className="text-passive-1">({comments.length})</span>}
        </div>
        {resolvedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowResolved((s) => !s)}
            className="text-passive-1 hover:text-info text-xs"
          >
            {showResolved ? 'Hide resolved' : `Show resolved (${resolvedCount})`}
          </button>
        )}
      </div>
      <div className="mb-2">
        <Dropdown
          portal
          label="Comment visibility"
          showLabel
          value={scope}
          onChange={(value) => setScope(value as CommentScope)}
          fullWidth
          popoverPlacement="bottom-start"
          classNameOverride={{ button: '!min-w-0', wrapper: 'text-xs' }}
          items={[
            { value: 'private', label: 'Private — only you' },
            { value: 'collaborative', label: 'Collaborative — note members' },
          ]}
        />
      </div>
      <p className="text-passive-1 mb-2 text-xs">
        {scope === 'private'
          ? 'Encrypted in your account. Never shared with note members.'
          : 'Shared with everyone who can read this note.'}
      </p>
      {error && (
        <p role="alert" className="text-danger mb-2 text-xs">
          {error}
        </p>
      )}

      <div className="mb-2.5 max-h-80 space-y-3 overflow-y-auto overscroll-contain">
        {quarantinedCount > 0 && (
          <div className="border-warning bg-warning-faded text-warning rounded border px-2 py-1.5 text-xs">
            Some comments were hidden because their author proof or stored data could not be verified.
          </div>
        )}
        {visibleThreads.length === 0 ? (
          <div className="text-passive-2 py-2 text-center text-xs">No comments yet. Start the conversation.</div>
        ) : (
          visibleThreads.map(({ comment, replies }) => (
            <div key={comment.id} className="space-y-2">
              <CommentRow
                comment={comment}
                onNavigate={onNavigate}
                isSelf={isSelf(comment)}
                onDelete={() => canWrite && perform(removeComment(comment.id))}
                onToggleResolved={canWrite ? () => perform(setResolved(comment.id, !comment.resolved)) : undefined}
                onReply={canWrite ? () => setReplyingTo((id) => (id === comment.id ? null : comment.id)) : undefined}
              />
              {replies.map((reply) => (
                <CommentRow
                  key={reply.id}
                  comment={reply}
                  onNavigate={onNavigate}
                  isSelf={isSelf(reply)}
                  isReply
                  onDelete={() => canWrite && perform(removeComment(reply.id))}
                />
              ))}
              {replyingTo === comment.id && (
                <div className="ml-6">
                  <CommentComposer
                    draftKey={`${draftKey}:reply:${comment.id}`}
                    candidates={candidates}
                    autoFocus
                    submitLabel="Reply"
                    placeholder="Write a reply…"
                    onSubmit={(text) => {
                      perform(submit(text, comment.id))
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

      {canWrite ? (
        <CommentComposer draftKey={draftKey} candidates={candidates} onSubmit={(text) => perform(submit(text))} />
      ) : (
        <p className="text-passive-1 text-xs">Comments are read-only for this account or note.</p>
      )}
    </div>
  )
}

const PrivateCommentsPanel: FunctionComponent<ScopedProps> = (props) => {
  const api = usePrivateNoteComments(props.note)
  return <CommentsPanelContent {...props} api={api} candidates={[]} />
}

const CollaborativeCommentsPanel: FunctionComponent<ScopedProps> = (props) => {
  const api = useNoteComments(props.note)
  const candidates = useMentionCandidates(props.note)
  return <CommentsPanelContent {...props} api={api} candidates={candidates} />
}

/** Private is the default and never mounts the shared-key/room-access hook. */
export const CommentsPanel: FunctionComponent<Props> = ({ note, anchor, onNavigate }) => {
  const application = useApplication()
  const scopeKey = `${application.sessions.getUser()?.uuid ?? 'offline'}:${note.uuid}:${commentContextKey(anchor)}`
  const [state, setState] = useState<{ key: string; scope: CommentScope }>({ key: scopeKey, scope: 'private' })
  const scope = state.key === scopeKey ? state.scope : 'private'
  const props = {
    note,
    anchor,
    onNavigate,
    scope,
    setScope: (value: CommentScope) => setState({ key: scopeKey, scope: value }),
  }
  return scope === 'private' ? (
    <PrivateCommentsPanel key={scopeKey} {...props} />
  ) : (
    <CollaborativeCommentsPanel key={scopeKey} {...props} />
  )
}

export default CommentsPanel
