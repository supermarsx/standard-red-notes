import { ElementFormatType } from 'lexical'
import { ImageFloat } from '../SuperEditor/Plugins/ImageTools/ImageToolsTypes'

export type OptionalSuperEmbeddedImageProps = {
  imageZoomLevel?: number
  setImageZoomLevel?: (zoomLevel: number) => void
  alignment?: ElementFormatType | null
  changeAlignment?: (alignment: ElementFormatType) => void
  // Word-style image tools (only supplied for Super-embedded images).
  imageWidth?: number
  setImageWidth?: (width: number | undefined) => void
  caption?: string
  setCaption?: (caption: string | undefined) => void
  float?: ImageFloat
  setFloat?: (float: ImageFloat) => void
  /** Whether the embedding decorator node is currently selected (drives toolbar/handles). */
  isImageSelected?: boolean
}
