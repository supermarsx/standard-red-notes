import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createStockChartNode } from '../../Lexical/Nodes/StockChartNode'

export const StockChartBlock = {
  name: 'Stock Chart',
  // No dedicated chart icon exists in the icon set; `line-width` reads as a
  // chart/trend line, the closest semantic match for a price chart with ranges.
  iconName: 'line-width' as LexicalIconName,
  keywords: ['stock', 'chart', 'price', 'finance', 'ticker', 'market', 'yahoo', 'range', 'ytd'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createStockChartNode())
    }),
}

export function GetStockChartBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(StockChartBlock.name, {
    iconName: StockChartBlock.iconName,
    keywords: StockChartBlock.keywords,
    onSelect: () => StockChartBlock.onSelect(editor),
  })
}
