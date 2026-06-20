import { useCallback, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import {
  GitHubPublishOutcome,
  noteToMarkdown,
  parseOwnerRepo,
  publishNoteToGitHub,
  sanitizeFileName,
  sanitizeRepoPath,
} from '@/Integrations/GitHubPublish'
import {
  clearRememberedToken,
  loadGitHubPublishSettings,
  loadRememberedToken,
  saveGitHubPublishSettings,
  saveRememberedToken,
} from '@/Integrations/GitHubPublishSettings'

type Props = {
  application: WebApplication
  note: SNNote
  isOpen: boolean
  close: () => void
}

const inputClass = 'rounded border border-border bg-default px-2 py-1.5 text-sm'

const PublishToGitHubModalContent = observer(({ application, note, close }: Omit<Props, 'isOpen'>) => {
  const initialSettings = useMemo(() => loadGitHubPublishSettings(), [])

  const [repo, setRepo] = useState(initialSettings.repo)
  const [branch, setBranch] = useState(initialSettings.branch || 'main')
  const [pathPrefix, setPathPrefix] = useState(initialSettings.pathPrefix)
  const [fileName, setFileName] = useState(() => sanitizeFileName(note.title))
  const [message, setMessage] = useState('')
  const [token, setToken] = useState(() => (initialSettings.rememberToken ? loadRememberedToken() : ''))
  const [rememberToken, setRememberToken] = useState(initialSettings.rememberToken)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<GitHubPublishOutcome | null>(null)

  const parsedRepo = useMemo(() => parseOwnerRepo(repo), [repo])

  const effectivePath = useMemo(() => {
    const prefix = sanitizeRepoPath(pathPrefix)
    const name = sanitizeFileName(fileName)
    return prefix ? `${prefix}/${name}` : name
  }, [pathPrefix, fileName])

  const canSubmit = Boolean(parsedRepo) && token.trim().length > 0 && effectivePath.length > 0 && !submitting

  const onSubmit = useCallback(async () => {
    if (!parsedRepo) {
      return
    }
    setSubmitting(true)
    setResult(null)

    // Persist the non-secret conveniences regardless of outcome.
    saveGitHubPublishSettings({
      repo,
      branch: branch.trim() || 'main',
      pathPrefix,
      rememberToken,
    })
    // Honor the PAT opt-in: store it only when remembered, otherwise wipe it.
    if (rememberToken) {
      saveRememberedToken(token)
    } else {
      clearRememberedToken()
    }

    try {
      const { markdown } = await noteToMarkdown(application, note)

      const outcome = await publishNoteToGitHub(application, {
        token: token.trim(),
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        branch: branch.trim() || 'main',
        path: effectivePath,
        message: message.trim(),
        content: markdown,
      })

      setResult(outcome)

      if (outcome.ok) {
        addToast({
          type: ToastType.Success,
          message: `Note ${outcome.created ? 'published' : 'updated'} on GitHub.`,
        })
      } else {
        addToast({ type: ToastType.Error, message: `Publish failed: ${outcome.message}` })
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      setResult({ ok: false, message: messageText })
      addToast({ type: ToastType.Error, message: `Publish failed: ${messageText}` })
    } finally {
      setSubmitting(false)
    }
  }, [application, note, parsedRepo, repo, branch, pathPrefix, effectivePath, message, token, rememberToken])

  return (
    <Modal
      title="Publish to GitHub"
      className="p-4"
      close={close}
      actions={[
        {
          label: result?.ok ? 'Close' : 'Cancel',
          type: 'cancel',
          onClick: close,
          mobileSlot: 'left',
        },
        {
          label: submitting ? 'Publishing…' : 'Publish',
          type: 'primary',
          onClick: () => void onSubmit(),
          disabled: !canSubmit,
          mobileSlot: 'right',
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* Prominent privacy/security disclosure — same callout style as Shares / AppPasswords. */}
        <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm">
          <div className="font-semibold text-warning">This removes end-to-end encryption for the published copy</div>
          <p className="mt-1">
            Publishing sends this note&rsquo;s decrypted contents to your server and to GitHub, where it is stored
            unencrypted. This removes end-to-end encryption for the published copy. Only publish notes you&rsquo;re
            comfortable storing in plaintext on GitHub.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold">GitHub repository</label>
          <input
            className={inputClass}
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="owner/repo"
            autoComplete="off"
          />
          {repo.trim().length > 0 && !parsedRepo && (
            <span className="text-xs text-danger">Enter the repository as owner/repo.</span>
          )}
        </div>

        <div className="flex gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-sm font-semibold">Branch</label>
            <input
              className={inputClass}
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="main"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-sm font-semibold">Folder (optional)</label>
            <input
              className={inputClass}
              value={pathPrefix}
              onChange={(event) => setPathPrefix(event.target.value)}
              placeholder="notes"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold">File name</label>
          <input
            className={inputClass}
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
            placeholder="note.md"
            autoComplete="off"
          />
          <span className="text-xs text-passive-0">
            Will be saved as <strong>{effectivePath || '(invalid path)'}</strong>
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold">Commit message (optional)</label>
          <input
            className={inputClass}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={`Publish ${effectivePath} from Standard Red Notes`}
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold">Personal access token</label>
          <input
            className={inputClass}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="ghp_… or fine-grained token"
            autoComplete="off"
          />
          <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rememberToken}
              onChange={(event) => setRememberToken(event.target.checked)}
            />
            Remember this token on this device
          </label>
          <span className="text-xs text-passive-0">
            The token needs write (Contents) access to the repository. If remembered, it is stored unencrypted in this
            browser&rsquo;s local storage on this device only — not synced.
          </span>
        </div>

        {result && result.ok && (
          <div className="rounded border border-border bg-contrast p-3 text-sm">
            <span>Note {result.created ? 'published' : 'updated'} at </span>
            {result.contentUrl ? (
              <a className="text-info hover:underline" href={result.contentUrl} target="_blank" rel="noreferrer">
                {result.path}
              </a>
            ) : (
              <strong>{result.path}</strong>
            )}
            {result.commitUrl && (
              <>
                {' · '}
                <a className="text-info hover:underline" href={result.commitUrl} target="_blank" rel="noreferrer">
                  view commit
                </a>
              </>
            )}
          </div>
        )}
        {result && !result.ok && <p className="text-sm text-danger">{result.message}</p>}
      </div>
    </Modal>
  )
})

const PublishToGitHubModal = ({ application, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[36rem]">
      <PublishToGitHubModalContent application={application} note={note} close={close} />
    </ModalOverlay>
  )
}

export default observer(PublishToGitHubModal)
