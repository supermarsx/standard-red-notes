/**
 * Standard Red Notes: Typography Profiles — the IMPORT / EXPORT wizard.
 *
 * One shared modal, `mode: 'import' | 'export'`, built on the project's
 * `Modal` + `ModalOverlay` (same pattern as `TypographyStyleEditorModal`). A
 * 3-step machine with a shared stepper; both modes reuse the block-selection tree
 * (`ProfileBlockSelectionTree`) and the truthful previews (`TransferPreview`).
 *
 *   IMPORT:  Source (file picker + local drag-drop, parse via e1's
 *            `parseImportedBundle`) → Preview & select (grouped block tree +
 *            per-block sanitisation diff + create-new / merge-into-existing target)
 *            → Confirm (apply via `resolveImport`, show what changed).
 *   EXPORT:  Select (block tree over existing profiles) → Preview (resulting file
 *            summary) → Export (`serializeProfilesForExport` → download).
 *
 * The wizard is intentionally self-contained and application-agnostic: it takes the
 * existing profiles + two callbacks (`onImportApply` gets the FINAL resolved list
 * for `setPreference`; `onExportDownload` gets the serialised bytes + filename), so
 * it can be render-tested end-to-end without an app context.
 */
import { FunctionComponent, ReactNode, useMemo, useState } from 'react'
import type { TypographyProfile } from '@standardnotes/models'
import { classNames } from '@standardnotes/snjs'
import Modal, { ModalAction } from '@/Components/Modal/Modal'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import Dropdown from '@/Components/Dropdown/Dropdown'
import Icon from '@/Components/Icon/Icon'
import {
  buildFullSelection,
  countSelectedBlocks,
  parseImportedBundle,
  resolveImport,
  selectFromBundle,
  serializeProfilesForExport,
  type ImportedProfileResult,
  type ParseImportedBundleResult,
  type ProfileBlockSelection,
  type SerializedExport,
} from '@/Utils/typographyProfileImportExport'
import ImportDropZone from './ImportDropZone'
import ProfileBlockSelectionTree from './ProfileBlockSelectionTree'
import { ExportSummary, SanitizationDiffView } from './TransferPreview'

export type ProfileTransferWizardMode = 'import' | 'export'

type ProfileTransferWizardProps = {
  mode: ProfileTransferWizardMode
  isOpen: boolean
  close: () => void
  /** Existing profiles — export sources and import merge targets. */
  profiles: TypographyProfile[]
  /** Export only: pre-scope the initial selection to a single profile's blocks. */
  initialProfileId?: string
  /** Import: receives the FINAL resolved profile list, ready for `setPreference`. */
  onImportApply: (resolved: TypographyProfile[]) => void
  /** Export: receives the serialised bytes + filename to trigger a download. */
  onExportDownload: (serialized: SerializedExport) => void
}

type ParsedBundle = Extract<ParseImportedBundleResult, { ok: true }>

const STEP_LABELS: Record<ProfileTransferWizardMode, [string, string, string]> = {
  import: ['Source', 'Preview & select', 'Confirm'],
  export: ['Select', 'Preview', 'Export'],
}

/* --------------------------------------------------------------------- stepper */

const Stepper: FunctionComponent<{ labels: readonly string[]; current: number }> = ({ labels, current }) => (
  <ol className="border-border flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-3">
    {labels.map((label, index) => {
      const state = index === current ? 'current' : index < current ? 'done' : 'upcoming'
      return (
        <li key={label} className="flex items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
          <span
            className={classNames(
              'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold',
              state === 'current' && 'bg-info text-info-contrast',
              state === 'done' && 'bg-success text-success-contrast',
              state === 'upcoming' && 'bg-passive-3 text-passive-0',
            )}
          >
            {state === 'done' ? <Icon type="check" size="small" /> : index + 1}
          </span>
          <span className={classNames('text-sm', state === 'current' ? 'text-text font-semibold' : 'text-passive-1')}>
            {label}
          </span>
          {index < labels.length - 1 && <span className="text-passive-2 mx-1">›</span>}
        </li>
      )
    })}
  </ol>
)

/* ----------------------------------------------------------------- shared shell */

const WizardShell: FunctionComponent<{
  title: string
  mode: ProfileTransferWizardMode
  step: number
  close: () => void
  actions: ModalAction[]
  children: ReactNode
}> = ({ title, mode, step, close, actions, children }) => (
  <Modal title={title} close={close} className="p-0" actions={actions}>
    <div className="flex flex-col">
      <Stepper labels={STEP_LABELS[mode]} current={step} />
      <div className="min-h-0 overflow-y-auto p-4">{children}</div>
    </div>
  </Modal>
)

/* ----------------------------------------------------------------- import mode */

const ImportWizardContent: FunctionComponent<{
  profiles: TypographyProfile[]
  close: () => void
  onImportApply: (resolved: TypographyProfile[]) => void
}> = ({ profiles, close, onImportApply }) => {
  const [step, setStep] = useState(0)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedBundle | null>(null)
  const [selection, setSelection] = useState<ProfileBlockSelection>({})
  const [targetMode, setTargetMode] = useState<'create' | 'merge'>('create')
  const [mergeTargetId, setMergeTargetId] = useState<string>(profiles[0]?.id ?? '')
  const [applied, setApplied] = useState<TypographyProfile[] | null>(null)

  const handleFile = async (file: File): Promise<void> => {
    setParseError(null)
    let text: string
    try {
      text = await file.text()
    } catch {
      setParseError('The selected file could not be read.')
      return
    }
    const result = parseImportedBundle(text)
    if (!result.ok) {
      setParseError(result.error.message)
      return
    }
    setParsed(result)
    setSelection(buildFullSelection(result.profiles))
    setStep(1)
  }

  const selectedBlockCount = countSelectedBlocks(selection)
  const canMerge = profiles.length > 0
  const canApply = selectedBlockCount > 0 && (targetMode === 'create' || (canMerge && mergeTargetId !== ''))

  const doImport = (): void => {
    if (!parsed) {
      return
    }
    const incoming = selectFromBundle(parsed.profiles, selection)
    const resolved =
      targetMode === 'merge'
        ? resolveImport(profiles, incoming, { mode: 'merge', targetProfileId: mergeTargetId })
        : resolveImport(profiles, incoming, { mode: 'create' })
    onImportApply(resolved)
    setApplied(resolved)
    setStep(2)
  }

  const failedResults = (parsed?.results ?? []).filter(
    (result): result is Extract<ImportedProfileResult, { ok: false }> => !result.ok,
  )
  const okResults = (parsed?.results ?? []).filter(
    (result): result is Extract<ImportedProfileResult, { ok: true }> => result.ok,
  )

  let body: ReactNode
  let actions: ModalAction[]

  if (step === 0) {
    body = (
      <div className="flex flex-col gap-3">
        <div className="text-passive-1 text-sm">
          Choose a typography profile file you exported before — a single profile or a multi-profile bundle. You will
          preview and pick exactly what to import next.
        </div>
        <ImportDropZone onFile={(file) => void handleFile(file)} error={parseError} />
      </div>
    )
    actions = [{ label: 'Cancel', type: 'cancel', onClick: close, mobileSlot: 'left' }]
  } else if (step === 1 && parsed) {
    body = (
      <div className="flex flex-col gap-4">
        {failedResults.length > 0 && (
          <div className="text-danger flex flex-col gap-1 text-sm">
            {failedResults.map((result, index) => (
              <div key={index} className="flex items-start gap-1.5" role="alert">
                <Icon type="warning" size="small" className="mt-0.5 flex-shrink-0" />
                <span>
                  {result.sourceName}: {result.error}
                </span>
              </div>
            ))}
          </div>
        )}

        <section>
          <div className="text-text mb-2 text-sm font-semibold">Choose what to import</div>
          <ProfileBlockSelectionTree profiles={parsed.profiles} selection={selection} onChange={setSelection} />
        </section>

        <section>
          <div className="text-text mb-2 text-sm font-semibold">Where should it go?</div>
          <div className="flex flex-col gap-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="import-target"
                aria-label="Create a new profile"
                checked={targetMode === 'create'}
                onChange={() => setTargetMode('create')}
                className="mt-1 flex-shrink-0"
              />
              <span>
                <span className="text-text font-medium">Create a new profile</span>
                <span className="text-passive-1 block text-xs">
                  Add the imported styles as a brand-new profile (nothing existing is changed).
                </span>
              </span>
            </label>
            <label className={classNames('flex items-start gap-2 text-sm', !canMerge && 'opacity-50')}>
              <input
                type="radio"
                name="import-target"
                aria-label="Merge into an existing profile"
                checked={targetMode === 'merge'}
                disabled={!canMerge}
                onChange={() => setTargetMode('merge')}
                className="mt-1 flex-shrink-0"
              />
              <span className="min-w-0 flex-grow">
                <span className="text-text font-medium">Merge selected blocks into an existing profile</span>
                <span className="text-passive-1 block text-xs">
                  Overwrite only the selected blocks of the chosen profile; its other blocks are kept.
                </span>
                {targetMode === 'merge' && canMerge && (
                  <div className="mt-2 max-w-xs">
                    <Dropdown
                      label="Merge into profile"
                      items={profiles.map((profile) => ({ label: profile.name, value: profile.id }))}
                      value={mergeTargetId}
                      onChange={setMergeTargetId}
                    />
                  </div>
                )}
              </span>
            </label>
          </div>
        </section>

        <section>
          <div className="text-text mb-2 text-sm font-semibold">Sanitisation preview</div>
          <div className="text-passive-1 mb-2 text-xs">
            Imported CSS is never trusted. Unsafe values are removed before anything is applied — this is exactly what
            will happen:
          </div>
          <div className="flex flex-col gap-2">
            {okResults.map((result, index) => (
              <SanitizationDiffView key={index} sourceName={result.sourceName} diff={result.diff} />
            ))}
          </div>
        </section>
      </div>
    )
    actions = [
      { label: 'Cancel', type: 'cancel', onClick: close, mobileSlot: 'left' },
      { label: 'Back', type: 'secondary', onClick: () => setStep(0) },
      {
        label: `Import ${selectedBlockCount} block${selectedBlockCount === 1 ? '' : 's'}`,
        type: 'primary',
        onClick: doImport,
        disabled: !canApply,
        mobileSlot: 'right',
      },
    ]
  } else {
    const createdOrMerged = targetMode === 'merge' ? 'merged into your profile' : 'imported as new profile(s)'
    body = (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Icon type="check-circle" size="large" className="text-success" />
        <div className="text-text text-base font-semibold">Import complete</div>
        <div className="text-passive-1 text-sm">
          {selectedBlockCount} block{selectedBlockCount === 1 ? '' : 's'} were sanitised and {createdOrMerged}. You now
          have {applied?.length ?? profiles.length} profile
          {(applied?.length ?? profiles.length) === 1 ? '' : 's'}.
        </div>
      </div>
    )
    actions = [{ label: 'Done', type: 'primary', onClick: close, mobileSlot: 'right' }]
  }

  return (
    <WizardShell title="Import typography profiles" mode="import" step={step} close={close} actions={actions}>
      {body}
    </WizardShell>
  )
}

/* ----------------------------------------------------------------- export mode */

const ExportWizardContent: FunctionComponent<{
  profiles: TypographyProfile[]
  initialProfileId?: string
  close: () => void
  onExportDownload: (serialized: SerializedExport) => void
}> = ({ profiles, initialProfileId, close, onExportDownload }) => {
  const [step, setStep] = useState(0)
  const [selection, setSelection] = useState<ProfileBlockSelection>(() => {
    const full = buildFullSelection(profiles)
    if (initialProfileId && full[initialProfileId]) {
      return { [initialProfileId]: full[initialProfileId] }
    }
    return full
  })
  const [downloaded, setDownloaded] = useState<SerializedExport | null>(null)

  const picked = useMemo(() => selectFromBundle(profiles, selection), [profiles, selection])
  const serialized = useMemo(() => serializeProfilesForExport(picked), [picked])
  const selectedBlockCount = countSelectedBlocks(selection)
  const canExport = picked.length > 0

  const doExport = (): void => {
    onExportDownload(serialized)
    setDownloaded(serialized)
    setStep(2)
  }

  let body: ReactNode
  let actions: ModalAction[]

  if (step === 0) {
    body = (
      <div className="flex flex-col gap-3">
        <div className="text-passive-1 text-sm">
          Pick the profiles and blocks to export. One profile is written as a single-profile file; two or more become a
          bundle you can import all at once.
        </div>
        <ProfileBlockSelectionTree profiles={profiles} selection={selection} onChange={setSelection} />
      </div>
    )
    actions = [
      { label: 'Cancel', type: 'cancel', onClick: close, mobileSlot: 'left' },
      {
        label: 'Next',
        type: 'primary',
        onClick: () => setStep(1),
        disabled: !canExport,
        mobileSlot: 'right',
      },
    ]
  } else if (step === 1) {
    body = (
      <div className="flex flex-col gap-3">
        <ExportSummary
          profileCount={picked.length}
          blockCount={selectedBlockCount}
          fileName={serialized.fileName}
          isBundle={serialized.isBundle}
        />
      </div>
    )
    actions = [
      { label: 'Cancel', type: 'cancel', onClick: close, mobileSlot: 'left' },
      { label: 'Back', type: 'secondary', onClick: () => setStep(0) },
      { label: 'Export', type: 'primary', onClick: doExport, mobileSlot: 'right' },
    ]
  } else {
    body = (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Icon type="check-circle" size="large" className="text-success" />
        <div className="text-text text-base font-semibold">Export ready</div>
        <div className="text-passive-1 text-sm">
          Downloaded <span className="text-text font-mono">{downloaded?.fileName}</span>.
        </div>
      </div>
    )
    actions = [{ label: 'Done', type: 'primary', onClick: close, mobileSlot: 'right' }]
  }

  return (
    <WizardShell title="Export typography profiles" mode="export" step={step} close={close} actions={actions}>
      {body}
    </WizardShell>
  )
}

/* -------------------------------------------------------------------- wrapper */

/**
 * The import/export wizard. Its inner content is mounted (and its state seeded)
 * only while open, so closing discards in-progress state and reopening starts
 * fresh — the same lifecycle `TypographyStyleEditorModal` relies on.
 */
const ProfileTransferWizard: FunctionComponent<ProfileTransferWizardProps> = ({
  mode,
  isOpen,
  close,
  profiles,
  initialProfileId,
  onImportApply,
  onExportDownload,
}) => (
  <ModalOverlay isOpen={isOpen} close={close} className="md:!w-auto md:max-w-[44rem]">
    {mode === 'import' ? (
      <ImportWizardContent profiles={profiles} close={close} onImportApply={onImportApply} />
    ) : (
      <ExportWizardContent
        profiles={profiles}
        initialProfileId={initialProfileId}
        close={close}
        onExportDownload={onExportDownload}
      />
    )}
  </ModalOverlay>
)

export default ProfileTransferWizard
