import { InternalEventBusInterface } from '@standardnotes/snjs'
import { action, makeObservable, observable } from 'mobx'
import { AbstractViewController } from '@/Controllers/Abstract/AbstractViewController'

export class ExportModalController extends AbstractViewController {
  isVisible = false

  constructor(eventBus: InternalEventBusInterface) {
    super(eventBus)

    makeObservable(this, {
      isVisible: observable,
      setIsVisible: action,
    })
  }

  setIsVisible = (isVisible: boolean): void => {
    this.isVisible = isVisible
  }

  close = (): void => {
    this.setIsVisible(false)
  }
}
