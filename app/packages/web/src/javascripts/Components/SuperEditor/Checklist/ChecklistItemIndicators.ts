import type { ChecklistFlags } from '../Lexical/Nodes/ChecklistItemNode'

/** The schedule shell is already noneditable and unmanaged by Lexical. */
export function syncChecklistItemIndicators(
  shell: HTMLElement,
  flags: ChecklistFlags,
  personalTicks: number | null,
): void {
  let indicators = shell.querySelector<HTMLElement>(':scope > [data-checklist-indicators]')
  const labels = [
    ...(flags.pinned ? ['Pinned'] : []),
    ...(flags.priority !== 'normal' ? [`${flags.priority === 'high' ? 'High' : 'Low'} priority`] : []),
    ...(personalTicks !== null ? [`Per-person completion: ${personalTicks} ticked`] : []),
  ]
  if (!labels.length) {
    indicators?.remove()
    return
  }
  if (!indicators) {
    indicators = document.createElement('span')
    indicators.setAttribute('data-checklist-indicators', '')
    indicators.className = 'checklist-item-indicators'
    shell.prepend(indicators)
  }
  indicators.setAttribute('aria-label', labels.join(' · '))
  indicators.title = labels.join(' · ')
  const signature = `${flags.pinned}:${flags.priority}:${personalTicks}`
  if (indicators.dataset.state === signature) {
    return
  }
  indicators.dataset.state = signature
  indicators.replaceChildren()
  const badge = (kind: string, text: string, label: string) => {
    const span = document.createElement('span')
    span.className = `checklist-item-badge checklist-item-badge--${kind}`
    span.textContent = text
    span.setAttribute('aria-label', label)
    indicators.append(span)
  }
  if (flags.pinned) {
    badge('pin', 'Pinned', 'Pinned item')
  }
  if (flags.priority !== 'normal') {
    badge(flags.priority, `⚑ ${flags.priority === 'high' ? 'High' : 'Low'}`, `${flags.priority} priority`)
  }
  if (personalTicks !== null) {
    badge('personal', `☑ ${personalTicks}`, `Per-person completion: ${personalTicks} ticked`)
  }
}
