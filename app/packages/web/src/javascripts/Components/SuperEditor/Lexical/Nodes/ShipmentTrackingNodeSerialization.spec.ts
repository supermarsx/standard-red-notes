/** @jest-environment jsdom */

import { createHeadlessEditor } from '@lexical/headless'
import { EditorConfig } from 'lexical'
import {
  $createShipmentTrackingNode,
  buildGlobalShipmentTrackingUrl,
  isValidTrackingNumber,
  normalizeShipmentTrackingData,
  SerializedShipmentTrackingNode,
  ShipmentTrackingData,
  ShipmentTrackingNode,
} from './ShipmentTrackingNode'

const editor = createHeadlessEditor({
  namespace: 'ShipmentTrackingNodeSerializationTest',
  nodes: [ShipmentTrackingNode],
  onError: (error) => {
    throw error
  },
})

function inEditor<T>(fn: () => T): T {
  let result: T
  editor.update(
    () => {
      result = fn()
    },
    { discrete: true },
  )
  return result!
}

const sampleData: ShipmentTrackingData = {
  version: 1,
  label: 'Replacement keyboard',
  trackingNumber: 'RR123456789CN',
}

describe('ShipmentTrackingNode serialization', () => {
  it('round-trips its stable data without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createShipmentTrackingNode(sampleData).exportJSON()
      const second = ShipmentTrackingNode.importJSON(first).exportJSON()
      return { first, second }
    })

    expect(second).toEqual(first)
    expect(second.type).toBe('shipment-tracking')
    expect(second.version).toBe(1)
    expect(second.data).toEqual(sampleData)
  })

  it('degrades missing or malformed legacy data to an empty editable block', () => {
    const missing = { type: 'shipment-tracking', version: 1 } as unknown as SerializedShipmentTrackingNode
    const malformed = {
      type: 'shipment-tracking',
      version: 1,
      data: 'not-an-object',
    } as unknown as SerializedShipmentTrackingNode

    const result = inEditor(() => ({
      missing: ShipmentTrackingNode.importJSON(missing).exportJSON().data,
      malformed: ShipmentTrackingNode.importJSON(malformed).exportJSON().data,
    }))

    expect(result.missing).toEqual({ version: 1, label: '', trackingNumber: '' })
    expect(result.malformed).toEqual({ version: 1, label: '', trackingNumber: '' })
  })

  it('normalizes copied whitespace and removes formatting controls', () => {
    expect(
      normalizeShipmentTrackingData({
        version: 99,
        label: '  Keyboard\u202E   order  ',
        trackingNumber: ' RR 123 456 789 CN\u0000 ',
      }),
    ).toEqual({
      version: 1,
      label: 'Keyboard order',
      trackingNumber: 'RR123456789CN',
    })
  })

  it('returns defensive data copies', () => {
    inEditor(() => {
      const node = $createShipmentTrackingNode(sampleData)
      const data = node.getData()
      data.label = 'Mutated outside the node'
      expect(node.getData().label).toBe('Replacement keyboard')
    })
  })

  it('normalizes malformed collaborative payloads at every node boundary', () => {
    const result = inEditor(() => {
      const node = $createShipmentTrackingNode(sampleData)
      node.__data = null as unknown as ShipmentTrackingData
      const nullData = {
        clone: ShipmentTrackingNode.clone(node).__data,
        read: node.getData(),
        serialized: node.exportJSON().data,
        text: node.getTextContent(),
        dom: node.exportDOM().element?.textContent,
        decorated: node.decorate(editor, {} as EditorConfig).props.data,
      }

      node.__data = {
        version: 999,
        label: `\u202E${'L'.repeat(100)}`,
        trackingNumber: ` ${'A'.repeat(100)} `,
      }
      const oversizedData = {
        clone: ShipmentTrackingNode.clone(node).__data,
        read: node.getData(),
        serialized: node.exportJSON().data,
        text: node.getTextContent(),
        dom: node.exportDOM().element?.textContent,
        decorated: node.decorate(editor, {} as EditorConfig).props.data,
      }

      return { nullData, oversizedData }
    })

    const empty = { version: 1, label: '', trackingNumber: '' }
    expect(result.nullData).toEqual({
      clone: empty,
      read: empty,
      serialized: empty,
      text: '',
      dom: '',
      decorated: empty,
    })

    const bounded = { version: 1, label: 'L'.repeat(80), trackingNumber: 'A'.repeat(80) }
    expect(result.oversizedData).toEqual({
      clone: bounded,
      read: bounded,
      serialized: bounded,
      text: `${'L'.repeat(80)}: ${'A'.repeat(80)}`,
      dom: `${'L'.repeat(80)}: ${'A'.repeat(80)}`,
      decorated: bounded,
    })
  })

  it('exports only the label and tracking number as text', () => {
    const { text, dom } = inEditor(() => {
      const node = $createShipmentTrackingNode(sampleData)
      return { text: node.getTextContent(), dom: node.exportDOM().element as HTMLElement }
    })

    expect(text).toBe('Replacement keyboard: RR123456789CN')
    expect(text).not.toContain('17track')
    expect(dom.textContent).toBe(text)
    expect(dom.querySelector('a, script, iframe, img')).toBeNull()
  })
})

describe('global shipment tracking link', () => {
  it('uses the exact verified fragment form with URLSearchParams encoding', () => {
    const result = buildGlobalShipmentTrackingUrl(' RR 123 456 789 CN ')
    expect(result).toBe('https://t.17track.net/en#nums=RR123456789CN')

    const url = new URL(result!)
    expect(url.origin).toBe('https://t.17track.net')
    expect(url.pathname).toBe('/en')
    expect(url.search).toBe('')
    expect(url.hash).toBe('#nums=RR123456789CN')
    expect(new URLSearchParams(url.hash.slice(1)).get('nums')).toBe('RR123456789CN')
  })

  it('refuses invalid or injection-like tracking values', () => {
    for (const value of ['', '1234', 'ABC/12345', '<script>alert(1)</script>', 'A'.repeat(51)]) {
      expect(isValidTrackingNumber(value)).toBe(false)
      expect(buildGlobalShipmentTrackingUrl(value)).toBeUndefined()
    }
  })

  it('allows only the documented bounded character set', () => {
    expect(isValidTrackingNumber('1Z-999-AA-10123456784')).toBe(true)
    expect(buildGlobalShipmentTrackingUrl('1Z-999-AA-10123456784')).toBe(
      'https://t.17track.net/en#nums=1Z-999-AA-10123456784',
    )
  })
})
