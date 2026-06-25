import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { IconType } from '@standardnotes/snjs'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { $createWebEmbedNode } from '../../Lexical/Nodes/WebEmbedNode'
import { achievements, METRICS } from '@/Achievements'

export const WebEmbedBlock = {
  name: 'Embed website',
  iconName: 'window' as IconType,
  keywords: ['web', 'website', 'page', 'embed', 'iframe', 'url', 'link', 'browser'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createWebEmbedNode())
      achievements.increment(METRICS.embeddedWebsitesTotal)
    }),
}

export function GetWebEmbedBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(WebEmbedBlock.name, {
    iconName: WebEmbedBlock.iconName,
    keywords: WebEmbedBlock.keywords,
    onSelect: () => WebEmbedBlock.onSelect(editor),
  })
}
