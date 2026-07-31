/* eslint-disable @typescript-eslint/no-explicit-any */

import { LogLevel } from './LogLevel'
import { redactLogValue, safeErrorLogMetadata } from './SafeLog'

function safeLogParameter(value: unknown): unknown {
  return value instanceof Error ? safeErrorLogMetadata(value) : redactLogValue(value)
}

export class Logger {
  private level: LogLevel = 'none'

  constructor(private appIdentifier: string) {}

  private canLog(level: LogLevel): boolean {
    if (this.level === 'none') {
      return false
    }

    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    return levels.indexOf(level) >= levels.indexOf(this.level)
  }

  public setLevel(level: LogLevel): void {
    this.level = level
  }

  public debug(message: string, ...optionalParams: any[]): void {
    if (this.canLog('debug')) {
      this.logWithColor(redactLogValue(message) as string, ...optionalParams.map(safeLogParameter))
    }
  }

  public info(message: string, ...optionalParams: any[]): void {
    if (this.canLog('info')) {
      this.logWithColor(redactLogValue(message) as string, ...optionalParams.map(safeLogParameter))
    }
  }

  public warn(message: string, ...optionalParams: any[]): void {
    if (this.canLog('warn')) {
      console.warn(redactLogValue(message), ...optionalParams.map(safeLogParameter))
    }
  }

  public error(message: string, ...optionalParams: any[]): void {
    if (this.canLog('error')) {
      console.error(redactLogValue(message), ...optionalParams.map(safeLogParameter))
    }
  }

  private logWithColor(...args: any[]): void {
    const date = new Date()
    const timeString = `${date.toLocaleTimeString().replace(' PM', '').replace(' AM', '')}.${date.getMilliseconds()}`
    this.customLog(
      `%c${this.appIdentifier}%c${timeString}`,
      'color: font-weight: bold; margin-right: 4px',
      'color: gray',
      ...args,
    )
  }

  private customLog(...args: any[]) {
    // eslint-disable-next-line no-console
    Function.prototype.apply.call(console.log, console, args.map(safeLogParameter))
  }
}

export default Logger
