import { PrefKey, SystemViewId } from '@standardnotes/snjs'
import { readPersistedFilesSort, writePersistedFilesSort } from './filesViewSortPreference'

const applicationWith = (systemViewPreferences: unknown) => {
  const setPreference = jest.fn(async (_key: string, _value: unknown) => undefined)
  return {
    application: {
      getPreference: (key: string) => (key === PrefKey.SystemViewPreferences ? systemViewPreferences : undefined),
      setPreference,
    } as never,
    setPreference,
  }
}

describe('readPersistedFilesSort', () => {
  it('returns nothing when no preference was ever saved', () => {
    const { application } = applicationWith(undefined)

    expect(readPersistedFilesSort(application)).toBeUndefined()
  })

  it('maps the stored SortableItem key onto the tab’s sort contract', () => {
    const { application } = applicationWith({
      [SystemViewId.Files]: { sortBy: 'decryptedSize', sortReverse: false },
    })

    expect(readPersistedFilesSort(application)).toEqual({ sortBy: 'size', sortDirection: 'dsc' })
  })

  it('reads sortReverse the way the smart view wrote it: reversed means ascending', () => {
    // The trap this pins: the tab's table treats reversed as DESCENDING, so
    // reading the stored flag with the tab's convention would invert every
    // preference saved before the merge.
    const { application } = applicationWith({
      [SystemViewId.Files]: { sortBy: 'title', sortReverse: true },
    })

    expect(readPersistedFilesSort(application)).toEqual({ sortBy: 'name', sortDirection: 'asc' })
  })

  it('ignores a stored sort the tab has no column for', () => {
    const { application } = applicationWith({
      [SystemViewId.Files]: { sortBy: 'updated_at', sortReverse: false },
    })

    expect(readPersistedFilesSort(application)).toBeUndefined()
  })
})

describe('writePersistedFilesSort', () => {
  it('writes back into the same key the smart view used', async () => {
    const { application, setPreference } = applicationWith({})

    await writePersistedFilesSort(application, { sortBy: 'date', sortDirection: 'asc' })

    expect(setPreference).toHaveBeenCalledWith(PrefKey.SystemViewPreferences, {
      [SystemViewId.Files]: { sortBy: 'created_at', sortReverse: true },
    })
  })

  it('preserves other system views’ preferences and the Files view’s other keys', async () => {
    const { application, setPreference } = applicationWith({
      [SystemViewId.ArchivedNotes]: { sortBy: 'title' },
      [SystemViewId.Files]: { sortBy: 'title', sortReverse: true, somethingElse: 1 },
    })

    await writePersistedFilesSort(application, { sortBy: 'size', sortDirection: 'dsc' })

    expect(setPreference).toHaveBeenCalledWith(PrefKey.SystemViewPreferences, {
      [SystemViewId.ArchivedNotes]: { sortBy: 'title' },
      [SystemViewId.Files]: { sortBy: 'decryptedSize', sortReverse: false, somethingElse: 1 },
    })
  })

  it('round-trips through read without drifting', async () => {
    const { application, setPreference } = applicationWith({})

    await writePersistedFilesSort(application, { sortBy: 'name', sortDirection: 'asc' })
    const written = setPreference.mock.calls[0][1]
    const { application: reread } = applicationWith(written)

    expect(readPersistedFilesSort(reread)).toEqual({ sortBy: 'name', sortDirection: 'asc' })
  })
})
