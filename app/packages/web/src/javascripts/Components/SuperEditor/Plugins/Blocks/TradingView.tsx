import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createTradingViewNode } from '../../Lexical/Nodes/TradingViewNode'

export const TradingViewBlock = {
  name: 'TradingView Chart',
  // No dedicated chart/finance icon exists in the icon set; `dashboard` is the
  // closest semantic match for a live market chart.
  iconName: 'dashboard' as LexicalIconName,
  keywords: ['tradingview', 'chart', 'stock', 'crypto', 'finance', 'ticker', 'market', 'trading'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createTradingViewNode())
    }),
}

export function GetTradingViewBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(TradingViewBlock.name, {
    iconName: TradingViewBlock.iconName,
    keywords: TradingViewBlock.keywords,
    onSelect: () => TradingViewBlock.onSelect(editor),
  })
}
