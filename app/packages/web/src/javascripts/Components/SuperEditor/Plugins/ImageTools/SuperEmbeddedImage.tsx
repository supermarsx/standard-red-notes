import { PrefKey } from '@standardnotes/snjs'
import { ElementFormatType } from 'lexical'
import { useCallback, useEffect, useRef, useState } from 'react'
import usePreference from '@/Hooks/usePreference'
import { getCSSValueFromAlignment } from '@/Components/FilePreview/ImageAlignmentOptions'
import { ElementIds } from '@/Constants/ElementIDs'
import ImageResizer from './ImageResizer'
import ImageToolbar from './ImageToolbar'
import ImageCaption from './ImageCaption'
import { clampImageWidth, ImageFloat, ImageSizePreset, widthForPreset } from './ImageToolsTypes'

type Props = {
  src: string
  alt?: string
  /** Current alignment ('' falls back to the user's default alignment preference). */
  alignment: ElementFormatType
  onAlignmentChange: (format: ElementFormatType) => void
  width: number | undefined
  onWidthChange: (width: number | undefined) => void
  caption: string | undefined
  onCaptionChange: (caption: string | undefined) => void
  float: ImageFloat
  onFloatChange: (float: ImageFloat) => void
  isSelected: boolean
  onImageLoad?: () => void
}

/**
 * Shared renderer for Super-embedded images that are NOT FileNode-backed
 * (RemoteImageNode + InlineFileNode). Provides the same Word-style tools as the
 * FileNode path (ImagePreview): resize handles, size presets, alignment, float
 * and an optional caption. Keeps a single implementation so all three image
 * node types behave identically.
 *
 * See ImageToolsTypes for the text-wrap limitation (these are block decorator
 * nodes; float is margin-based within the node's own block, not true wrap).
 */
export default function SuperEmbeddedImage({
  src,
  alt,
  alignment,
  onAlignmentChange,
  width,
  onWidthChange,
  caption,
  onCaptionChange,
  float,
  onFloatChange,
  isSelected,
  onImageLoad,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [liveWidth, setLiveWidth] = useState<number | undefined>(width)
  const [captionEnabled, setCaptionEnabled] = useState<boolean>(() => !!caption)

  useEffect(() => {
    setLiveWidth(width)
  }, [width])

  useEffect(() => {
    if (caption) {
      setCaptionEnabled(true)
    }
  }, [caption])

  const defaultAlignment = usePreference(PrefKey.SuperNoteImageAlignment)
  const finalAlignment = alignment || defaultAlignment

  const isFloating = float !== 'none'
  const alignItems = isFloating ? (float === 'left' ? 'start' : 'end') : getCSSValueFromAlignment(finalAlignment)

  const handleResize = useCallback((w: number) => {
    setLiveWidth(w)
  }, [])

  const handleResizeEnd = useCallback(
    (w: number) => {
      setLiveWidth(w)
      onWidthChange(clampImageWidth(w))
    },
    [onWidthChange],
  )

  const handlePresetSelect = useCallback(
    (preset: ImageSizePreset) => {
      const w = widthForPreset(preset)
      setLiveWidth(w)
      onWidthChange(w)
    },
    [onWidthChange],
  )

  const handleToggleCaption = useCallback(() => {
    setCaptionEnabled((enabled) => {
      const next = !enabled
      if (!next) {
        onCaptionChange(undefined)
      }
      return next
    })
  }, [onCaptionChange])

  return (
    <div className="group relative flex w-full flex-col" style={{ alignItems }}>
      <div
        ref={wrapperRef}
        className="relative inline-block max-w-full overflow-visible"
        style={{ width: liveWidth ? `${liveWidth}px` : undefined, maxWidth: '100%' }}
      >
        <img className="block h-auto w-full max-w-full" alt={alt} src={src} onLoad={onImageLoad} />
        <ImageResizer
          active={isSelected}
          targetRef={wrapperRef}
          onResize={handleResize}
          onResizeEnd={handleResizeEnd}
        />
        <div
          className={
            isSelected
              ? 'visible'
              : 'invisible focus-within:visible group-hover:visible [.embedBlockFocused_&]:visible'
          }
        >
          <ImageToolbar
            visible={true}
            alignment={finalAlignment}
            onAlignmentChange={onAlignmentChange}
            onPresetSelect={handlePresetSelect}
            float={float}
            onFloatChange={onFloatChange}
            captionEnabled={captionEnabled}
            onToggleCaption={handleToggleCaption}
            boundaryElement={document.getElementById(ElementIds.SuperEditorContent)}
          />
        </div>
        <ImageCaption caption={caption ?? ''} enabled={captionEnabled} onChange={onCaptionChange} />
      </div>
    </div>
  )
}
