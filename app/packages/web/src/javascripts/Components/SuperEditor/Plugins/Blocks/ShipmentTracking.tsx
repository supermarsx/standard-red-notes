import { IconType } from '@standardnotes/snjs'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { LexicalEditor } from 'lexical'
import { $createShipmentTrackingNode } from '../../Lexical/Nodes/ShipmentTrackingNode'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'

export const ShipmentTrackingBlock = {
  name: 'Shipment Tracking',
  iconName: 'box' as IconType,
  keywords: ['shipment', 'shipping', 'tracking', 'tracking number', 'parcel', 'package', 'delivery', 'courier'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createShipmentTrackingNode())
    }),
}

export function GetShipmentTrackingBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(ShipmentTrackingBlock.name, {
    iconName: ShipmentTrackingBlock.iconName,
    keywords: ShipmentTrackingBlock.keywords,
    onSelect: () => ShipmentTrackingBlock.onSelect(editor),
  })
}
