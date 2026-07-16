/**
 * Standard Red Notes: Typography Profiles — transfer wizard, PREVIEW views.
 *
 * Truthful previews for both wizard modes:
 *
 *  - `SanitizationDiffView` renders e1's `SanitizationDiff` for one imported
 *    profile — the diff is computed with the REAL `sanitizeBlockStyle`, so what the
 *    user sees ("kept" / "changed" / "removed") is exactly what import will apply.
 *    It CANNOT lie: it renders whatever the sanitiser actually did.
 *
 *  - `ExportSummary` renders the resulting file shape for the export mode's Preview
 *    step (how many profiles / blocks, the filename, bundle vs legacy single-file).
 */
import { FunctionComponent } from 'react'
import { classNames } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import type { BlockDeclarationDiff, SanitizationDiff } from '@/Utils/typographyProfileImportExport'

const statusMeta: Record<BlockDeclarationDiff['status'], { label: string; className: string }> = {
  kept: { label: 'kept', className: 'text-passive-0' },
  altered: { label: 'changed', className: 'text-warning' },
  dropped: { label: 'removed', className: 'text-danger' },
}

const DeclarationRow: FunctionComponent<{ declaration: BlockDeclarationDiff }> = ({ declaration }) => {
  const meta = statusMeta[declaration.status]
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-xs">
      <span className="text-text flex-shrink-0 font-mono">{declaration.property}</span>
      <span
        className={classNames(
          'min-w-0 flex-grow truncate font-mono',
          declaration.status === 'dropped' ? 'text-danger line-through' : 'text-passive-0',
        )}
        title={declaration.rawValue}
      >
        {declaration.rawValue}
      </span>
      {declaration.status === 'altered' && declaration.cleanValue !== undefined && (
        <span className="text-warning min-w-0 flex-shrink truncate font-mono" title={declaration.cleanValue}>
          → {declaration.cleanValue}
        </span>
      )}
      <span className={classNames('flex-shrink-0 font-semibold', meta.className)}>{meta.label}</span>
    </div>
  )
}

/** The per-profile sanitisation diff shown in the import Preview & Select step. */
export const SanitizationDiffView: FunctionComponent<{ sourceName: string; diff: SanitizationDiff }> = ({
  sourceName,
  diff,
}) => (
  <div className="border-border rounded border px-3 py-2">
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-text truncate text-sm font-semibold">{sourceName}</span>
      <span className="text-passive-1 flex-shrink-0 text-xs">
        {diff.totalKept} kept
        {diff.totalDropped > 0 && <span className="text-danger"> · {diff.totalDropped} removed</span>}
      </span>
    </div>
    {diff.blocks.length === 0 ? (
      <div className="text-passive-1 text-xs">No block styles in this profile.</div>
    ) : (
      <div className="flex flex-col gap-2">
        {diff.blocks.map((block) => (
          <div key={block.key}>
            <div className="text-passive-0 flex items-center gap-1.5 text-xs font-semibold">
              {block.label}
              {!block.known && (
                <span className="text-danger flex items-center gap-1">
                  <Icon type="warning" size="small" />
                  unknown block — skipped
                </span>
              )}
            </div>
            {block.declarations.length > 0 && (
              <div className="mt-0.5 pl-2">
                {block.declarations.map((declaration) => (
                  <DeclarationRow key={`${block.key}-${declaration.property}`} declaration={declaration} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    )}
  </div>
)

/** The resulting-file summary shown in the export Preview step. */
export const ExportSummary: FunctionComponent<{
  profileCount: number
  blockCount: number
  fileName: string
  isBundle: boolean
}> = ({ profileCount, blockCount, fileName, isBundle }) => (
  <div className="border-border flex flex-col gap-2 rounded border px-3 py-3">
    <div className="text-text flex items-center gap-2 text-sm font-semibold">
      <Icon type="download" className="text-passive-1" />
      Ready to export
    </div>
    <dl className="text-sm">
      <div className="flex justify-between py-0.5">
        <dt className="text-passive-1">Profiles</dt>
        <dd className="text-text font-medium">{profileCount}</dd>
      </div>
      <div className="flex justify-between py-0.5">
        <dt className="text-passive-1">Blocks included</dt>
        <dd className="text-text font-medium">{blockCount}</dd>
      </div>
      <div className="flex justify-between gap-2 py-0.5">
        <dt className="text-passive-1 flex-shrink-0">File</dt>
        <dd className="text-text min-w-0 truncate font-mono text-xs" title={fileName}>
          {fileName}
        </dd>
      </div>
      <div className="flex justify-between py-0.5">
        <dt className="text-passive-1">Format</dt>
        <dd className="text-text font-medium">{isBundle ? 'Multi-profile bundle' : 'Single profile (legacy)'}</dd>
      </div>
    </dl>
  </div>
)
