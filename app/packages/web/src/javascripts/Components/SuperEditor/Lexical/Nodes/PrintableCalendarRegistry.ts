export type PrintableCalendarEvent = {
  date: string
  text: string
}

export type PrintableCalendarSnapshot = {
  events: PrintableCalendarEvent[]
}

type PrintableCalendarProvider = () => PrintableCalendarSnapshot

const printableCalendars = new WeakMap<HTMLElement, PrintableCalendarProvider>()

/** Associate a live Calendar block with a lazy, complete semantic print model. */
export function registerPrintableCalendar(element: HTMLElement, provider: PrintableCalendarProvider): void {
  printableCalendars.set(element, provider)
}

export function unregisterPrintableCalendar(element: HTMLElement): void {
  printableCalendars.delete(element)
}

export function getPrintableCalendar(element: HTMLElement): PrintableCalendarSnapshot | undefined {
  return printableCalendars.get(element)?.()
}
