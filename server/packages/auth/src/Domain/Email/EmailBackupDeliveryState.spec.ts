import {
  InvalidEmailBackupDeliveryStateError,
  PendingEmailBackupBatch,
  emptyEmailBackupDeliveryState,
  parseEmailBackupDeliveryState,
  recordPendingEmailBackupBatch,
  serializeEmailBackupDeliveryState,
} from './EmailBackupDeliveryState'

describe('EmailBackupDeliveryState', () => {
  const deliveryId = (index: number) => `backup-${index.toString(16).padStart(64, '0')}`
  const batch = (index: number): PendingEmailBackupBatch => ({
    batchId: `batch-${index}`,
    outcome: 'backup',
    queuedAt: index,
    deliveries: [
      {
        deliveryId: deliveryId(index),
        queueAccepted: true,
        reference: {
          fileName: `backup-${index}.json`,
          filePath: 'protected-backup-bucket',
          attachmentFileName: `SN-Data-${index}.txt`,
          attachmentContentType: 'application/json',
        },
      },
    ],
  })

  it('reads the legacy completed-only format and upgrades it on serialization', () => {
    const legacy = JSON.stringify({ completed: [{ batchId: 'legacy-batch', deliveredAt: 123 }] })

    const parsed = parseEmailBackupDeliveryState(legacy)

    expect(parsed).toEqual({ pending: [], completed: [{ batchId: 'legacy-batch', deliveredAt: 123 }] })
    expect(serializeEmailBackupDeliveryState(parsed)).toBe(legacy)
  })

  it('round-trips exact pending source references and queue acceptance state', () => {
    const state = recordPendingEmailBackupBatch(emptyEmailBackupDeliveryState(), batch(1))

    expect(parseEmailBackupDeliveryState(serializeEmailBackupDeliveryState(state))).toEqual(state)
  })

  it('fails closed instead of evicting an unresolved batch at capacity', () => {
    let state = emptyEmailBackupDeliveryState()
    for (let index = 0; index < 16; index++) {
      state = recordPendingEmailBackupBatch(state, batch(index))
    }

    expect(() => recordPendingEmailBackupBatch(state, batch(16))).toThrow(InvalidEmailBackupDeliveryStateError)
    expect(state.pending).toHaveLength(16)
  })

  it('rejects oversized serialized state without truncating pending deliveries', () => {
    const oversized: PendingEmailBackupBatch = {
      ...batch(1),
      deliveries: Array.from({ length: 256 }, (_, index) => ({
        deliveryId: deliveryId(index),
        queueAccepted: false,
        reference: {
          fileName: `backup-${index}.json`,
          filePath: `bucket-${'x'.repeat(1_900)}`,
          attachmentFileName: `part-${index}.txt`,
          attachmentContentType: 'application/json',
        },
      })),
    }

    expect(() => serializeEmailBackupDeliveryState({ pending: [oversized], completed: [] })).toThrow(
      InvalidEmailBackupDeliveryStateError,
    )
    expect(oversized.deliveries).toHaveLength(256)
  })

  it('rejects pending state without an explicit queue-acceptance receipt', () => {
    const invalid = JSON.stringify({
      pending: [
        {
          ...batch(1),
          deliveries: batch(1).deliveries.map(({ queueAccepted: _queueAccepted, ...delivery }) => delivery),
        },
      ],
      completed: [],
    })

    expect(() => parseEmailBackupDeliveryState(invalid)).toThrow(InvalidEmailBackupDeliveryStateError)
  })
})
