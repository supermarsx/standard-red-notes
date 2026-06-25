declare class Highlight extends Set<AbstractRange> {
  constructor(...range: Range[])
  /**
   * Paint order for overlapping custom highlights. Higher priority paints on top.
   * https://developer.mozilla.org/en-US/docs/Web/API/Highlight/priority
   */
  priority: number
}

declare namespace CSS {
  const highlights: Map<string, Highlight>
}
