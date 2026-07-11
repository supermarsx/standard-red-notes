import { $setBlocksType } from '@lexical/selection'
import { $getSelection, $isRangeSelection, LexicalEditor } from 'lexical'
import { $createHeadingNode } from '@lexical/rich-text'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'

export const H1Block = {
  name: 'Heading 1',
  iconName: 'h1',
  keywords: ['heading', 'header', 'h1'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode('h1'))
      }
    }),
}

export function GetH1BlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(H1Block.name, {
    iconName: H1Block.iconName as LexicalIconName,
    keywords: H1Block.keywords,
    onSelect: () => H1Block.onSelect(editor),
  })
}

export const H2Block = {
  name: 'Heading 2',
  iconName: 'h2',
  keywords: ['heading', 'header', 'h2'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode('h2'))
      }
    }),
}

export function GetH2BlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(H2Block.name, {
    iconName: H2Block.iconName as LexicalIconName,
    keywords: H2Block.keywords,
    onSelect: () => H2Block.onSelect(editor),
  })
}

export const H3Block = {
  name: 'Heading 3',
  iconName: 'h3',
  keywords: ['heading', 'header', 'h3'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode('h3'))
      }
    }),
}

export function GetH3BlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(H3Block.name, {
    iconName: H3Block.iconName as LexicalIconName,
    keywords: H3Block.keywords,
    onSelect: () => H3Block.onSelect(editor),
  })
}

export const H4Block = {
  name: 'Heading 4',
  iconName: 'h4',
  keywords: ['heading', 'header', 'h4'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode('h4'))
      }
    }),
}

export function GetH4BlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(H4Block.name, {
    iconName: H4Block.iconName as LexicalIconName,
    keywords: H4Block.keywords,
    onSelect: () => H4Block.onSelect(editor),
  })
}

export const H5Block = {
  name: 'Heading 5',
  iconName: 'h5',
  keywords: ['heading', 'header', 'h5'],
  onSelect: (editor: LexicalEditor) =>
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode('h5'))
      }
    }),
}

export function GetH5BlockOption(editor: LexicalEditor) {
  return new BlockPickerOption(H5Block.name, {
    iconName: H5Block.iconName as LexicalIconName,
    keywords: H5Block.keywords,
    onSelect: () => H5Block.onSelect(editor),
  })
}
