/** @type {import('tailwindcss').Config} */

const plugin = require('tailwindcss/plugin')

module.exports = {
  // WARNING: every string in THIS FILE is scanned too (that is the only reason
  // the safelist below works), so never spell a utility class out in a comment
  // here — it becomes a real CSS rule. See the note in
  // scripts/CheckCssVarBrackets.mjs for the two shapes that must not be written.
  //
  // Tailwind v4's automatic source detection — its base is this package, via
  // @tailwindcss/postcss — scans every non-gitignored file in the package, not
  // just the globs below, and any text shaped like a utility is compiled into a
  // real CSS rule. Three such rules were shipping declarations that every
  // browser rejects outright, so the class did nothing and Firefox logged a
  // parse error for each:
  //   - scripts/CheckCssVarBrackets.mjs explains the malformed Tailwind v3
  //     custom-property syntax it exists to forbid, and its own two examples
  //     were compiled into live rules whose declarations the parser drops;
  //   - Components/Table/useTable.spec.tsx and Table.spec.tsx use row ids that
  //     collide with the grid-row utility, and one of them asks for grid line
  //     zero, which is not a legal grid line.
  // Negated entries here are the exclusion that works: `@source not` in the CSS
  // entry was measured to take effect only for whole-directory patterns, never
  // for a file-extension pattern.
  // Keep ./src/javascripts/**/*.tsx even though detection already covers it:
  // it documents what is meant to be scanned, and removing it changes nothing.
  content: [
    './src/javascripts/**/*.tsx',
    '../toast/src/**/*.tsx',
    '!./scripts/**/*',
    '!./src/javascripts/**/*.spec.tsx',
  ],
  theme: {
    extend: {
      spacing: {
        4.5: '1.125rem',
        5.5: '1.325rem',
        8.5: '2.125rem',
        13: '3.25rem',
        15: '3.75rem',
        18: '4.5rem',
        26: '6.5rem',
        30: '7.5rem',
        50: '12.5rem',
        70: '17.5rem',
        87.5: '21.875rem',
        125: '31.25rem',
        160: '40rem',
        'safe-top': 'var(--safe-area-inset-top)',
        'safe-bottom': 'var(--safe-area-inset-bottom)',
        'safe-left': 'var(--safe-area-inset-left)',
        'safe-right': 'var(--safe-area-inset-right)',
      },
      minWidth: {
        42: '10.5rem',
        55: '13.75rem',
        76: '19rem',
        90: '22.5rem',
      },
      maxWidth: {
        76: '19rem',
        89: '22.25rem',
        125: '31.25rem',
      },
      maxHeight: {
        110: '27.5rem',
      },
      zIndex: {
        'editor-content': 'var(--z-index-editor-content)',
        'editor-title-bar': 'var(--z-index-editor-title-bar)',
        'resizer-overlay': 'var(--z-index-resizer-overlay)',
        'component-view': 'var(--z-index-component-view)',
        'panel-resizer': 'var(--z-index-panel-resizer)',
        'dropdown-menu': 'var(--z-index-dropdown-menu)',
        'footer-bar': 'var(--z-index-footer-bar)',
        'footer-bar-item': 'var(--z-index-footer-bar-item)',
        'footer-bar-item-panel': 'var(--z-index-footer-bar-item-panel)',
        preferences: 'var(--z-index-preferences)',
        'purchase-flow': 'var(--z-index-purchase-flow)',
        'lock-screen': 'var(--z-index-lock-screen)',
        modal: 'var(--z-index-modal)',
        toast: 'var(--z-index-toast)',
        tooltip: 'var(--z-index-tooltip)',
      },
      boxShadow: {
        inner:
          'var(--sn-stylekit-info-color) 1px 1px 0px 0px inset, var(--sn-stylekit-info-color) -1px -1px 0px 0px inset',
        bottom: 'currentcolor 0px -1px 0px 0px inset, currentcolor 0px 1px 0px 0px',
        main: '0px 4px 8px rgba(0, 0, 0, 0.12), 0px 2px 8px rgba(0, 0, 0, 0.04)',
      },
      fontSize: {
        'menu-item': '0.813rem',
        'mobile-menu-item': '1.1rem',
        'tablet-menu-item': '0.95rem',
        'navigation-list-item': '0.88rem',
        'mobile-navigation-list-item': '1rem',
        editor: 'var(--sn-stylekit-font-size-editor)',
      },
      screens: {
        'xsm-only': { min: '320px', max: '639px' },
        'sm-only': { min: '640px', max: '767px' },
        'md-only': { min: '768px', max: '1023px' },
        'lg-only': { min: '1024px', max: '1279px' },
      },
      transitionProperty: {
        width: 'width',
      },
    },
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      neutral: 'var(--sn-stylekit-neutral-color)',
      'neutral-contrast': 'var(--sn-stylekit-neutral-contrast-color)',
      info: 'var(--sn-stylekit-info-color)',
      'info-darkened': 'var(--sn-stylekit-info-color-darkened)',
      'info-contrast': 'var(--sn-stylekit-info-contrast-color)',
      'info-backdrop': 'var(--sn-stylekit-info-backdrop-color)',
      success: 'var(--sn-stylekit-success-color)',
      'success-contrast': 'var(--sn-stylekit-success-contrast-color)',
      warning: 'var(--sn-stylekit-warning-color)',
      'warning-contrast': 'var(--sn-stylekit-warning-contrast-color)',
      danger: 'var(--sn-stylekit-danger-color)',
      'danger-contrast': 'var(--sn-stylekit-danger-contrast-color)',
      'danger-light': 'var(--sn-stylekit-danger-light-color, var(--sn-stylekit-danger-color))',
      default: 'var(--sn-stylekit-background-color)',
      foreground: 'var(--sn-stylekit-foreground-color)',
      contrast: 'var(--sn-stylekit-contrast-background-color)',
      'secondary-contrast': 'var(--sn-stylekit-secondary-contrast-border-color)',
      'secondary-background': 'var(--sn-stylekit-secondary-background-color)',
      text: 'var(--sn-stylekit-contrast-foreground-color)',
      border: 'var(--sn-stylekit-border-color)',
      'secondary-border': 'var(--sn-stylekit-secondary-border-color)',
      'passive-0': 'var(--sn-stylekit-passive-color-0)',
      'passive-1': 'var(--sn-stylekit-passive-color-1)',
      'passive-2': 'var(--sn-stylekit-passive-color-2)',
      'passive-3': 'var(--sn-stylekit-passive-color-3)',
      'passive-4': 'var(--sn-stylekit-passive-color-4)',
      'passive-4-opacity-variant': 'var(--sn-stylekit-passive-color-4-opacity-variant)',
      'passive-5': 'var(--sn-stylekit-passive-color-5)',
      'passive-6': 'var(--sn-stylekit-passive-color-6)',
      'passive-super-light': 'var(--sn-stylekit-passive-color-super-light)',
      'accessory-tint-1': 'var(--sn-stylekit-accessory-tint-color-1)',
      'accessory-tint-2': 'var(--sn-stylekit-accessory-tint-color-2)',
      'accessory-tint-3': 'var(--sn-stylekit-accessory-tint-color-3)',
      'accessory-tint-4': 'var(--sn-stylekit-accessory-tint-color-4)',
      'accessory-tint-5': 'var(--sn-stylekit-accessory-tint-color-5)',
      'accessory-tint-6': 'var(--sn-stylekit-accessory-tint-color-6)',
      'normal-button': 'var(--normal-button-background-color)',
    },
  },
  safelist: [
    'text-accessory-tint-1',
    'text-accessory-tint-2',
    'text-accessory-tint-3',
    'text-accessory-tint-4',
    'text-accessory-tint-5',
    'text-accessory-tint-6',
    'border-accessory-tint-1',
    'border-accessory-tint-2',
    'border-accessory-tint-3',
    'border-accessory-tint-4',
    'border-accessory-tint-5',
    'border-accessory-tint-6',
    'leading-none',
    'leading-tight',
    'leading-snug',
    'leading-normal',
    'leading-relaxed',
    'leading-loose',
  ],
  plugins: [
    plugin(function ({ addVariant }) {
      addVariant('pointer-coarse', '@media (pointer: coarse)')
      addVariant('translucent-ui', '.translucent-ui &')
    }),
  ],
}
