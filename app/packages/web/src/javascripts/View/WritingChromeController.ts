export type WritingChromeStage = 'full' | 'compact' | 'minimal'

/** Delayed, stepped chrome; timers never move focus or replace editor elements. */
export class WritingChromeController {
  private stage: WritingChromeStage = 'full'
  private previous: WritingChromeStage = 'compact'
  private focused = false
  private hovered = false
  private enter?: ReturnType<typeof setTimeout>
  private leave?: ReturnType<typeof setTimeout>
  private settle?: ReturnType<typeof setTimeout>
  constructor(private readonly changed: (stage: WritingChromeStage) => void) {}
  private set(stage: WritingChromeStage) {
    if (this.stage !== stage) {
      this.stage = stage
      this.changed(stage)
    }
  }
  private clear() {
    clearTimeout(this.enter)
    clearTimeout(this.leave)
    clearTimeout(this.settle)
    this.enter = this.leave = this.settle = undefined
  }
  focus = () => {
    this.focused = true
    this.clear()
    this.set('full')
  }
  release = () => {
    this.focused = false
    if (this.hovered || this.settle || this.leave || this.stage === 'minimal') {
      return
    }
    this.settle = setTimeout(() => {
      this.settle = undefined
      if (this.focused || this.hovered) {
        return
      }
      if (this.stage === 'full') {
        this.set('compact')
        this.release()
      } else {
        this.set('minimal')
      }
    }, 5000)
  }
  hoverStart = () => {
    clearTimeout(this.leave)
    this.leave = undefined
    clearTimeout(this.settle)
    this.settle = undefined
    this.hovered = true
    if (this.stage !== 'full') {
      this.previous = this.stage
    }
    if (!this.enter) {
      this.enter = setTimeout(() => {
        this.enter = undefined
        this.set('full')
      }, 2000)
    }
  }
  hoverEnd = () => {
    this.hovered = false
    clearTimeout(this.enter)
    this.enter = undefined
    if (this.focused) {
      return
    }
    clearTimeout(this.leave)
    this.leave = setTimeout(() => {
      this.leave = undefined
      if (!this.focused && !this.hovered) {
        this.set(this.previous)
        this.release()
      }
    }, 2000)
  }
  dispose = () => this.clear()
}
