import { applyHiddenToMutator, isMarkedHidden, isWithinHiddenSubtree } from './NavigationVisibility'

/**
 * The hidden flag is read and written through this module rather than off the model because
 * web consumes `@standardnotes/models` through the generated `@standardnotes/snjs` artifact,
 * which lags a field added in the same commit. These cases pin both halves of that: the read
 * must find the flag whether the bundled `SNTag`/`SNFolder` constructor copied it onto the
 * item or not, and the write must land in the content that gets saved whether the bundled
 * mutator has the setter or not.
 */

type FakeItem = { uuid: string; hidden?: boolean; content?: { hidden?: boolean } }

describe('isMarkedHidden', () => {
  it('reads the flag off a rebuilt item', () => {
    expect(isMarkedHidden({ uuid: 'a', hidden: true } as FakeItem)).toBe(true)
  })

  it('falls back to raw content when the bundled constructor never copied the field across', () => {
    expect(isMarkedHidden({ uuid: 'a', content: { hidden: true } } as FakeItem)).toBe(true)
  })

  it('treats an absent flag as shown', () => {
    expect(isMarkedHidden({ uuid: 'a', content: {} } as FakeItem)).toBe(false)
  })

  it('treats an explicit false as shown', () => {
    expect(isMarkedHidden({ uuid: 'a', hidden: false, content: { hidden: false } } as FakeItem)).toBe(false)
  })
})

describe('isWithinHiddenSubtree', () => {
  const parentOf = (tree: Record<string, string | undefined>, byUuid: Record<string, FakeItem>) => {
    return (item: FakeItem): FakeItem | undefined => {
      const parentUuid = tree[item.uuid]
      return parentUuid ? byUuid[parentUuid] : undefined
    }
  }

  it('is true for the hidden item itself', () => {
    const item: FakeItem = { uuid: 'a', hidden: true }
    expect(isWithinHiddenSubtree(item, () => undefined)).toBe(true)
  })

  it('is true for a descendant of a hidden ancestor, however deep', () => {
    const root: FakeItem = { uuid: 'root', hidden: true }
    const middle: FakeItem = { uuid: 'middle' }
    const leaf: FakeItem = { uuid: 'leaf' }
    const byUuid = { root, middle, leaf }
    const resolve = parentOf({ middle: 'root', leaf: 'middle' }, byUuid)

    expect(isWithinHiddenSubtree(leaf, resolve)).toBe(true)
    expect(isWithinHiddenSubtree(middle, resolve)).toBe(true)
  })

  it('is false when nothing in the chain is hidden', () => {
    const root: FakeItem = { uuid: 'root' }
    const leaf: FakeItem = { uuid: 'leaf' }
    const resolve = parentOf({ leaf: 'root' }, { root, leaf })

    expect(isWithinHiddenSubtree(leaf, resolve)).toBe(false)
  })

  it('does not spin on a cycle in the parent chain, and answers "not hidden" when it holds nothing hidden', () => {
    const first: FakeItem = { uuid: 'first' }
    const second: FakeItem = { uuid: 'second' }
    const resolve = parentOf({ first: 'second', second: 'first' }, { first, second })

    expect(isWithinHiddenSubtree(first, resolve)).toBe(false)
  })

  it('still finds a hidden member inside a cycle', () => {
    const first: FakeItem = { uuid: 'first' }
    const second: FakeItem = { uuid: 'second', hidden: true }
    const resolve = parentOf({ first: 'second', second: 'first' }, { first, second })

    expect(isWithinHiddenSubtree(first, resolve)).toBe(true)
  })
})

describe('applyHiddenToMutator', () => {
  it('writes the content key through a mutator that has the setter', () => {
    const content: { hidden?: boolean } = {}
    const mutator = {
      mutableContent: content,
      set hidden(value: boolean) {
        if (value) {
          content.hidden = true
        } else {
          delete content.hidden
        }
      },
    }

    applyHiddenToMutator(mutator, true)

    expect(content.hidden).toBe(true)
  })

  it('writes the content key through a mutator built before the setter existed', () => {
    const mutator = { mutableContent: {} as { hidden?: boolean } }

    applyHiddenToMutator(mutator, true)

    expect(mutator.mutableContent.hidden).toBe(true)
  })

  it('removes the key when showing again rather than writing false', () => {
    const mutator = { mutableContent: { hidden: true } as { hidden?: boolean } }

    applyHiddenToMutator(mutator, false)

    expect('hidden' in mutator.mutableContent).toBe(false)
  })
})
