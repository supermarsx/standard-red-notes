import { LexicalEditor } from 'lexical'
import { $insertNodeToNearestRoot } from '@lexical/utils'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { $createQrCodeNode } from '../../Lexical/Nodes/QrCodeNode'

export const QrCodeBlock = {
  name: 'QR Code',
  // No dedicated qr/barcode/scan icon exists in the icon set; `link` is the
  // closest semantic match (QR codes most commonly encode URLs/links).
  iconName: 'link' as LexicalIconName,
  keywords: ['qr', 'qrcode', 'barcode', 'link', 'url', 'scan', 'code'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      $insertNodeToNearestRoot($createQrCodeNode())
    }),
}

export function GetQrCodeBlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(QrCodeBlock.name, {
    iconName: QrCodeBlock.iconName,
    keywords: QrCodeBlock.keywords,
    onSelect: () => QrCodeBlock.onSelect(editor),
  })
}
