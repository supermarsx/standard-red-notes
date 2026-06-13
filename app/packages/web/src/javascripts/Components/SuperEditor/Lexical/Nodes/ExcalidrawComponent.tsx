import * as React from 'react'
import { useCallback, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { $getNodeByKey, NodeKey } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $isExcalidrawNode, ExcalidrawSceneData } from './ExcalidrawNode'

export default function ExcalidrawComponent({
  data,
  nodeKey,
}: {
  data: ExcalidrawSceneData
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [expanded, setExpanded] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const onChange = useCallback(
    (elements: readonly unknown[], appState: { viewBackgroundColor?: string }, files: unknown) => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        const scene: ExcalidrawSceneData = {
          elements: elements as ExcalidrawSceneData['elements'],
          files: files as ExcalidrawSceneData['files'],
          appState: { viewBackgroundColor: appState.viewBackgroundColor ?? '#ffffff' },
        }
        editor.update(() => {
          const node = $getNodeByKey(nodeKey)
          if ($isExcalidrawNode(node)) {
            node.setData(scene)
          }
        })
      }, 600)
    },
    [editor, nodeKey],
  )

  return (
    <div className="my-2 rounded border border-border bg-default" data-excalidraw-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Drawing</span>
        <button
          className="rounded px-2 py-0.5 hover:bg-contrast"
          type="button"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <div style={{ height: expanded ? 640 : 420 }}>
        <Excalidraw
          initialData={{
            elements: (data.elements ?? []) as never,
            appState: { viewBackgroundColor: data.appState?.viewBackgroundColor ?? '#ffffff' } as never,
            files: (data.files ?? {}) as never,
            scrollToContent: true,
          }}
          onChange={onChange as never}
        />
      </div>
    </div>
  )
}
