import { Item } from './Item'

export class ConcurrentItemUpdateError extends Error {
  constructor(public readonly serverItem: Item) {
    super(`Item ${serverItem.id.toString()} changed before it could be updated`)
    this.name = 'ConcurrentItemUpdateError'
  }
}
