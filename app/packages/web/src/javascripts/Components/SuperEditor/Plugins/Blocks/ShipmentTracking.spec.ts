import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $getRoot } from 'lexical'
import { $isShipmentTrackingNode, ShipmentTrackingNode } from '../../Lexical/Nodes/ShipmentTrackingNode'
import { ShipmentTrackingBlock } from './ShipmentTracking'

describe('ShipmentTrackingBlock', () => {
  it('advertises shipment lookup terms in the shared insert surfaces', () => {
    expect(ShipmentTrackingBlock.name).toBe('Shipment Tracking')
    expect(ShipmentTrackingBlock.iconName).toBe('box')
    expect(ShipmentTrackingBlock.keywords).toEqual(
      expect.arrayContaining(['shipment', 'tracking number', 'parcel', 'package', 'delivery']),
    )
  })

  it('inserts an empty editable ShipmentTrackingNode at the current selection', () => {
    const editor = createHeadlessEditor({
      namespace: 'ShipmentTrackingBlockInsertionTest',
      nodes: [ShipmentTrackingNode],
      onError: (error) => {
        throw error
      },
    })

    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        $getRoot().append(paragraph)
        paragraph.selectEnd()
      },
      { discrete: true },
    )

    ShipmentTrackingBlock.onSelect(editor)
    editor.update(() => undefined, { discrete: true })

    editor.getEditorState().read(() => {
      const shipmentNode = $getRoot()
        .getChildren()
        .find((node) => $isShipmentTrackingNode(node))
      expect(shipmentNode).toBeDefined()
      expect(shipmentNode?.getData()).toEqual({ version: 1, label: '', trackingNumber: '' })
    })
  })
})
