import { observer } from 'mobx-react-lite'
import { useCallback, useMemo, useState } from 'react'
import Modal, { ModalAction } from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import { ExportModalController } from '@/Controllers/ExportModal/ExportModalController'
import { useApplication } from '../ApplicationProvider'
import Button from '../Button/Button'
import Spinner from '../Spinner/Spinner'
import { addToast, ToastType } from '@standardnotes/toast'
import { exportAllNotesAsMarkdown } from '@/Utils/exportAllNotesAsMarkdown'
import { c } from 'ttag'

type ExportKind = 'encrypted' | 'decrypted' | 'markdown'

const ExportModal = ({ exportModalController }: { exportModalController: ExportModalController }) => {
  const application = useApplication()
  const { isVisible, close } = exportModalController
  const [busy, setBusy] = useState<ExportKind | null>(null)

  const hasAccount = application.hasAccount()

  const runExport = useCallback(
    async (kind: ExportKind) => {
      setBusy(kind)
      try {
        if (kind === 'encrypted') {
          await application.archiveService.downloadBackup(true)
        } else if (kind === 'decrypted') {
          await application.archiveService.downloadBackup(false)
        } else {
          const count = await exportAllNotesAsMarkdown(application)
          if (count === 0) {
            addToast({ type: ToastType.Regular, message: c('Info').t`There are no notes to export.` })
          }
        }
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: c('Error').t`Export failed. Please try again.` })
      } finally {
        setBusy(null)
      }
    },
    [application],
  )

  const modalActions: ModalAction[] = useMemo(
    () => [
      {
        label: c('Action').t`Done`,
        type: 'cancel',
        onClick: close,
        mobileSlot: 'left',
      },
    ],
    [close],
  )

  const options: { kind: ExportKind; title: string; description: string; disabled?: boolean; disabledHint?: string }[] = [
    {
      kind: 'encrypted',
      title: c('Title').t`Encrypted backup`,
      description: c('Info')
        .t`A complete, end-to-end-encrypted backup of your account in the native Standard Red Notes format. Re-importable with your password.`,
      disabled: !hasAccount,
      disabledHint: c('Info')
        .t`Sign in or create an account to export an encrypted backup. A decrypted or Markdown export is available offline.`,
    },
    {
      kind: 'decrypted',
      title: c('Title').t`Decrypted backup`,
      description: c('Info')
        .t`A plaintext backup in the native Standard Red Notes format (a .zip of your items). Re-importable; keep it somewhere safe.`,
    },
    {
      kind: 'markdown',
      title: c('Title').t`Markdown`,
      description: c('Info')
        .t`A simple .zip of all your notes as plain Markdown (.md) files. Great for reading elsewhere — not re-importable as a full backup.`,
    },
  ]

  return (
    <ModalOverlay isOpen={isVisible} close={close}>
      <Modal title={c('Title').t`Export`} close={close} actions={modalActions} className="flex flex-col">
        <div className="min-h-0 flex-grow divide-y divide-border overflow-y-auto px-4 py-2">
          {options.map((option) => (
            <div key={option.kind} className="flex items-center justify-between gap-4 py-3.5">
              <div className="flex flex-col pr-2">
                <div className="text-base font-semibold lg:text-sm">{option.title}</div>
                <div className="mt-1 text-sm text-passive-0 lg:text-xs">
                  {option.disabled && option.disabledHint ? option.disabledHint : option.description}
                </div>
              </div>
              <Button
                primary
                small
                disabled={option.disabled || busy !== null}
                onClick={() => runExport(option.kind)}
                className="flex items-center whitespace-nowrap"
              >
                {busy === option.kind ? <Spinner className="my-1" /> : c('Action').t`Export`}
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    </ModalOverlay>
  )
}

export default observer(ExportModal)
