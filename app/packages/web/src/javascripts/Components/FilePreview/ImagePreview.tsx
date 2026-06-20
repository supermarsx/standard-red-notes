import { PrefKey } from '@standardnotes/snjs'
import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import { OptionalSuperEmbeddedImageProps } from './OptionalSuperEmbeddedImageProps'
import usePreference from '@/Hooks/usePreference'
import { getCSSValueFromAlignment } from './ImageAlignmentOptions'
import { ElementIds } from '../../Constants/ElementIDs'
import ImageResizer from '@/Components/SuperEditor/Plugins/ImageTools/ImageResizer'
import ImageToolbar from '@/Components/SuperEditor/Plugins/ImageTools/ImageToolbar'
import ImageCaption from '@/Components/SuperEditor/Plugins/ImageTools/ImageCaption'
import {
  clampImageWidth,
  ImageSizePreset,
  widthForPreset,
} from '@/Components/SuperEditor/Plugins/ImageTools/ImageToolsTypes'
import ZoomableImage from './ZoomableImage'

type Props = {
  objectUrl: string
  isEmbeddedInSuper: boolean
} & OptionalSuperEmbeddedImageProps

const DefaultZoomPercent = 100
const PercentageDivisor = 100

const ImagePreview: FunctionComponent<Props> = ({
  objectUrl,
  isEmbeddedInSuper,
  imageZoomLevel,
  setImageZoomLevel,
  alignment,
  changeAlignment,
  imageWidth: persistedWidth,
  setImageWidth: persistImageWidth,
  caption,
  setCaption,
  float = 'none',
  setFloat,
  isImageSelected = false,
}) => {
  const [imageWidth, setImageWidth] = useState(0)
  const [imageHeight, setImageHeight] = useState<number>(0)
  const [imageZoomPercent, setImageZoomPercent] = useState(imageZoomLevel ? imageZoomLevel : DefaultZoomPercent)
  const defaultSuperImageAlignment = usePreference(PrefKey.SuperNoteImageAlignment)

  // Word-style tools state. `liveWidth` reflects an in-progress drag for instant
  // visual feedback; the value is persisted to the node only on drag end.
  const resizeWrapperRef = useRef<HTMLDivElement>(null)
  const [liveWidth, setLiveWidth] = useState<number | undefined>(persistedWidth)
  const [captionEnabled, setCaptionEnabled] = useState<boolean>(() => !!caption)

  useEffect(() => {
    setLiveWidth(persistedWidth)
  }, [persistedWidth])

  useEffect(() => {
    if (caption) {
      setCaptionEnabled(true)
    }
  }, [caption])

  useEffect(() => {
    setImageZoomPercent(imageZoomLevel ? imageZoomLevel : DefaultZoomPercent)
  }, [imageZoomLevel])

  useEffect(() => {
    const image = new Image()
    image.src = objectUrl
    image.onload = () => {
      setImageWidth(image.width)
      setImageHeight(image.height)
    }
  }, [objectUrl])

  // Effective embedded width: an explicit px width (from the Word-style resizer /
  // presets) takes precedence; otherwise we fall back to the legacy zoom-percent
  // sizing so existing notes keep rendering exactly as before.
  const effectiveWidth = liveWidth ?? imageWidth * (imageZoomPercent / PercentageDivisor)
  const widthIfEmbedded = effectiveWidth

  const handleResize = useCallback((width: number) => {
    setLiveWidth(width)
  }, [])

  const handleResizeEnd = useCallback(
    (width: number) => {
      setLiveWidth(width)
      persistImageWidth?.(clampImageWidth(width))
    },
    [persistImageWidth],
  )

  const handlePresetSelect = useCallback(
    (preset: ImageSizePreset) => {
      const width = widthForPreset(preset)
      setLiveWidth(width)
      persistImageWidth?.(width)
    },
    [persistImageWidth],
  )

  const handleToggleCaption = useCallback(() => {
    setCaptionEnabled((enabled) => {
      const next = !enabled
      // Turning the caption off clears any stored text.
      if (!next) {
        setCaption?.(undefined)
      }
      return next
    })
  }, [setCaption])

  // Non-embedded preview (the full-screen file lightbox) gets a proper
  // pan/zoom viewport: wheel zoom centred on the cursor, drag-to-pan, pinch on
  // touch, double-click to toggle, and fit/1:1/+/- controls. The embedded Super
  // case keeps the in-document Word-style resizer below.
  if (!isEmbeddedInSuper) {
    return <ZoomableImage objectUrl={objectUrl} />
  }

  const finalAlignment = alignment || defaultSuperImageAlignment
  // When the image is floated, alignment is expressed via the CSS float (left/right
  // within the node's own block); otherwise we use flex justify for left/center/right.
  const isFloating = float !== 'none'
  const justifyContent = isFloating
    ? float === 'left'
      ? 'start'
      : 'end'
    : getCSSValueFromAlignment(finalAlignment)

  // The new Word-style toolbar is shown when the embedding decorator node is
  // selected; it also stays available on hover/focus for discoverability.
  const showSuperToolbar = !!changeAlignment

  return (
    <div
      className="group relative flex h-full min-h-0 w-full items-center"
      style={{ justifyContent }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        ref={resizeWrapperRef}
        className="relative flex h-full items-center justify-center overflow-visible"
        style={{
          width: `${widthIfEmbedded}px`,
          maxWidth: '100%',
          aspectRatio: `${imageWidth} / ${imageHeight}`,
        }}
      >
        <img src={objectUrl} className="h-full w-full" style={{ height: '100%' }} />
        <ImageResizer
          active={isImageSelected}
          targetRef={resizeWrapperRef}
          onResize={handleResize}
          onResizeEnd={handleResizeEnd}
        />
        {showSuperToolbar && (
          <div
            className={
              isImageSelected
                ? 'visible'
                : 'invisible focus-within:visible group-hover:visible [.embedBlockFocused_&]:visible'
            }
          >
            <ImageToolbar
              visible={true}
              alignment={finalAlignment}
              onAlignmentChange={changeAlignment!}
              onPresetSelect={handlePresetSelect}
              float={float}
              onFloatChange={(next) => setFloat?.(next)}
              captionEnabled={captionEnabled}
              onToggleCaption={handleToggleCaption}
              boundaryElement={document.getElementById(ElementIds.SuperEditorContent)}
            />
          </div>
        )}
        <div className="absolute left-0 top-full w-full">
          <ImageCaption caption={caption ?? ''} enabled={captionEnabled} onChange={(c) => setCaption?.(c)} />
        </div>
      </div>
    </div>
  )
}

export default ImagePreview
