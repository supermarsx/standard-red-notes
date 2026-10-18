/** Split only a trailing source section, outside fenced code. Raw transcript stays unchanged. */
export function splitAssistantSources(text: string): { body: string; sources: string; count: number } {
  const lines = text.split('\n')
  let fence: string | undefined
  let start = -1
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) {
        fence = marker
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined
      }
      continue
    }
    if (fence) {
      continue
    }
    if (/^##\s+(?:Retrieved web sources|Selected context sources|Sources|References)\s*#*\s*$/i.test(line)) {
      if (start === -1) {
        start = index
      }
    } else if (/^#{1,2}\s/.test(line)) {
      start = -1
    }
  }
  if (start === -1) {
    return { body: text, sources: '', count: 0 }
  }
  const sources = lines.slice(start).join('\n')
  let inBreakdown = false
  const count = lines.slice(start).reduce((total, line) => {
    if (/^### Research breakdown/.test(line)) {
      inBreakdown = true
    }
    if (/^##\s/.test(line)) {
      inBreakdown = false
    }
    return total + (!inBreakdown && /^\s*(?:[-*+] |\d+[.)] )/.test(line) ? 1 : 0)
  }, 0)
  return { body: lines.slice(0, start).join('\n').trimEnd(), sources, count }
}
