import { TransferPayload } from '@standardnotes/models'
import { SyncEvent } from '../Event/SyncEvent'

import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { ItemsServerInterface } from '../Item/ItemsServerInterface'
import { SyncSource } from '../Sync/SyncSource'
import { IntegrityApiInterface } from './IntegrityApiInterface'
import { IntegrityService } from './IntegrityService'
import { PayloadManagerInterface } from '../Payloads/PayloadManagerInterface'
import { IntegrityPayload } from '@standardnotes/responses'
import { LoggerInterface } from '@standardnotes/utils'

describe('IntegrityService', () => {
  let integrityApi: IntegrityApiInterface
  let itemApi: ItemsServerInterface
  let payloadManager: PayloadManagerInterface
  let logger: LoggerInterface
  let internalEventBus: InternalEventBusInterface

  const createService = () => new IntegrityService(integrityApi, itemApi, payloadManager, logger, internalEventBus)

  beforeEach(() => {
    integrityApi = {} as jest.Mocked<IntegrityApiInterface>
    integrityApi.checkIntegrity = jest.fn()

    itemApi = {} as jest.Mocked<ItemsServerInterface>
    itemApi.getSingleItem = jest.fn()

    payloadManager = {} as jest.Mocked<PayloadManagerInterface>
    payloadManager.integrityPayloads = []

    internalEventBus = {} as jest.Mocked<InternalEventBusInterface>
    internalEventBus.publishSync = jest.fn()

    logger = {} as jest.Mocked<LoggerInterface>
    logger.info = jest.fn()
    logger.error = jest.fn()
  })

  it('should check integrity of payloads and publish mismatches', async () => {
    integrityApi.checkIntegrity = jest.fn().mockReturnValue({
      data: {
        mismatches: [{ uuid: '1-2-3', updated_at_timestamp: 234 } as IntegrityPayload],
      },
    })
    itemApi.getSingleItem = jest.fn().mockReturnValue({
      data: {
        item: {
          uuid: '1-2-3',
          content: 'foobar',
        } as Partial<TransferPayload>,
      },
    })

    await createService().handleEvent({
      type: SyncEvent.SyncRequestsIntegrityCheck,
      payload: {
        integrityPayloads: [{ uuid: '1-2-3', updated_at_timestamp: 123 } as IntegrityPayload],
        source: SyncSource.AfterDownloadFirst,
      },
    })

    expect(internalEventBus.publishSync).toHaveBeenCalledWith(
      {
        payload: {
          rawPayloads: [
            {
              content: 'foobar',
              uuid: '1-2-3',
            },
          ],
          source: 'AfterDownloadFirst',
        },
        type: 'IntegrityCheckCompleted',
      },
      'SEQUENCE',
    )
  })

  it('should publish empty mismatches if everything is in sync', async () => {
    integrityApi.checkIntegrity = jest.fn().mockReturnValue({
      data: {
        mismatches: [],
      },
    })

    await createService().handleEvent({
      type: SyncEvent.SyncRequestsIntegrityCheck,
      payload: {
        integrityPayloads: [{ uuid: '1-2-3', updated_at_timestamp: 123 } as IntegrityPayload],
        source: SyncSource.AfterDownloadFirst,
      },
    })

    expect(internalEventBus.publishSync).toHaveBeenCalledWith(
      {
        payload: {
          rawPayloads: [],
          source: 'AfterDownloadFirst',
        },
        type: 'IntegrityCheckCompleted',
      },
      'SEQUENCE',
    )
  })

  it('should not publish mismatches if checking integrity fails', async () => {
    integrityApi.checkIntegrity = jest.fn().mockReturnValue({
      data: {
        error: 'Ooops',
      },
    })

    await createService().handleEvent({
      type: SyncEvent.SyncRequestsIntegrityCheck,
      payload: {
        integrityPayloads: [{ uuid: '1-2-3', updated_at_timestamp: 123 } as IntegrityPayload],
        source: SyncSource.AfterDownloadFirst,
      },
    })

    expect(internalEventBus.publishSync).not.toHaveBeenCalled()
  })

  it('should publish empty mismatches if fetching items fails', async () => {
    integrityApi.checkIntegrity = jest.fn().mockReturnValue({
      data: {
        mismatches: [{ uuid: '1-2-3', updated_at_timestamp: 234 } as IntegrityPayload],
      },
    })
    itemApi.getSingleItem = jest.fn().mockReturnValue({
      data: {
        error: 'Ooops',
      },
    })

    await createService().handleEvent({
      type: SyncEvent.SyncRequestsIntegrityCheck,
      payload: {
        integrityPayloads: [{ uuid: '1-2-3', updated_at_timestamp: 123 } as IntegrityPayload],
        source: SyncSource.AfterDownloadFirst,
      },
    })

    expect(internalEventBus.publishSync).toHaveBeenCalledWith(
      {
        payload: {
          rawPayloads: [],
          source: 'AfterDownloadFirst',
        },
        type: 'IntegrityCheckCompleted',
      },
      'SEQUENCE',
    )
  })

  const checkEvent = () => ({
    type: SyncEvent.SyncRequestsIntegrityCheck,
    payload: {
      integrityPayloads: [{ uuid: '1-2-3', updated_at_timestamp: 123 } as IntegrityPayload],
      source: SyncSource.AfterDownloadFirst,
    },
  })

  const mismatchesFor = (uuids: string[]) =>
    uuids.map((uuid) => ({ uuid, updated_at_timestamp: 234 }) as IntegrityPayload)

  it('should stop fetching items once a repair round reconciles nothing', async () => {
    // The same mismatch set coming back means the previous round's fetches achieved nothing.
    // Fetching them again cannot help, and re-arming would repeat it for the life of the tab.
    integrityApi.checkIntegrity = jest.fn().mockReturnValue({ data: { mismatches: mismatchesFor(['a', 'b']) } })
    itemApi.getSingleItem = jest.fn().mockImplementation((uuid: string) => ({ data: { item: { uuid } } }))

    const service = createService()
    await service.handleEvent(checkEvent())
    expect(itemApi.getSingleItem).toHaveBeenCalledTimes(2)

    await service.handleEvent(checkEvent())

    expect(itemApi.getSingleItem).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not converging'))
    expect(internalEventBus.publishSync).toHaveBeenLastCalledWith(
      { payload: { rawPayloads: [], source: 'AfterDownloadFirst' }, type: 'IntegrityCheckCompleted' },
      'SEQUENCE',
    )
  })

  it('should keep repairing while the mismatch set is shrinking', async () => {
    integrityApi.checkIntegrity = jest
      .fn()
      .mockReturnValueOnce({ data: { mismatches: mismatchesFor(['a', 'b', 'c']) } })
      .mockReturnValueOnce({ data: { mismatches: mismatchesFor(['c']) } })
    itemApi.getSingleItem = jest.fn().mockImplementation((uuid: string) => ({ data: { item: { uuid } } }))

    const service = createService()
    await service.handleEvent(checkEvent())
    await service.handleEvent(checkEvent())

    expect(itemApi.getSingleItem).toHaveBeenCalledTimes(4)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should resume repairing after the account comes back into sync', async () => {
    integrityApi.checkIntegrity = jest
      .fn()
      .mockReturnValueOnce({ data: { mismatches: mismatchesFor(['a']) } })
      .mockReturnValueOnce({ data: { mismatches: [] } })
      .mockReturnValueOnce({ data: { mismatches: mismatchesFor(['a']) } })
    itemApi.getSingleItem = jest.fn().mockImplementation((uuid: string) => ({ data: { item: { uuid } } }))

    const service = createService()
    await service.handleEvent(checkEvent())
    await service.handleEvent(checkEvent())
    await service.handleEvent(checkEvent())

    // A clean check clears the stall memory, so a genuinely new mismatch is still repaired.
    expect(itemApi.getSingleItem).toHaveBeenCalledTimes(2)
  })

  it('should bound how many item requests are in flight at once', async () => {
    const uuids = Array.from({ length: 40 }, (_, index) => `uuid-${index}`)
    integrityApi.checkIntegrity = jest.fn().mockReturnValue({ data: { mismatches: mismatchesFor(uuids) } })

    let inFlight = 0
    let peakInFlight = 0
    itemApi.getSingleItem = jest.fn().mockImplementation(async (uuid: string) => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return { data: { item: { uuid } } }
    })

    await createService().handleEvent(checkEvent())

    expect(itemApi.getSingleItem).toHaveBeenCalledTimes(40)
    expect(peakInFlight).toBeLessThanOrEqual(8)
  })

  it('should not handle different event types', async () => {
    await createService().handleEvent({
      type: SyncEvent.SyncCompletedWithAllItemsUploaded,
      payload: {
        integrityPayloads: [{ uuid: '1-2-3', updated_at_timestamp: 123 } as IntegrityPayload],
        source: SyncSource.AfterDownloadFirst,
      },
    })

    expect(integrityApi.checkIntegrity).not.toHaveBeenCalled()
    expect(itemApi.getSingleItem).not.toHaveBeenCalled()
    expect(internalEventBus.publishSync).not.toHaveBeenCalled()
  })
})
