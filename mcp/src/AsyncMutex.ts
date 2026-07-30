/**
 * Minimal FIFO async mutex. The MCP bridge shares one mutable SNApplication
 * across protocol sessions; every account operation and background sync must
 * pass through this gate because snjs does not promise concurrent mutation.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = turn;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
