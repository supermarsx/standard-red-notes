import { Spread } from 'lexical'
import { SerializedDecoratorBlockNode } from '@lexical/react/LexicalDecoratorBlockNode'
import { ImageFloat } from '../../ImageTools/ImageToolsTypes'

export type SerializedFileNode = Spread<
  {
    fileUuid: string
    zoomLevel: number
    /** Explicit pixel width set via the Word-style resizer; undefined = natural / zoomLevel. */
    width?: number
    /** Optional caption rendered under the image. */
    caption?: string
    /** Margin-based float within the node's own block (not true text-wrap). */
    float?: ImageFloat
  },
  SerializedDecoratorBlockNode
>
