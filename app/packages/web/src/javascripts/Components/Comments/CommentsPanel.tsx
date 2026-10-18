import Dropdown from '@/Components/Dropdown/Dropdown'
import { FunctionComponent, ReactNode, useMemo, useState } from 'react'
import { SNNote } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import { CommentsApi, useNoteComments } from '@/Comments/useNoteComments'
import { useMentionCandidates } from '@/Comments/useMentionCandidates'
import { buildCommentThreads, CommentAnchor, CommentScope } from '@/Comments/comments'
import { usePrivateNoteComments } from '@/Comments/usePrivateNoteComments'
import { useApplication } from '@/Components/ApplicationProvider'
import { MentionCandidate, segmentCommentText, resolveSelfMentions } from '@/Comments/mentions'
import { collaboratorColor, collaboratorInitials } from '@/Components/SuperEditor/Collaboration/collaboratorColor'
import CommentComposer from './CommentComposer'
import { type DisplayNoteComment, readDisplayNoteComments } from '@/Comments/CommentAuthorship'
import usePreference from '@/Hooks/usePreference'
import {
  COMMENT_NOTIFY_DEFAULT_PREF_KEY,
  COMMENT_PRIVATE_HINT_DISMISSED_PREF_KEY,
  notifyOthersByDefault,
} from '@/Comments/CommentPreferences'

type Props = {
  note: SNNote
  anchor?: CommentAnchor
  onNavigate?: (anchor: CommentAnchor) => void
  targetControl?: ReactNode
  validateTarget?: (visibility: CommentScope, replying: boolean) => void
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
const CommentsPanelContent: FunctionComponent<
  ScopedProps & { privateApi: CommentsApi; sharedApi?: CommentsApi; candidates: MentionCandidate[] }
> = ({
  note,
  anchor,
  scope,
  setScope,
  privateApi,
  sharedApi,
  candidates,
  onNavigate,
  targetControl,
  validateTarget,
}) => {
  const application = useApplication()
  const defaultNotifyOthers = notifyOthersByDefault(usePreference(COMMENT_NOTIFY_DEFAULT_PREF_KEY))
  const privateHintDismissed = usePreference(COMMENT_PRIVATE_HINT_DISMISSED_PREF_KEY) === true
  const selfUuid = privateApi.selfUuid
  const quarantinedCount = privateApi.quarantinedCount + (sharedApi?.quarantinedCount ?? 0)
  const apiFor = (visibility: CommentScope) => (visibility === 'private' ? privateApi : sharedApi)
  const draftKey = `${scope}:${note.uuid}:${commentContextKey(anchor)}`
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [error, setError] = useState<string>()
  const canWriteFor = (visibility: CommentScope) => {
    let canWrite = Boolean(
      selfUuid &&
      !note.trashed &&
      application.isAuthorizedToRenderItem(note) &&
      !application.sessions.isCurrentSessionReadOnly(),
    )
    if (visibility === 'collaborative') {
      const vault = application.vaults.getItemVault(note)
      canWrite =
        canWrite &&
        !note.locked &&
        !(vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault))
    }
    return canWrite && Boolean(apiFor(visibility))
  }
  const canWrite = canWriteFor(scope)
  const perform = (work: Promise<unknown>) => {
    setError(undefined)
    return work
      .then(() => true)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : 'The comment could not be saved. Try again.')
        return false
      })
  }
  const submit = async (text: string, parentId?: string, notifyOthers = false, visibility = scope) => {
    const api = apiFor(visibility)
    if (!canWriteFor(visibility) || !api) {
      return
    }
    const parent = parentId ? api.comments.find((comment) => comment.id === parentId) : undefined
    if (parentId && !parent) {
      throw new Error('The comment thread is no longer available.')
    }
    validateTarget?.(visibility, Boolean(parentId))
    const saved = await api.addComment({
      text: resolveSelfMentions(text, selfUuid),
      parentId,
      anchor: parentId ? parent?.anchor : anchor,
      ...(visibility === 'collaborative' ? { notifyOthers } : {}),
    })
    if (!saved) {
      throw new Error('The comment could not be saved. Check that the note is unlocked and you still have access.')
    }
  }

  const threads = useMemo(
    () =>
      [
        ...buildCommentThreads(privateApi.comments).map((thread) => ({ ...thread, visibility: 'private' as const })),
        ...buildCommentThreads(sharedApi?.comments ?? []).map((thread) => ({
          ...thread,
          visibility: 'collaborative' as const,
        })),
      ].sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt)),
    [privateApi.comments, sharedApi?.comments],
  )
  const comments = [...privateApi.comments, ...(sharedApi?.comments ?? [])]
  const visibleThreads = useMemo(
    () => (showResolved ? threads : threads.filter((t) => !t.comment.resolved)),
    [threads, showResolved],
  )
  const resolvedCount = useMemo(() => threads.filter((t) => t.comment.resolved).length, [threads])

  const isSelf = (comment: DisplayNoteComment, visibility: CommentScope): boolean =>
    canWriteFor(visibility) && comment.verifiedAuthorUuid === selfUuid

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
      {error && (
        <p role="alert" className="text-danger mb-2 text-xs">
          {error}
        </p>
      )}

      <div className="mb-2.5 max-h-80 space-y-3 overflow-y-auto overscroll-contain">
        {privateApi.readError && (
          <p role="alert" className="text-passive-0 text-xs">
            {privateApi.readError}
          </p>
        )}
        {quarantinedCount > 0 && (
          <div className="border-warning bg-warning-faded text-warning rounded border px-2 py-1.5 text-xs">
            Some comments were hidden because their author proof or stored data could not be verified.
          </div>
        )}
        {visibleThreads.length === 0 ? (
          <div className="text-passive-0 py-2 text-center text-xs">
            {privateApi.readError ? 'Private comments are unavailable.' : 'No comments yet. Start the conversation.'}
          </div>
        ) : (
          visibleThreads.map(({ comment, replies, visibility }) => (
            <div key={`${visibility}:${comment.id}`} className="space-y-2">
              <span className="text-passive-1 text-[0.65rem]">
                {visibility === 'private' ? 'Only you' : 'Note members'} ·{' '}
                {comment.anchor ? 'Anchored comment' : 'Whole note'}
              </span>
              <CommentRow
                comment={comment}
                onNavigate={onNavigate}
                isSelf={isSelf(comment, visibility)}
                onDelete={() => canWriteFor(visibility) && perform(apiFor(visibility)!.removeComment(comment.id))}
                onToggleResolved={
                  canWriteFor(visibility)
                    ? () => perform(apiFor(visibility)!.setResolved(comment.id, !comment.resolved))
                    : undefined
                }
                onReply={
                  canWriteFor(visibility)
                    ? () =>
                        setReplyingTo((id) => {
                          return id === `${visibility}:${comment.id}` ? null : `${visibility}:${comment.id}`
                        })
                    : undefined
                }
              />
              {replies.map((reply) => (
                <CommentRow
                  key={reply.id}
                  comment={reply}
                  onNavigate={onNavigate}
                  isSelf={isSelf(reply, visibility)}
                  isReply
                  onDelete={() => canWriteFor(visibility) && perform(apiFor(visibility)!.removeComment(reply.id))}
                />
              ))}
              {replyingTo === `${visibility}:${comment.id}` && (
                <div className="ml-6">
                  <p className="text-passive-1 mb-1 text-xs">
                    Replying {visibility === 'private' ? 'privately' : 'to note members'} to this thread
                  </p>
                  <CommentComposer
                    key={`${visibility}:${comment.id}`}
                    draftKey={`${visibility}:${note.uuid}:reply:${comment.id}`}
                    candidates={candidates}
                    autoFocus
                    submitLabel="Reply"
                    placeholder="Write a reply…"
                    showNotifyOthers={visibility === 'collaborative'}
                    defaultNotifyOthers={defaultNotifyOthers}
                    onSubmit={async (text, notifyOthers) => {
                      const saved = await perform(submit(text, comment.id, notifyOthers, visibility))
                      if (saved) {
                        setReplyingTo(null)
                      }
                      return saved
                    }}
                    onCancel={() => setReplyingTo(null)}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="New comment options">
        <Dropdown
          portal
          label="Comment visibility"
          value={scope}
          onChange={(value) => setScope(value as CommentScope)}
          popoverPlacement="bottom-start"
          classNameOverride={{ button: '!min-w-0 !px-2 !py-1 [&_div]:!text-xs', wrapper: 'max-w-full text-xs' }}
          items={[
            { value: 'private', label: 'Private — only you' },
            { value: 'collaborative', label: 'Collaborative — note members' },
          ]}
        />
        {targetControl}
      </div>
      {scope === 'private' && !privateHintDismissed && (
        <div className="text-passive-1 mb-2 flex items-start gap-1 text-xs">
          <p className="flex-1">Encrypted in your account. Never shared with note members.</p>
          <button
            type="button"
            aria-label="Don't show private comment explanation again"
            onClick={() => application.setPreference(COMMENT_PRIVATE_HINT_DISMISSED_PREF_KEY, true)}
          >
            ×
          </button>
        </div>
      )}

      {canWrite ? (
        <CommentComposer
          key={draftKey}
          draftKey={draftKey}
          candidates={candidates}
          showNotifyOthers={scope === 'collaborative'}
          defaultNotifyOthers={defaultNotifyOthers}
          onSubmit={(text, notifyOthers) => perform(submit(text, undefined, notifyOthers))}
        />
      ) : (
        <p className="text-passive-1 text-xs">Comments are read-only for this account or note.</p>
      )}
    </div>
  )
}

const PrivateCommentsPanel: FunctionComponent<ScopedProps> = (props) => {
  const api = usePrivateNoteComments(props.note)
  const self = api.selfUuid ? [{ userUuid: api.selfUuid, name: 'self' }] : []
  return <CommentsPanelContent {...props} privateApi={api} candidates={self} />
}

const CollaborativeCommentsPanel: FunctionComponent<ScopedProps> = (props) => {
  const api = useNoteComments(props.note)
  const privateApi = usePrivateNoteComments(props.note)
  const candidates = useMentionCandidates(props.note)
  const allCandidates =
    privateApi.selfUuid && !candidates.some((candidate) => candidate.userUuid === privateApi.selfUuid)
      ? [{ userUuid: privateApi.selfUuid, name: 'self' }, ...candidates]
      : candidates
  return <CommentsPanelContent {...props} privateApi={privateApi} sharedApi={api} candidates={allCandidates} />
}

/** Private is the default and never mounts the shared-key/room-access hook. */
export const CommentsPanel: FunctionComponent<Props> = ({
  note,
  anchor,
  onNavigate,
  targetControl,
  validateTarget,
}) => {
  const application = useApplication()
  const scopeKey = `${application.sessions.getUser()?.uuid ?? 'offline'}:${note.uuid}`
  const [state, setState] = useState<{ key: string; scope: CommentScope; sharedRequested: boolean }>({
    key: scopeKey,
    scope: 'private',
    sharedRequested: false,
  })
  const scope = state.key === scopeKey ? state.scope : 'private'
  const props = {
    note,
    anchor,
    onNavigate,
    targetControl,
    validateTarget,
    scope,
    setScope: (value: CommentScope) =>
      setState({
        key: scopeKey,
        scope: value,
        sharedRequested: value === 'collaborative' || (state.key === scopeKey && state.sharedRequested),
      }),
  }
  const existingShared =
    application.isAuthorizedToRenderItem(note) && readDisplayNoteComments(application, note).comments.length > 0
  return !(existingShared || (state.key === scopeKey && state.sharedRequested)) ? (
    <PrivateCommentsPanel key={scopeKey} {...props} />
  ) : (
    <CollaborativeCommentsPanel key={scopeKey} {...props} />
  )
}

export default CommentsPanel
