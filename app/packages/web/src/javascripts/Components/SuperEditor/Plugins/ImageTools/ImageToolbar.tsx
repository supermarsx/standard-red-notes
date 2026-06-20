import { IconType, classNames } from '@standardnotes/snjs'
import { ElementFormatType } from 'lexical'
import { useState } from 'react'
import IconButton from '@/Components/Button/IconButton'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { ImageAlignmentOptions } from '@/Components/FilePreview/ImageAlignmentOptions'
import { getOverflows } from '@/Components/Popover/Utils/Collisions'
import {
  ImageFloat,
  ImageSizePreset,
  ImageSizePresetLabels,
} from './ImageToolsTypes'

export type ImageToolbarProps = {
  /** Whether the toolbar is shown (image selected/hovered). */
  visible: boolean
  alignment: ElementFormatType
  onAlignmentChange: (format: ElementFormatType) => void
  onPresetSelect: (preset: ImageSizePreset) => void
  float: ImageFloat
  onFloatChange: (float: ImageFloat) => void
  captionEnabled: boolean
  onToggleCaption: () => void
  /** The element the toolbar should be kept within (defaults to editor root). */
  boundaryElement?: HTMLElement | null
}

const Presets: ImageSizePreset[] = ['small', 'medium', 'large', 'full']

/**
 * Word-style floating image toolbar shown above a selected image. Groups:
 *   - alignment (left / center / right) via the shared ImageAlignmentOptions
 *   - size presets (Small / Medium / Large / Full width)
 *   - text-wrap / float toggle (none / left / right) — see ImageToolsTypes for
 *     why this is a margin-based float and NOT true Word text-wrap
 *   - caption toggle
 *
 * Reuses IconButton + StyledTooltip for visual consistency and stays within the
 * editor viewport via getOverflows (so it remains usable on mobile).
 */
export default function ImageToolbar({
  visible,
  alignment,
  onAlignmentChange,
  onPresetSelect,
  float,
  onFloatChange,
  captionEnabled,
  onToggleCaption,
  boundaryElement,
}: ImageToolbarProps) {
  const [showPresets, setShowPresets] = useState(false)

  if (!visible) {
    return null
  }

  const cycleFloat = () => {
    const next: ImageFloat = float === 'none' ? 'left' : float === 'left' ? 'right' : 'none'
    onFloatChange(next)
  }

  const floatLabel =
    float === 'none' ? 'Wrap text: off' : float === 'left' ? 'Wrap text: float left' : 'Wrap text: float right'

  return (
    <div
      data-image-toolbar="true"
      className="absolute bottom-full left-1/2 z-30 w-max -translate-x-1/2 px-1 pb-1"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseDown={(e) => e.preventDefault()}
      ref={(popover) => {
        const editorRoot = boundaryElement ?? document.getElementById('super-editor-content')
        if (!popover || !editorRoot) {
          return
        }
        const editorRootRect = editorRoot.getBoundingClientRect()
        const popoverRect = popover.getBoundingClientRect()
        const overflows = getOverflows(popoverRect, editorRootRect)
        if (overflows.top > 0) {
          popover.style.setProperty('--tw-translate-y', `${overflows.top}px`)
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-0.5 divide-x divide-border rounded border border-border bg-default shadow-md">
        <div className="flex items-center gap-1 px-1 py-0.5">
          <ImageAlignmentOptions alignment={alignment} changeAlignment={onAlignmentChange} />
        </div>

        <div className="relative flex items-center px-1 py-0.5">
          <StyledTooltip label="Resize">
            <IconButton
              className="rounded p-1 hover:bg-contrast"
              icon={'image' as IconType}
              title="Resize"
              focusable={true}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setShowPresets((v) => !v)
              }}
              onMouseDown={(e) => e.preventDefault()}
            />
          </StyledTooltip>
          {showPresets && (
            <div className="absolute left-0 top-full z-40 mt-1 flex flex-col rounded border border-border bg-default py-1 shadow-md">
              {Presets.map((preset) => (
                <button
                  key={preset}
                  className="px-3 py-1.5 text-left text-sm hover:bg-contrast"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onPresetSelect(preset)
                    setShowPresets(false)
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {ImageSizePresetLabels[preset]}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center px-1 py-0.5">
          <StyledTooltip label={floatLabel}>
            <IconButton
              className={classNames(
                'rounded p-1 hover:bg-contrast',
                float !== 'none' && '!bg-info text-info-contrast',
              )}
              icon={'line-width' as IconType}
              title={floatLabel}
              focusable={true}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                cycleFloat()
              }}
              onMouseDown={(e) => e.preventDefault()}
            />
          </StyledTooltip>
        </div>

        <div className="flex items-center px-1 py-0.5">
          <StyledTooltip label={captionEnabled ? 'Remove caption' : 'Add caption'}>
            <IconButton
              className={classNames(
                'rounded p-1 hover:bg-contrast',
                captionEnabled && '!bg-info text-info-contrast',
              )}
              icon={'text-paragraph-long' as IconType}
              title={captionEnabled ? 'Remove caption' : 'Add caption'}
              focusable={true}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onToggleCaption()
              }}
              onMouseDown={(e) => e.preventDefault()}
            />
          </StyledTooltip>
        </div>
      </div>
    </div>
  )
}
