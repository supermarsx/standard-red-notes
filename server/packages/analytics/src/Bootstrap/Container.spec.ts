import 'reflect-metadata'

import { SNSClient } from '@aws-sdk/client-sns'
import { SQSClient } from '@aws-sdk/client-sqs'
import { Container } from 'inversify'

import { RedisAnalyticsStore } from '../Infra/Redis/RedisAnalyticsStore'
import { RedisStatisticsStore } from '../Infra/Redis/RedisStatisticsStore'

import TYPES from './Types'

jest.mock('dotenv', () => ({
  config: jest.fn().mockReturnValue({ parsed: {} }),
}))

const redisConstructor = jest.fn()
const redisClusterConstructor = jest.fn()

jest.mock('ioredis', () => {
  class Redis {
    static Cluster = class Cluster {
      constructor(nodes: string[]) {
        redisClusterConstructor(nodes)
      }
    }

    constructor(url: string) {
      redisConstructor(url)
    }
  }

  return { __esModule: true, default: Redis }
})

const mixpanelInit = jest.fn().mockReturnValue({ track: jest.fn() })
jest.mock('mixpanel', () => ({ init: (token: string) => mixpanelInit(token) }))

const initialize = jest.fn().mockResolvedValue(undefined)
const getRepository = jest.fn().mockImplementation((entity: { name: string }) => ({ target: entity.name }))
jest.mock('./DataSource', () => ({
  AppDataSource: {
    initialize: () => initialize(),
    getRepository: (entity: { name: string }) => getRepository(entity),
  },
}))

const REQUIRED_ENV: Record<string, string> = {
  REDIS_URL: 'redis://localhost:6379',
  SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123:analytics',
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/analytics',
  ADMIN_EMAILS: 'one@test.te,two@test.te',
  DB_HOST: 'db-host',
  DB_PORT: '3306',
  DB_USERNAME: 'analytics',
  DB_PASSWORD: 'secret',
  DB_DATABASE: 'analytics_db',
  DB_DEBUG_LEVEL: 'all',
}

const OPTIONAL_ENV = [
  'LOG_LEVEL',
  'SNS_AWS_REGION',
  'SNS_ENDPOINT',
  'SNS_ACCESS_KEY_ID',
  'SNS_SECRET_ACCESS_KEY',
  'SQS_AWS_REGION',
  'SQS_ENDPOINT',
  'SQS_ACCESS_KEY_ID',
  'SQS_SECRET_ACCESS_KEY',
  'MIXPANEL_TOKEN',
]

const loadContainer = async (extraEnv: Record<string, string> = {}, removed: string[] = []): Promise<Container> => {
  for (const key of OPTIONAL_ENV) {
    delete process.env[key]
  }
  Object.assign(process.env, REQUIRED_ENV, extraEnv)
  for (const key of removed) {
    delete process.env[key]
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ContainerConfigLoader } = require('./Container')

  return new ContainerConfigLoader().load()
}

describe('ContainerConfigLoader', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    initialize.mockResolvedValue(undefined)
    getRepository.mockImplementation((entity: { name: string }) => ({ target: entity.name }))
    mixpanelInit.mockReturnValue({ track: jest.fn() })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('initialises the database before anything is resolved from the container', async () => {
    await loadContainer()

    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('binds a single redis client for a single-node url', async () => {
    await loadContainer()

    expect(redisConstructor).toHaveBeenCalledWith('redis://localhost:6379')
    expect(redisClusterConstructor).not.toHaveBeenCalled()
  })

  it('binds a redis cluster client when the url lists several nodes', async () => {
    await loadContainer({ REDIS_URL: 'redis://a:6379,redis://b:6379' })

    expect(redisClusterConstructor).toHaveBeenCalledWith(['redis://a:6379', 'redis://b:6379'])
    expect(redisConstructor).not.toHaveBeenCalled()
  })

  it('splits the admin emails into a list', async () => {
    const container = await loadContainer()

    expect(container.get(TYPES.ADMIN_EMAILS)).toEqual(['one@test.te', 'two@test.te'])
  })

  it('binds the redis-backed analytics and statistics stores', async () => {
    const container = await loadContainer()

    expect(container.get(TYPES.AnalyticsStore)).toBeInstanceOf(RedisAnalyticsStore)
    expect(container.get(TYPES.StatisticsStore)).toBeInstanceOf(RedisStatisticsStore)
    expect(container.get(TYPES.StatisticMeasureRepository)).toBeInstanceOf(RedisStatisticsStore)
  })

  it('binds the ORM repositories for both persisted entities', async () => {
    const container = await loadContainer()

    expect(getRepository).toHaveBeenCalledTimes(2)
    expect(container.get(TYPES.ORMAnalyticsEntityRepository)).toEqual({ target: 'AnalyticsEntity' })
    expect(container.get(TYPES.ORMRevenueModificationRepository)).toEqual({
      target: 'TypeORMRevenueModification',
    })
  })

  it('binds an SNS client and a queue subscriber when a queue url is configured', async () => {
    const container = await loadContainer()

    expect(container.get(TYPES.SNS)).toBeInstanceOf(SNSClient)
    expect(container.get(TYPES.SQS)).toBeInstanceOf(SQSClient)
    expect(container.get(TYPES.DomainEventSubscriber)).toBeDefined()
  })

  it('fails closed before wiring queue services when no queue url is configured', async () => {
    await expect(loadContainer({}, ['SQS_QUEUE_URL'])).rejects.toThrow('Environment variable SQS_QUEUE_URL not set')
  })

  it('adds an endpoint and credentials to the SNS client only when they are configured', async () => {
    const withoutOverrides = await loadContainer()
    await expect((withoutOverrides.get(TYPES.SNS) as SNSClient).config.credentials()).rejects.toThrow()

    const container = await loadContainer({
      SNS_ENDPOINT: 'http://localstack:4566',
      SNS_ACCESS_KEY_ID: 'sns-key',
      SNS_SECRET_ACCESS_KEY: 'sns-secret',
    })
    const sns = container.get(TYPES.SNS) as SNSClient

    expect(await sns.config.endpoint?.()).toEqual(expect.objectContaining({ hostname: 'localstack' }))
    expect(await sns.config.credentials()).toEqual(
      expect.objectContaining({ accessKeyId: 'sns-key', secretAccessKey: 'sns-secret' }),
    )
  })

  it('ignores half-configured SNS credentials', async () => {
    const container = await loadContainer({ SNS_ACCESS_KEY_ID: 'sns-key' })
    const sns = container.get(TYPES.SNS) as SNSClient

    // an access key id without a secret is discarded, so the client falls back to the default chain
    await expect(sns.config.credentials()).rejects.toThrow()
  })

  it('adds an endpoint and credentials to the SQS client only when they are configured', async () => {
    const container = await loadContainer({
      SQS_ENDPOINT: 'http://localstack:4566',
      SQS_ACCESS_KEY_ID: 'sqs-key',
      SQS_SECRET_ACCESS_KEY: 'sqs-secret',
    })
    const sqs = container.get(TYPES.SQS) as SQSClient

    expect(await sqs.config.endpoint?.()).toEqual(expect.objectContaining({ hostname: 'localstack' }))
    expect(await sqs.config.credentials()).toEqual(
      expect.objectContaining({ accessKeyId: 'sqs-key', secretAccessKey: 'sqs-secret' }),
    )
  })

  it('ignores half-configured SQS credentials', async () => {
    const container = await loadContainer({ SQS_ACCESS_KEY_ID: 'sqs-key' })
    const sqs = container.get(TYPES.SQS) as SQSClient

    // an access key id without a secret is discarded, so the client falls back to the default chain
    await expect(sqs.config.credentials()).rejects.toThrow()
  })

  it('does not create a mixpanel client when no token is configured', async () => {
    const container = await loadContainer()

    expect(mixpanelInit).not.toHaveBeenCalled()
    expect(container.isBound(TYPES.MixpanelClient)).toEqual(false)
  })

  it('creates a mixpanel client from the configured token', async () => {
    const container = await loadContainer({ MIXPANEL_TOKEN: 'mixpanel-token' })

    expect(mixpanelInit).toHaveBeenCalledWith('mixpanel-token')
    expect(container.isBound(TYPES.MixpanelClient)).toEqual(true)
  })

  it('uses the configured log level for the logger', async () => {
    const container = await loadContainer({ LOG_LEVEL: 'debug' })

    expect((container.get(TYPES.Logger) as { level: string }).level).toEqual('debug')
  })

  it('defaults the log level to info', async () => {
    const container = await loadContainer()

    expect((container.get(TYPES.Logger) as { level: string }).level).toEqual('info')
  })

  it.each([
    TYPES.UserRegisteredEventHandler,
    TYPES.AccountDeletionRequestedEventHandler,
    TYPES.PaymentFailedEventHandler,
    TYPES.PaymentSuccessEventHandler,
    TYPES.SessionCreatedEventHandler,
    TYPES.SessionRefreshedEventHandler,
    TYPES.SubscriptionCancelledEventHandler,
    TYPES.SubscriptionRenewedEventHandler,
    TYPES.SubscriptionRefundedEventHandler,
    TYPES.SubscriptionPurchasedEventHandler,
    TYPES.SubscriptionExpiredEventHandler,
    TYPES.SubscriptionReactivatedEventHandler,
    TYPES.RefundProcessedEventHandler,
    TYPES.StatisticPersistenceRequestedEventHandler,
  ])('resolves the handler bound to %s', async (handlerType) => {
    const container = await loadContainer()

    expect(container.get(handlerType)).toBeDefined()
  })

  it('resolves every use case and the revenue modification mapper', async () => {
    const container = await loadContainer()

    expect(container.get(TYPES.GetUserAnalyticsId)).toBeDefined()
    expect(container.get(TYPES.SaveRevenueModification)).toBeDefined()
    expect(container.get(TYPES.CalculateMonthlyRecurringRevenue)).toBeDefined()
    expect(container.get(TYPES.PersistStatistic)).toBeDefined()
    expect(container.get(TYPES.RevenueModificationMap)).toBeDefined()
  })

  it('binds a message handler and a domain event publisher', async () => {
    const container = await loadContainer()

    expect(container.get(TYPES.DomainEventMessageHandler)).toBeDefined()
    expect(container.get(TYPES.DomainEventPublisher)).toBeDefined()
  })

  it('passes the mixpanel client through to the statistic persistence handler when a token is configured', async () => {
    const container = await loadContainer({ MIXPANEL_TOKEN: 'mixpanel-token' })

    expect(container.get(TYPES.StatisticPersistenceRequestedEventHandler)).toBeDefined()
    expect(mixpanelInit).toHaveBeenCalledTimes(1)
  })

  it('propagates a database initialisation failure', async () => {
    initialize.mockRejectedValue(new Error('could not connect'))

    await expect(loadContainer()).rejects.toThrow('could not connect')
  })
})
