import {
  addAtIndex,
  addIfUnique,
  arrayByDifference,
  arrayByRemovingFromIndex,
  arraysEqual,
  assert,
  assertUnreachable,
  blobToBase64,
  compareValues,
  convertTimestampToMilliseconds,
  Copy,
  dateSorted,
  dateToLocalizedString,
  deepFreeze,
  deepMerge,
  dictToArray,
  escapeHtmlString,
  extendArray,
  filterFromArray,
  findInArray,
  firstHalfOfString,
  getGlobalScope,
  greaterOfTwoDates,
  hasGetter,
  isEmpty,
  isFunction,
  isNotUndefined,
  isNullOrUndefined,
  isObject,
  isReactNativeEnvironment,
  isSameDay,
  isString,
  isValidUrl,
  isWebCryptoAvailable,
  isWebEnvironment,
  joinPaths,
  jsonParseEmbeddedKeys,
  lastElement,
  log,
  logWithColor,
  naturalSort,
  nonSecureRandomIdentifier,
  objectToValueArray,
  omitByCopy,
  omitInPlace,
  omitUndefinedCopy,
  pickByCopy,
  pluralize,
  removeFromArray,
  removeFromIndex,
  searchArray,
  secondHalfOfString,
  sleep,
  sortedCopy,
  spaceSeparatedStrings,
  splitString,
  subtractFromArray,
  sureSearchArray,
  topLevelCompare,
  truncateHexString,
  uniqCombineObjArrays,
  uniqueArray,
  uniqueArrayByKey,
  useBoolean,
} from './Utils'

describe('environment helpers', () => {
  it('getGlobalScope should return the jsdom window', () => {
    expect(getGlobalScope()).toBe(window)
  })

  it('isWebEnvironment should be true under jsdom', () => {
    expect(isWebEnvironment()).toBe(true)
  })

  it('isReactNativeEnvironment should be false under jsdom', () => {
    expect(isReactNativeEnvironment()).toBe(false)
  })

  it('isReactNativeEnvironment should be true when navigator.product says so', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'product')
    Object.defineProperty(navigator, 'product', { value: 'ReactNative', configurable: true })

    expect(isReactNativeEnvironment()).toBe(true)

    if (original) {
      Object.defineProperty(navigator, 'product', original)
    } else {
      delete (navigator as unknown as Record<string, unknown>).product
    }
  })

  it('isWebCryptoAvailable should be true in a browser-like environment without documentMode', () => {
    expect(isWebCryptoAvailable()).toBe(true)
  })

  it('isWebCryptoAvailable should fall through to the Edge check when documentMode is set', () => {
    ;(document as unknown as { documentMode?: number }).documentMode = 11

    // Not Edge, so the second clause is false too.
    expect(isWebCryptoAvailable()).toBe(false)

    delete (document as unknown as { documentMode?: number }).documentMode
  })
})

describe('type predicates', () => {
  it('isObject should accept objects, arrays and functions but not null or primitives', () => {
    expect(isObject({})).toBe(true)
    expect(isObject([])).toBe(true)
    expect(isObject(() => undefined)).toBe(true)
    expect(isObject(null)).toBe(false)
    expect(isObject(undefined)).toBe(false)
    expect(isObject(1)).toBe(false)
    expect(isObject('a')).toBe(false)
  })

  it('isFunction should accept only functions', () => {
    expect(isFunction(() => undefined)).toBe(true)
    expect(isFunction(null)).toBe(false)
    expect(isFunction({})).toBe(false)
  })

  it('isNullOrUndefined should accept null and undefined only', () => {
    expect(isNullOrUndefined(null)).toBe(true)
    expect(isNullOrUndefined(undefined)).toBe(true)
    expect(isNullOrUndefined(0)).toBe(false)
    expect(isNullOrUndefined('')).toBe(false)
  })

  it('isNotUndefined should reject null and undefined but accept falsy values', () => {
    expect(isNotUndefined(0)).toBe(true)
    expect(isNotUndefined('')).toBe(true)
    expect(isNotUndefined(null)).toBe(false)
    expect(isNotUndefined(undefined)).toBe(false)
  })

  it('isEmpty should be true for an empty or missing string', () => {
    expect(isEmpty('')).toBe(true)
    expect(isEmpty(undefined as unknown as string)).toBe(true)
    expect(isEmpty('a')).toBe(false)
  })

  it('isString should accept primitives and String objects', () => {
    expect(isString('a')).toBe(true)
    // eslint-disable-next-line no-new-wrappers
    expect(isString(new String('a'))).toBe(true)
    expect(isString(1)).toBe(false)
  })
})

describe('array helpers', () => {
  it('dictToArray should return the object values', () => {
    expect(dictToArray({ a: 1, b: 2 })).toEqual([1, 2])
  })

  it('findInArray should find by key and value, or return undefined', () => {
    const items = [{ id: 1 }, { id: 2 }]
    expect(findInArray(items, 'id', 2)).toBe(items[1])
    expect(findInArray(items, 'id', 3)).toBeUndefined()
  })

  it('searchArray should find by partial predicate', () => {
    const items = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]
    expect(searchArray(items, { name: 'b' })).toBe(items[1])
    expect(searchArray(items, { name: 'z' })).toBeUndefined()
  })

  it('sureSearchArray should return the match', () => {
    const items = [{ id: 1 }]
    expect(sureSearchArray(items, { id: 1 })).toBe(items[0])
  })

  it('uniqCombineObjArrays should merge and dedupe by the equality keys', () => {
    const a = [{ id: 1, v: 'a' }]
    const b = [
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
    ]

    expect(uniqCombineObjArrays(a, b, ['id', 'v'])).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
    ])
  })

  it('uniqCombineObjArrays should treat elements differing on any key as distinct', () => {
    const a = [{ id: 1, v: 'a' }]
    const b = [{ id: 1, v: 'b' }]

    expect(uniqCombineObjArrays(a, b, ['id', 'v'])).toHaveLength(2)
  })

  it('uniqueArray should dedupe primitives', () => {
    expect(uniqueArray([1, 1, 2, 3, 3])).toEqual([1, 2, 3])
  })

  it('uniqueArrayByKey should dedupe by a key', () => {
    expect(
      uniqueArrayByKey(
        [
          { id: 1, v: 'a' },
          { id: 1, v: 'b' },
          { id: 2, v: 'c' },
        ],
        'id',
      ),
    ).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'c' },
    ])
  })

  it('lastElement should return the last element or undefined', () => {
    expect(lastElement([1, 2, 3])).toBe(3)
    expect(lastElement([])).toBeUndefined()
  })

  it('extendArray should append in place', () => {
    const target = [1]
    extendArray(target, [2, 3])
    expect(target).toEqual([1, 2, 3])
  })

  it('removeFromArray should remove the first match in place', () => {
    const target = [1, 2, 1]
    removeFromArray(target, 1)
    expect(target).toEqual([2, 1])
  })

  it('removeFromArray should leave the array untouched when there is no match', () => {
    const target = [1, 2]
    removeFromArray(target, 9)
    expect(target).toEqual([1, 2])
  })

  it('subtractFromArray should remove every listed value in place', () => {
    const target = [1, 2, 3, 4]
    subtractFromArray(target, [2, 4, 9])
    expect(target).toEqual([1, 3])
  })

  it('addIfUnique should add and report whether it did', () => {
    const target = [1]
    expect(addIfUnique(target, 2)).toBe(true)
    expect(addIfUnique(target, 2)).toBe(false)
    expect(target).toEqual([1, 2])
  })

  it('filterFromArray should remove matching elements in place', () => {
    const target = [
      { id: 1, keep: false },
      { id: 2, keep: true },
    ]
    filterFromArray(target, { keep: false })
    expect(target).toEqual([{ id: 2, keep: true }])
  })

  it('filterFromArray should accept a predicate function', () => {
    const target = [1, 2, 3, 4]
    filterFromArray(target, (value) => value % 2 === 0)
    expect(target).toEqual([1, 3])
  })

  it('arrayByDifference should return the symmetric difference', () => {
    expect(arrayByDifference([1, 2, 3], [3, 4])).toEqual([1, 2, 4])
  })

  it('removeFromIndex should splice in place', () => {
    const target = [1, 2, 3]
    removeFromIndex(target, 1)
    expect(target).toEqual([1, 3])
  })

  it('addAtIndex should insert in place', () => {
    const target = [1, 3]
    addAtIndex(target, 2, 1)
    expect(target).toEqual([1, 2, 3])
  })

  it('arrayByRemovingFromIndex should return a copy without the index', () => {
    const target = [1, 2, 3]
    expect(arrayByRemovingFromIndex(target, 0)).toEqual([2, 3])
    expect(target).toEqual([1, 2, 3])
  })

  it('arraysEqual should compare membership regardless of order', () => {
    expect(arraysEqual([1, 2], [2, 1])).toBe(true)
    expect(arraysEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(arraysEqual([1, 2], [1, 3])).toBe(false)
    expect(arraysEqual([], [])).toBe(true)
  })

  it('dateSorted should sort ascending by default and descending on request', () => {
    const early = { at: new Date('2020-01-01') }
    const late = { at: new Date('2021-01-01') }

    expect(dateSorted([late, early], 'at')).toEqual([early, late])
    expect(dateSorted([early, late], 'at', false)).toEqual([late, early])
  })

  it('dateSorted should keep equal timestamps in place', () => {
    const a = { id: 'a', at: new Date('2020-01-01') }
    const b = { id: 'b', at: new Date('2020-01-01') }

    expect(dateSorted([a, b], 'at').map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('naturalSort should order numerically embedded strings', () => {
    const items = [{ n: 'item10' }, { n: 'item2' }, { n: 'item1' }]

    expect(naturalSort(items, 'n').map((item) => item.n)).toEqual(['item1', 'item2', 'item10'])
    expect(naturalSort(items, 'n', 'desc').map((item) => item.n)).toEqual(['item10', 'item2', 'item1'])
  })
})

describe('object helpers', () => {
  it('objectToValueArray should return the values of the own keys', () => {
    expect(objectToValueArray({ a: 1, b: 2 })).toEqual([1, 2])
  })

  it('sortedCopy should return a key-sorted deep copy', () => {
    const source = { b: '1', a: '2' }
    const result = sortedCopy<Record<string, string>>(source)

    expect(Object.keys(result)).toEqual(['a', 'b'])
    expect(result).not.toBe(source)
  })

  it('omitUndefinedCopy should drop null and undefined values', () => {
    expect(omitUndefinedCopy({ a: 1, b: null, c: undefined, d: 0 })).toEqual({ a: 1, d: 0 })
  })

  it('topLevelCompare should compare top-level values', () => {
    expect(topLevelCompare({ a: 1 }, { a: 1 })).toBe(true)
    expect(topLevelCompare({ a: 1 }, { a: 2 })).toBe(false)
    expect(topLevelCompare({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(topLevelCompare(null, null)).toBe(true)
    expect(topLevelCompare(null, { a: 1 })).toBe(false)
    expect(topLevelCompare({ a: 1 }, null)).toBe(false)
  })

  it('compareValues should compare dates by time', () => {
    expect(compareValues(new Date('2020-01-01'), new Date('2020-01-01'))).toBe(true)
    expect(compareValues(new Date('2020-01-01'), new Date('2021-01-01'))).toBe(false)
  })

  it('compareValues should be false when only one side is truthy', () => {
    expect(compareValues({ a: 1 }, undefined as unknown as { a: number })).toBe(false)
    expect(compareValues(undefined as unknown as { a: number }, { a: 1 })).toBe(false)
  })

  it('compareValues should compare String objects by reference', () => {
    // eslint-disable-next-line no-new-wrappers
    const left = new String('a')
    // eslint-disable-next-line no-new-wrappers
    const right = new String('a')

    expect(compareValues(left, left)).toBe(true)
    expect(compareValues(left, right)).toBe(false)
  })

  it('compareValues should fall back to a top-level compare', () => {
    expect(compareValues({ a: 1 }, { a: 1 })).toBe(true)
  })

  it('jsonParseEmbeddedKeys should parse the values it can and keep the rest', () => {
    expect(jsonParseEmbeddedKeys({ a: '{"x":1}', b: 'not json', c: '3' })).toEqual({
      a: { x: 1 },
      b: 'not json',
      c: 3,
    })
  })

  it('omitInPlace should delete the listed keys', () => {
    const object: Record<string, number> = { a: 1, b: 2 }
    omitInPlace(object, ['a'])
    expect(object).toEqual({ b: 2 })
  })

  it('omitInPlace should be a no-op for a falsy object', () => {
    expect(() => omitInPlace(undefined as unknown as Record<string, number>, ['a'])).not.toThrow()
  })

  it('omitByCopy should return a copy without the listed keys', () => {
    const source = { a: 1, b: 2 }
    const result = omitByCopy(source, ['a'])

    expect(result).toEqual({ b: 2 })
    expect(source).toEqual({ a: 1, b: 2 })
  })

  it('omitByCopy should return undefined for null or undefined input', () => {
    expect(omitByCopy(null as unknown as { a: number }, ['a'])).toBeUndefined()
    expect(omitByCopy(undefined as unknown as { a: number }, ['a'])).toBeUndefined()
  })

  it('pickByCopy should return a copy of only the listed keys', () => {
    expect(pickByCopy({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 })
  })

  it('Copy should deep copy objects, clone dates and pass primitives through', () => {
    const nested = { a: { b: 1 } }
    const copied = Copy<typeof nested>(nested)
    expect(copied).toEqual(nested)
    expect(copied.a).not.toBe(nested.a)

    const date = new Date('2020-01-01')
    const copiedDate = Copy<Date>(date)
    expect(copiedDate).not.toBe(date)
    expect(copiedDate.getTime()).toBe(date.getTime())

    expect(Copy<number>(5)).toBe(5)
    expect(Copy<null>(null)).toBeNull()
  })

  it('deepMerge should merge nested objects and replace arrays wholesale', () => {
    const a = { nested: { x: 1 }, list: [1, 2, 3] }
    const result = deepMerge(a, { nested: { y: 2 }, list: [] })

    expect(result).toBe(a)
    expect(result).toEqual({ nested: { x: 1, y: 2 }, list: [] })
  })

  it('deepMerge should throw when either side is missing', () => {
    expect(() => deepMerge(null as never, { a: 1 })).toThrow('Attempting to deepMerge with null values')
    expect(() => deepMerge({ a: 1 }, null as never)).toThrow('Attempting to deepMerge with null values')
  })

  it('deepFreeze should freeze nested objects', () => {
    const frozen = deepFreeze({ a: { b: 1 }, c: 2, d: null })

    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.a)).toBe(true)
  })

  it('deepFreeze should not recurse into an already frozen value', () => {
    const inner = Object.freeze({ b: 1 })
    const frozen = deepFreeze({ a: inner })

    expect(frozen.a).toBe(inner)
  })

  it('hasGetter should detect prototype getters only', () => {
    class WithGetter {
      get value() {
        return 1
      }
      plain = 2
    }
    const instance = new WithGetter()

    expect(hasGetter(instance, 'value')).toBe(true)
    expect(hasGetter(instance, 'plain')).toBeFalsy()
    expect(hasGetter(instance, 'missing')).toBeFalsy()
  })
})

describe('string helpers', () => {
  it('joinPaths should trim and join with a single separator', () => {
    expect(joinPaths('http://host/', '/api/', '/v1')).toBe('http://host/api/v1')
  })

  it('joinPaths should drop empty parts', () => {
    expect(joinPaths('a', '', 'b')).toBe('a/b')
  })

  it('truncateHexString should cut to the number of hex chars for the bits', () => {
    expect(truncateHexString('abcdef0123456789', 32)).toBe('abcdef01')
  })

  it('splitString should split into the requested number of parts', () => {
    expect(splitString('abcdef', 3)).toEqual(['ab', 'cd', 'ef'])
    expect(splitString('abcdef', 1)).toEqual(['abcdef'])
  })

  it('firstHalfOfString and secondHalfOfString should split down the middle', () => {
    expect(firstHalfOfString('abcdef')).toBe('abc')
    expect(secondHalfOfString('abcdef')).toBe('def')
  })

  it('escapeHtmlString should escape the HTML metacharacters', () => {
    expect(escapeHtmlString('<b>"x" & \'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;')
  })

  it('spaceSeparatedStrings should join with single spaces', () => {
    expect(spaceSeparatedStrings('a', 'b', 'c')).toBe('a b c')
  })

  it('pluralize should pick the singular only for a count of one', () => {
    expect(pluralize(1, 'note', 'notes')).toBe('note')
    expect(pluralize(0, 'note', 'notes')).toBe('notes')
    expect(pluralize(2, 'note', 'notes')).toBe('notes')
  })

  it('nonSecureRandomIdentifier should produce a digits-only identifier', () => {
    expect(nonSecureRandomIdentifier()).toMatch(/^\d+$/)
  })

  it('isValidUrl should accept absolute URLs and reject bare paths', () => {
    expect(isValidUrl('https://example.com/a?b=1')).toBe(true)
    expect(isValidUrl('not a url')).toBe(false)
    expect(isValidUrl('/relative')).toBe(false)
  })
})

describe('date helpers', () => {
  it('greaterOfTwoDates should return the later date', () => {
    const early = new Date('2020-01-01')
    const late = new Date('2021-01-01')

    expect(greaterOfTwoDates(late, early)).toBe(late)
    expect(greaterOfTwoDates(early, late)).toBe(late)
  })

  it('isSameDay should compare year, month and day', () => {
    expect(isSameDay(new Date(2020, 0, 1, 3), new Date(2020, 0, 1, 21))).toBe(true)
    expect(isSameDay(new Date(2020, 0, 1), new Date(2020, 0, 2))).toBe(false)
    expect(isSameDay(new Date(2020, 0, 1), new Date(2020, 1, 1))).toBe(false)
    expect(isSameDay(new Date(2020, 0, 1), new Date(2021, 0, 1))).toBe(false)
  })

  it('dateToLocalizedString should render a localized string containing the year', () => {
    expect(dateToLocalizedString(new Date('2020-06-15T12:00:00Z'))).toContain('2020')
  })

  it('convertTimestampToMilliseconds should normalize seconds, milliseconds and microseconds', () => {
    expect(convertTimestampToMilliseconds(1_600_000_000)).toBe(1_600_000_000_000)
    expect(convertTimestampToMilliseconds(1_600_000_000_000)).toBe(1_600_000_000_000)
    expect(convertTimestampToMilliseconds(1_600_000_000_000_000)).toBe(1_600_000_000_000)
  })

  it('convertTimestampToMilliseconds should throw for an unrecognised precision', () => {
    expect(() => convertTimestampToMilliseconds(12_345)).toThrow('Unhandled timestamp precision: 12345')
  })
})

describe('control helpers', () => {
  it('assert should throw only for undefined', () => {
    expect(() => assert(undefined)).toThrow('Assertion failed; value must be defined')
    expect(() => assert(null)).not.toThrow()
    expect(() => assert(0)).not.toThrow()
  })

  it('assertUnreachable should always throw', () => {
    expect(() => assertUnreachable('unexpected' as never)).toThrow('Unchecked case unexpected')
  })

  it('useBoolean should fall back to the default only for null and undefined', () => {
    expect(useBoolean(true, false)).toBe(true)
    expect(useBoolean(false, true)).toBe(false)
    expect(useBoolean(undefined, true)).toBe(true)
  })

  it('sleep should resolve after the delay and warn by default', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await sleep(1, true, 'because')

    expect(warn).toHaveBeenCalledWith('Sleeping for 1ms', {
      hasDescription: true,
    })
    warn.mockRestore()
  })

  it('sleep should stay silent when warning is disabled', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await sleep(1, false)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('logging helpers', () => {
  let consoleLog: jest.SpyInstance

  beforeEach(() => {
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleLog.mockRestore()
  })

  it('logWithColor should prefix the namespace and a timestamp and pass the args through', () => {
    logWithColor('namespace', 'red', 'first', 2)

    const [format, namespaceStyle, timeStyle, ...rest] = consoleLog.mock.calls[0]
    expect(format).toMatch(/^%cnamespace%c\d/)
    expect(namespaceStyle).toBe('color: red; font-weight: bold; margin-right: 4px')
    expect(timeStyle).toBe('color: gray')
    expect(rest).toEqual(['first', 2])
  })

  it('log should use black as the namespace colour', () => {
    log('namespace', 'msg')

    expect(consoleLog.mock.calls[0][1]).toBe('color: black; font-weight: bold; margin-right: 4px')
  })

  it('should project Error instances and redact structured content at the utility log sink', () => {
    log('namespace', new Error('opaque-error-sentinel'), {
      accessToken: 'access-token-sentinel',
      content: 'encrypted-content-sentinel',
      userId: 'user-123',
    })

    const [, , , errorMetadata, structured] = consoleLog.mock.calls[0]
    expect(errorMetadata).toEqual({
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
    expect(structured).toEqual({
      accessToken: '[REDACTED]',
      content: '[REDACTED]',
      userId: 'user-123',
    })
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('opaque-error-sentinel')
  })
})

describe('blobToBase64', () => {
  it('should resolve with a data URL for the blob contents', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })

    await expect(blobToBase64(blob)).resolves.toBe(`data:text/plain;base64,${btoa('hello')}`)
  })

  it('should reject when the reader produces a non-string result', async () => {
    const readAsDataURL = jest.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (
      this: FileReader,
    ) {
      Object.defineProperty(this, 'result', { value: new ArrayBuffer(1), configurable: true })
      this.onloadend?.(new ProgressEvent('loadend') as ProgressEvent<FileReader>)
    })

    await expect(blobToBase64(new Blob(['x']))).rejects.toBeUndefined()

    readAsDataURL.mockRestore()
  })
})
