import { ComponentProps, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ButtonType, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import usePreference from '@/Hooks/usePreference'
import { COMMENT_INDICATORS_PREF_KEY, showCommentIndicators } from '@/Comments/CommentPreferences'
import { canPurgeAllNoteComments } from '@/Comments/CommentPermissions'
import { mutatePrivateNoteComments } from '@/Comments/PrivateNoteComments'
import { useEditorControlsState } from '../../EditorControlsContext'
import { CAPTURE_COMMENT_ANCHOR_COMMAND } from '../CommentsPlugin/CommentsPlugin'
import ToolbarButton from './ToolbarButton'
import { resolveNoteEncryptionIdentity } from '../../Collaboration/CollaborationKeyDerivation'
import Icon from '@/Components/Icon/Icon'

function ReviewActionLabel({ icon, label }: { icon: ComponentProps<typeof Icon>['type']; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs whitespace-nowrap">
      <Icon type={icon} size="custom" className="super-toolbar-icon shrink-0 !text-current [&>path]:!text-current" />
      <span>{label}</span>
    </span>
  )
}

/** Review actions use the same compact, labelled groups as the rest of the ribbon. */
export function ReviewTools({ note }: { note: SNNote }) {
  const application = useApplication()
  const [editor] = useLexicalComposerContext()
  const controls = useEditorControlsState()
  const indicators = showCommentIndicators(usePreference(COMMENT_INDICATORS_PREF_KEY))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const owner = canPurgeAllNoteComments(application, note)
  const purge = async (scope: 'mine' | 'all') => {
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const sessionUser = application.sessions.getUser()
      const confirmed = await application.alerts.confirm(
        scope === 'all'
          ? 'Permanently remove every shared comment on this note and your private comments? Other people’s private comments are not affected. This cannot be undone.'
          : 'Permanently remove the shared comments you authored on this note and your private comments? Replies written by other people are kept. This cannot be undone.',
        scope === 'all' ? 'Purge all comments on this note?' : 'Purge your comments on this note?',
        'Purge comments',
        ButtonType.Danger,
      )
      if (!confirmed) {
        return
      }
      const current = application.items.findItem<SNNote>(note.uuid)
      if (
        !current ||
        !sessionUser ||
        application.sessions.getUser() !== sessionUser ||
        !application.isAuthorizedToRenderItem(current) ||
        current.trashed ||
        current.locked ||
        application.sessions.isCurrentSessionReadOnly() ||
        (scope === 'all' && !canPurgeAllNoteComments(application, current))
      ) {
        throw new Error('Comments cannot be purged with the current note permissions.')
      }
      const identity = resolveNoteEncryptionIdentity(application, current)
      if (!identity) {
        throw new Error('Comments cannot be purged until the note is unlocked.')
      }
      // Private deletion is deliberately independent of the shared room or relay.
      await mutatePrivateNoteComments(application, current.uuid, () => [])
      await application.notesController.purgeNoteComments(current, scope, identity)
    } catch {
      setError('Some comments could not be removed. Check the sidebar and try again.')
    } finally {
      setBusy(false)
    }
  }
  const group = 'super-toolbar-group bg-contrast flex flex-shrink-0 flex-col rounded-lg px-1 py-0.5'
  const caption =
    'text-passive-1 mt-px hidden whitespace-nowrap px-1 text-center text-[10px] leading-none font-medium tracking-wide uppercase select-none md:block'
  return (
    <>
      <div role="group" aria-label="Comment tools" className={group}>
        <div className="flex flex-col items-start justify-center gap-0.5 md:min-h-[6.25rem]">
          <ToolbarButton name="Show comments" aria-label="Show comments" onSelect={() => controls.openComments()}>
            <ReviewActionLabel icon="comment" label="Show comments" />
          </ToolbarButton>
          <ToolbarButton
            name="New comment on selection"
            aria-label="New comment on selection"
            onSelect={() =>
              editor.dispatchCommand(CAPTURE_COMMENT_ANCHOR_COMMAND, (anchor) =>
                controls.openComments(anchor ?? undefined),
              )
            }
          >
            <ReviewActionLabel icon="pencil-filled" label="New comment" />
          </ToolbarButton>
          <ToolbarButton
            name="Show comment indicators"
            aria-label="Show comment indicators"
            aria-pressed={indicators}
            active={indicators}
            onSelect={() => {
              void application
                .setPreference(COMMENT_INDICATORS_PREF_KEY, !indicators)
                .catch(() => setError('Comment display preference could not be saved.'))
            }}
          >
            <ReviewActionLabel icon={indicators ? 'eye' : 'eye-off'} label="Comment indicators" />
          </ToolbarButton>
        </div>
        <span aria-hidden className={caption}>
          Comments
        </span>
      </div>
      <div role="group" aria-label="Remove comments" className={group}>
        <div className="flex flex-col items-start justify-center gap-0.5 md:min-h-[6.25rem]">
          <ToolbarButton
            name="Purge my comments"
            aria-label="Purge my comments"
            disabled={busy}
            onSelect={() => {
              void purge('mine')
            }}
          >
            <ReviewActionLabel icon="trash" label="Purge my comments" />
          </ToolbarButton>
          {owner && (
            <ToolbarButton
              name="Purge all comments (note owner)"
              aria-label="Purge all comments"
              disabled={busy}
              onSelect={() => {
                void purge('all')
              }}
            >
              <ReviewActionLabel icon="trash-sweep" label="Purge all comments" />
            </ToolbarButton>
          )}
        </div>
        <span aria-hidden className={caption}>
          Manage
        </span>
      </div>
      {error && (
        <span role="alert" className="text-danger max-w-56 text-xs">
          {error}
        </span>
      )}
    </>
  )
}
