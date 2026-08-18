import type { LexicalNode } from 'lexical'

import { FileNode } from './FileNode'

export function $createFileNode(fileUuid: string): FileNode {
  return new FileNode(fileUuid)
}

export function $isFileNode(node: FileNode | LexicalNode | null | undefined): node is FileNode {
  return node instanceof FileNode
}
