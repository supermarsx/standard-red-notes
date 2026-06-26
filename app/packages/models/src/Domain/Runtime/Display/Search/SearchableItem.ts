export interface SearchableItem {
  uuid: string
  title?: string
  text?: string
  /**
   * Standard Red Notes: always-resident preview text. With lazy-decrypt enabled a
   * "lite" note has its body (`text`) stripped from memory (text === ''), but the
   * preview_plain/preview_html fields stay resident. The substring matcher falls
   * back to these so cold notes still match on their preview with zero decrypt.
   */
  preview_plain?: string
  preview_html?: string
}
