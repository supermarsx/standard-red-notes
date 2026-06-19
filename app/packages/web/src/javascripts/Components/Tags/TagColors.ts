/**
 * Preset color-coding options for tags.
 *
 * The first six values mirror the theme's accessory tint palette
 * (`--sn-stylekit-accessory-tint-color-1..6`) so they blend with the active
 * theme; the remainder are a few additional distinct hues.
 *
 * The stored value is a plain hex string persisted in the tag content
 * (`TagContent.color`), so it syncs across devices.
 */
export type TagColorOption = {
  label: string
  value: string
}

export const TagColorOptions: TagColorOption[] = [
  { label: 'Blue', value: '#086dd6' },
  { label: 'Pink', value: '#ea6595' },
  { label: 'Yellow', value: '#ebad00' },
  { label: 'Purple', value: '#7049cf' },
  { label: 'Green', value: '#1aa772' },
  { label: 'Orange', value: '#f28c52' },
  { label: 'Red', value: '#d4351c' },
  { label: 'Teal', value: '#0c8599' },
  { label: 'Indigo', value: '#3b48d6' },
  { label: 'Gray', value: '#74808f' },
]
