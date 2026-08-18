import { safeErrorLogMetadata, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { Metric } from '../../Domain/Metrics/Metric'
import { MetricsStoreInterface } from '../../Domain/Metrics/MetricsStoreInterface'
import { MetricsSummary } from '../../Domain/Metrics/MetricsSummary'
import { SyncCommandTransactionContext } from '../TypeORM/SyncCommandTransactionContext'

export class TransactionAwareMetricsStore implements MetricsStoreInterface {
  constructor(
    private readonly delegate: MetricsStoreInterface,
    private readonly transactionContext: SyncCommandTransactionContext,
    private readonly logger: Logger,
  ) {}

  async storeMetric(metric: Metric): Promise<void> {
    if (!this.transactionContext.manager) {
      return this.delegate.storeMetric(metric)
    }

    this.transactionContext.deferUntilCommit(() =>
      this.flush(() => this.delegate.storeMetric(metric), metric.props.name),
    )
  }

  async storeUserBasedMetric(metric: Metric, value: number, userUuid: Uuid): Promise<void> {
    if (!this.transactionContext.manager) {
      return this.delegate.storeUserBasedMetric(metric, value, userUuid)
    }

    this.transactionContext.deferUntilCommit(() =>
      this.flush(() => this.delegate.storeUserBasedMetric(metric, value, userUuid), metric.props.name),
    )
  }

  getUserBasedMetricsSummaryWithinTimeRange(dto: {
    metricName: string
    userUuid: Uuid
    from: Date
    to: Date
  }): Promise<MetricsSummary> {
    return this.delegate.getUserBasedMetricsSummaryWithinTimeRange(dto)
  }

  getUserBasedMetricsSummary(name: string, timestamp: number): Promise<MetricsSummary> {
    return this.delegate.getUserBasedMetricsSummary(name, timestamp)
  }

  getMetricsSummary(name: string, from: number, to: number): Promise<MetricsSummary> {
    return this.delegate.getMetricsSummary(name, from, to)
  }

  private async flush(operation: () => Promise<void>, metricName: string): Promise<void> {
    try {
      await operation()
    } catch (error) {
      this.logger.error('Post-commit metric flush failed.', {
        ...safeErrorLogMetadata(error),
        codeTag: 'TransactionAwareMetricsStore',
        metricName,
      })
    }
  }
}
