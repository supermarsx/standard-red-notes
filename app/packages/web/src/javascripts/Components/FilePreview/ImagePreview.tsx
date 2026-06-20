import { IconType, PrefKey } from '@standardnotes/snjs'
import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import IconButton from '@/Components/Button/IconButton'
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

type Props = {
  objectUrl: string
  isEmbeddedInSuper: boolean
} & OptionalSuperEmbeddedImageProps

const MinimumZoomPercent = 10
const DefaultZoomPercent = 100
const MaximumZoomPercent = 1000
const ZoomPercentModifier = 10
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
  const [isZoomInputVisible, setIsZoomInputVisible] = useState(false)

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

  const setImageZoom = useCallback(
    (zoomLevel: number) => {
      setImageZoomPercent(zoomLevel)
      setImageZoomLevel?.(zoomLevel)
    },
    [setImageZoomLevel],
  )

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

  const imageResizer = (
    <>
      <span className="mr-1.5">{isEmbeddedInSuper ? 'Size' : 'Zoom'}:</span>
      <IconButton
        className="rounded p-1 hover:bg-contrast"
        icon={'subtract' as IconType}
        title={isEmbeddedInSuper ? 'Decrease size' : 'Zoom Out'}
        focusable={true}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const newPercent = imageZoomPercent - ZoomPercentModifier
          if (newPercent >= ZoomPercentModifier) {
            setImageZoom(newPercent)
          } else {
            setImageZoom(imageZoomPercent)
          }
        }}
        onMouseDown={(e) => {
          e.preventDefault()
        }}
      />
      {isZoomInputVisible ? (
        <div className="mx-2">
          <input
            type="number"
            className="w-10 bg-default text-center"
            defaultValue={imageZoomPercent}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                const value = parseInt(event.currentTarget.value)
                if (value >= MinimumZoomPercent && value <= MaximumZoomPercent) {
                  setImageZoom(value)
                }
                setIsZoomInputVisible(false)
              }
            }}
            onBlur={(event) => {
              setIsZoomInputVisible(false)
              const value = parseInt(event.currentTarget.value)
              if (value >= MinimumZoomPercent && value <= MaximumZoomPercent) {
                setImageZoom(value)
              }
            }}
          />
          %
        </div>
      ) : (
        <button
          className="mx-1 rounded px-1.5 py-1 hover:bg-contrast"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setIsZoomInputVisible((visible) => !visible)
          }}
        >
          {imageZoomPercent}%
        </button>
      )}
      <IconButton
        className="rounded p-1 hover:bg-contrast"
        icon="add"
        title={isEmbeddedInSuper ? 'Increase size' : 'Zoom In'}
        focusable={true}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setImageZoom(imageZoomPercent + ZoomPercentModifier)
        }}
        onMouseDown={(e) => {
          e.preventDefault()
        }}
      />
    </>
  )

  const defaultSuperImageAlignment = usePreference(PrefKey.SuperNoteImageAlignment)
  const finalAlignment = alignment || defaultSuperImageAlignment
  // When the image is floated, alignment is expressed via the CSS float (left/right
  // within the node's own block); otherwise we use flex justify for left/center/right.
  const isFloating = isEmbeddedInSuper && float !== 'none'
  const justifyContent = isEmbeddedInSuper
    ? isFloating
      ? float === 'left'
        ? 'start'
        : 'end'
      : getCSSValueFromAlignment(finalAlignment)
    : 'center'

  // The new Word-style toolbar is shown when the embedding decorator node is
  // selected; it also stays available on hover/focus for discoverability.
  const showSuperToolbar = isEmbeddedInSuper && !!changeAlignment

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
        className={
          isEmbeddedInSuper
            ? 'relative flex h-full items-center justify-center overflow-visible'
            : 'relative flex h-full w-full items-center justify-center overflow-auto'
        }
        style={{
          width: isEmbeddedInSuper ? `${widthIfEmbedded}px` : '',
          maxWidth: isEmbeddedInSuper ? '100%' : undefined,
          aspectRatio: isEmbeddedInSuper ? `${imageWidth} / ${imageHeight}` : '',
        }}
      >
        <img
          src={objectUrl}
          className={isEmbeddedInSuper ? 'h-full w-full' : undefined}
          style={{
            height: isEmbeddedInSuper ? '100%' : `${imageZoomPercent}%`,
            ...(isEmbeddedInSuper
              ? {}
              : imageZoomPercent <= DefaultZoomPercent
                ? {
                    minWidth: '100%',
                    objectFit: 'contain',
                  }
                : {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    margin: 'auto',
                    maxWidth: 'none',
                  }),
          }}
        />
        {isEmbeddedInSuper && (
          <ImageResizer
            active={isImageSelected}
            targetRef={resizeWrapperRef}
            onResize={handleResize}
            onResizeEnd={handleResizeEnd}
          />
        )}
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
        {isEmbeddedInSuper && (
          <div className="absolute left-0 top-full w-full">
            <ImageCaption caption={caption ?? ''} enabled={captionEnabled} onChange={(c) => setCaption?.(c)} />
          </div>
        )}
      </div>
      {!isEmbeddedInSuper && (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center rounded border border-solid border-border bg-default px-3 py-1">
          {imageResizer}
        </div>
      )}
    </div>
  )
}

export default ImagePreview
