import type { LexicalEditor } from 'lexical'
import type { EditorViewPreferences } from '@/View/editorViewPreferences'

type Options = Pick<EditorViewPreferences, 'checklistBoxSizing' | 'checklistBoxScale' | 'checklistBoxSize'>

function restoreSize(item: HTMLElement, original: string) {
  if (original) {
    item.style.setProperty('--checkbox-size', original)
  } else {
    item.style.removeProperty('--checkbox-size')
  }
}

/** View-only sizing: follows inline text formatting without changing any Lexical nodes. */
export function installChecklistBoxSizing(editor: LexicalEditor, options: Options) {
  let dispose = () => {}
  const unregister = editor.registerRootListener((root) => {
    dispose()
    if (!root) {
      return
    }
    const originals = new Map<HTMLElement, { box: string; text: string }>()
    let frame: number | undefined
    const schedule = () => {
      if (frame === undefined) {
        frame = requestAnimationFrame(sync)
      }
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    function sync() {
      frame = undefined
      for (const [item, original] of originals) {
        if (!root!.contains(item)) {
          restoreSize(item, original.box)
          if (original.text) {
            item.style.setProperty('--sn-checklist-text-size', original.text)
          } else {
            item.style.removeProperty('--sn-checklist-text-size')
          }
          resize?.unobserve(item)
          originals.delete(item)
        }
      }
      for (const item of root!.querySelectorAll<HTMLElement>(
        'li[role="checkbox"], .Lexical__listItemChecked, .Lexical__listItemUnchecked',
      )) {
        if (item.classList.contains('Lexical__nestedListItem')) {
          continue
        }
        if (!originals.has(item)) {
          originals.set(item, {
            box: item.style.getPropertyValue('--checkbox-size'),
            text: item.style.getPropertyValue('--sn-checklist-text-size'),
          })
          resize?.observe(item)
        }
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => {
            if (
              node.textContent?.trim() &&
              node.parentElement?.closest('li') === item &&
              !node.parentElement.closest('[contenteditable="false"], [aria-hidden="true"], .checklist-due-shell')
            ) {
              return NodeFilter.FILTER_ACCEPT
            }
            return NodeFilter.FILTER_REJECT
          },
        })
        const text = walker.nextNode()
        const fontSize =
          parseFloat(getComputedStyle(text?.parentElement ?? item).fontSize) ||
          parseFloat(getComputedStyle(item).fontSize) ||
          16
        const size =
          options.checklistBoxSizing === 'fixed'
            ? options.checklistBoxSize
            : Math.max(4, Math.min(512, (fontSize * options.checklistBoxScale) / 100))
        const value = `${Math.round(size * 100) / 100}px`
        const textSize = `${fontSize}px`
        if (item.style.getPropertyValue('--sn-checklist-text-size') !== textSize) {
          item.style.setProperty('--sn-checklist-text-size', textSize)
        }
        if (item.style.getPropertyValue('--checkbox-size') !== value) {
          item.style.setProperty('--checkbox-size', value)
        }
      }
    }
    const mutation = new MutationObserver(schedule)
    mutation.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'role'],
    })
    resize?.observe(root)
    window.addEventListener('resize', schedule)
    document.fonts?.addEventListener('loadingdone', schedule)
    sync()
    dispose = () => {
      mutation.disconnect()
      resize?.disconnect()
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
      window.removeEventListener('resize', schedule)
      document.fonts?.removeEventListener('loadingdone', schedule)
      for (const [item, original] of originals) {
        restoreSize(item, original.box)
        if (original.text) {
          item.style.setProperty('--sn-checklist-text-size', original.text)
        } else {
          item.style.removeProperty('--sn-checklist-text-size')
        }
      }
    }
  })
  return () => {
    unregister()
    dispose()
  }
}
