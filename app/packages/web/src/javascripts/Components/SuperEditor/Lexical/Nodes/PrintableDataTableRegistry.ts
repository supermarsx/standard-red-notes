export type PrintableDataTableSnapshot = {
  columns: string[]
  rows: string[][]
}

type PrintableDataTableProvider = () => PrintableDataTableSnapshot

const printableDataTables = new WeakMap<HTMLElement, PrintableDataTableProvider>()

/** Associate a live DataTable block with a current, non-interactive print model. */
export function registerPrintableDataTable(element: HTMLElement, provider: PrintableDataTableProvider): void {
  printableDataTables.set(element, provider)
}

export function unregisterPrintableDataTable(element: HTMLElement): void {
  printableDataTables.delete(element)
}

/** Resolve only explicitly registered DataTables; arbitrary editor DOM is never interpreted as document data. */
export function getPrintableDataTable(element: HTMLElement): PrintableDataTableSnapshot | undefined {
  return printableDataTables.get(element)?.()
}
