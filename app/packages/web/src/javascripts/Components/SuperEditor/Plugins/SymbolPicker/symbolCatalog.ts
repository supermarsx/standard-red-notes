/**
 * Standard Red Notes: static, curated catalog of special characters for the
 * Insert -> Symbol picker. Dependency-free (no Lexical, no React) so it is
 * trivially unit-testable and shared by the pure grid view.
 *
 * Each symbol's `name` doubles as the button aria-label/title AND a search
 * target; optional `keywords` widen the match. Category names are literal
 * English strings rendered directly (not routed through i18n) — matching the
 * repo convention for new v1 strings, keeping the new-key surface tiny.
 *
 * `filterSymbols` mirrors `filterBlockCatalog`/`groupBlockCatalogByCategory` in
 * blockCatalog.ts: filter by name/keywords/char, then drop empty categories.
 */

/** A single insertable character with searchable metadata. */
export type SymbolEntry = {
  /** The literal character inserted at the caret. */
  char: string
  /** Human-readable name (aria-label / title / search target). */
  name: string
  /** Extra search terms beyond the name. */
  keywords?: string[]
}

/** A named group of symbols shown as one captioned section in the grid. */
export type SymbolCategory = {
  name: string
  symbols: SymbolEntry[]
}

const s = (char: string, name: string, keywords?: string[]): SymbolEntry => ({ char, name, keywords })

/**
 * The curated catalog. Order within a category IS the display order; category
 * order is the section order in the grid. ~250 symbols across eight groups.
 */
export const SYMBOL_CATALOG: SymbolCategory[] = [
  {
    name: 'Common',
    symbols: [
      s('©', 'Copyright', ['copyright', 'c']),
      s('®', 'Registered trademark', ['registered', 'trademark', 'r']),
      s('™', 'Trademark', ['trademark', 'tm']),
      s('°', 'Degree', ['degree', 'temperature']),
      s('§', 'Section sign', ['section', 'paragraph']),
      s('¶', 'Pilcrow', ['paragraph', 'pilcrow']),
      s('†', 'Dagger', ['dagger', 'footnote']),
      s('‡', 'Double dagger', ['dagger', 'footnote']),
      s('•', 'Bullet', ['bullet', 'dot', 'list']),
      s('…', 'Ellipsis', ['ellipsis', 'dots']),
      s('‰', 'Per mille', ['per mille', 'permille', 'percent']),
      s('′', 'Prime', ['prime', 'minutes', 'feet']),
      s('″', 'Double prime', ['prime', 'seconds', 'inches']),
      s('±', 'Plus-minus', ['plus minus', 'plusminus']),
      s('×', 'Multiplication', ['times', 'multiply', 'x']),
      s('÷', 'Division', ['divide', 'division']),
      s('≈', 'Approximately equal', ['approximately', 'approx']),
      s('≠', 'Not equal', ['not equal', 'inequal']),
      s('≤', 'Less than or equal', ['less than or equal']),
      s('≥', 'Greater than or equal', ['greater than or equal']),
      s('—', 'Em dash', ['em dash', 'emdash', 'dash']),
      s('–', 'En dash', ['en dash', 'endash', 'dash']),
      s('“', 'Left double quote', ['quote', 'curly', 'smart']),
      s('”', 'Right double quote', ['quote', 'curly', 'smart']),
      s('‘', 'Left single quote', ['quote', 'apostrophe', 'curly']),
      s('’', 'Right single quote', ['quote', 'apostrophe', 'curly']),
      s('«', 'Left guillemet', ['quote', 'angle', 'guillemet']),
      s('»', 'Right guillemet', ['quote', 'angle', 'guillemet']),
      s('¡', 'Inverted exclamation', ['exclamation', 'spanish']),
      s('¿', 'Inverted question', ['question', 'spanish']),
    ],
  },
  {
    name: 'Arrows',
    symbols: [
      s('←', 'Leftwards arrow', ['arrow', 'left', 'west']),
      s('→', 'Rightwards arrow', ['arrow', 'right', 'east']),
      s('↑', 'Upwards arrow', ['arrow', 'up', 'north']),
      s('↓', 'Downwards arrow', ['arrow', 'down', 'south']),
      s('↔', 'Left-right arrow', ['arrow', 'horizontal']),
      s('↕', 'Up-down arrow', ['arrow', 'vertical']),
      s('↖', 'North-west arrow', ['arrow', 'diagonal', 'upleft']),
      s('↗', 'North-east arrow', ['arrow', 'diagonal', 'upright']),
      s('↘', 'South-east arrow', ['arrow', 'diagonal', 'downright']),
      s('↙', 'South-west arrow', ['arrow', 'diagonal', 'downleft']),
      s('↩', 'Leftwards hook arrow', ['arrow', 'return', 'hook']),
      s('↪', 'Rightwards hook arrow', ['arrow', 'forward', 'hook']),
      s('⇐', 'Leftwards double arrow', ['arrow', 'double', 'implies']),
      s('⇒', 'Rightwards double arrow', ['arrow', 'double', 'implies']),
      s('⇔', 'Left-right double arrow', ['arrow', 'double', 'iff', 'equivalent']),
      s('⇑', 'Upwards double arrow', ['arrow', 'double', 'up']),
      s('⇓', 'Downwards double arrow', ['arrow', 'double', 'down']),
      s('⤴', 'Arrow curving up', ['arrow', 'curve', 'up']),
      s('⤵', 'Arrow curving down', ['arrow', 'curve', 'down']),
      s('➜', 'Heavy arrow', ['arrow', 'heavy', 'bold']),
      s('⟶', 'Long rightwards arrow', ['arrow', 'long', 'right']),
      s('⟵', 'Long leftwards arrow', ['arrow', 'long', 'left']),
    ],
  },
  {
    name: 'Math',
    symbols: [
      s('∞', 'Infinity', ['infinity', 'infinite']),
      s('∑', 'Summation', ['sum', 'sigma', 'total']),
      s('∏', 'Product', ['product', 'pi']),
      s('∫', 'Integral', ['integral', 'calculus']),
      s('∮', 'Contour integral', ['integral', 'contour']),
      s('√', 'Square root', ['root', 'radical', 'sqrt']),
      s('∛', 'Cube root', ['root', 'cube']),
      s('∂', 'Partial derivative', ['partial', 'derivative']),
      s('∇', 'Nabla', ['nabla', 'del', 'gradient']),
      s('∆', 'Increment', ['delta', 'increment', 'change']),
      s('∈', 'Element of', ['element', 'member', 'in']),
      s('∉', 'Not an element of', ['not element', 'not member']),
      s('⊂', 'Subset of', ['subset']),
      s('⊃', 'Superset of', ['superset']),
      s('⊆', 'Subset or equal', ['subset', 'equal']),
      s('⊇', 'Superset or equal', ['superset', 'equal']),
      s('∪', 'Union', ['union', 'set']),
      s('∩', 'Intersection', ['intersection', 'set']),
      s('∀', 'For all', ['for all', 'universal']),
      s('∃', 'There exists', ['exists', 'existential']),
      s('∄', 'There does not exist', ['not exists']),
      s('∅', 'Empty set', ['empty', 'null set']),
      s('∧', 'Logical and', ['and', 'conjunction', 'wedge']),
      s('∨', 'Logical or', ['or', 'disjunction', 'vee']),
      s('¬', 'Logical not', ['not', 'negation']),
      s('⊕', 'Circled plus', ['xor', 'direct sum', 'oplus']),
      s('⊗', 'Circled times', ['tensor', 'otimes']),
      s('∝', 'Proportional to', ['proportional']),
      s('∴', 'Therefore', ['therefore']),
      s('∵', 'Because', ['because']),
      s('≡', 'Identical to', ['identical', 'equivalent', 'congruent']),
      s('≅', 'Approximately equal to', ['congruent', 'isomorphic']),
      s('∓', 'Minus-plus', ['minus plus']),
      s('∙', 'Bullet operator', ['dot', 'multiply']),
      s('⋅', 'Dot operator', ['dot', 'multiply']),
      s('π', 'Pi', ['pi', 'constant']),
      s('µ', 'Micro sign', ['micro', 'mu']),
      s('ℝ', 'Real numbers', ['reals', 'real']),
      s('ℤ', 'Integers', ['integers', 'integer']),
      s('ℕ', 'Natural numbers', ['naturals', 'natural']),
      s('ℚ', 'Rational numbers', ['rationals', 'rational']),
      s('ℂ', 'Complex numbers', ['complex']),
    ],
  },
  {
    name: 'Greek',
    symbols: [
      s('α', 'Alpha (lowercase)', ['alpha', 'greek']),
      s('β', 'Beta (lowercase)', ['beta', 'greek']),
      s('γ', 'Gamma (lowercase)', ['gamma', 'greek']),
      s('δ', 'Delta (lowercase)', ['delta', 'greek']),
      s('ε', 'Epsilon (lowercase)', ['epsilon', 'greek']),
      s('ζ', 'Zeta (lowercase)', ['zeta', 'greek']),
      s('η', 'Eta (lowercase)', ['eta', 'greek']),
      s('θ', 'Theta (lowercase)', ['theta', 'greek']),
      s('ι', 'Iota (lowercase)', ['iota', 'greek']),
      s('κ', 'Kappa (lowercase)', ['kappa', 'greek']),
      s('λ', 'Lambda (lowercase)', ['lambda', 'greek']),
      s('μ', 'Mu (lowercase)', ['mu', 'greek']),
      s('ν', 'Nu (lowercase)', ['nu', 'greek']),
      s('ξ', 'Xi (lowercase)', ['xi', 'greek']),
      s('ο', 'Omicron (lowercase)', ['omicron', 'greek']),
      s('π', 'Pi (lowercase)', ['pi', 'greek']),
      s('ρ', 'Rho (lowercase)', ['rho', 'greek']),
      s('σ', 'Sigma (lowercase)', ['sigma', 'greek']),
      s('τ', 'Tau (lowercase)', ['tau', 'greek']),
      s('υ', 'Upsilon (lowercase)', ['upsilon', 'greek']),
      s('φ', 'Phi (lowercase)', ['phi', 'greek']),
      s('χ', 'Chi (lowercase)', ['chi', 'greek']),
      s('ψ', 'Psi (lowercase)', ['psi', 'greek']),
      s('ω', 'Omega (lowercase)', ['omega', 'greek']),
      s('Α', 'Alpha (uppercase)', ['alpha', 'greek']),
      s('Β', 'Beta (uppercase)', ['beta', 'greek']),
      s('Γ', 'Gamma (uppercase)', ['gamma', 'greek']),
      s('Δ', 'Delta (uppercase)', ['delta', 'greek']),
      s('Θ', 'Theta (uppercase)', ['theta', 'greek']),
      s('Λ', 'Lambda (uppercase)', ['lambda', 'greek']),
      s('Ξ', 'Xi (uppercase)', ['xi', 'greek']),
      s('Π', 'Pi (uppercase)', ['pi', 'greek']),
      s('Σ', 'Sigma (uppercase)', ['sigma', 'greek']),
      s('Φ', 'Phi (uppercase)', ['phi', 'greek']),
      s('Ψ', 'Psi (uppercase)', ['psi', 'greek']),
      s('Ω', 'Omega (uppercase)', ['omega', 'greek', 'ohm']),
    ],
  },
  {
    name: 'Currency',
    symbols: [
      s('$', 'Dollar sign', ['dollar', 'usd', 'money']),
      s('€', 'Euro sign', ['euro', 'eur', 'money']),
      s('£', 'Pound sterling', ['pound', 'gbp', 'money']),
      s('¥', 'Yen sign', ['yen', 'yuan', 'jpy', 'cny', 'money']),
      s('¢', 'Cent sign', ['cent', 'money']),
      s('₹', 'Indian rupee', ['rupee', 'inr', 'money']),
      s('₽', 'Russian ruble', ['ruble', 'rub', 'money']),
      s('₩', 'Won sign', ['won', 'krw', 'money']),
      s('₪', 'New shekel', ['shekel', 'ils', 'money']),
      s('₫', 'Dong sign', ['dong', 'vnd', 'money']),
      s('₴', 'Hryvnia', ['hryvnia', 'uah', 'money']),
      s('₦', 'Naira', ['naira', 'ngn', 'money']),
      s('₱', 'Peso sign', ['peso', 'php', 'money']),
      s('฿', 'Baht sign', ['baht', 'thb', 'money']),
      s('₡', 'Colon sign', ['colon', 'crc', 'money']),
      s('₵', 'Cedi sign', ['cedi', 'ghs', 'money']),
      s('₺', 'Turkish lira', ['lira', 'try', 'money']),
      s('₼', 'Manat sign', ['manat', 'azn', 'money']),
      s('₾', 'Lari sign', ['lari', 'gel', 'money']),
      s('¤', 'Currency sign', ['currency', 'money', 'generic']),
    ],
  },
  {
    name: 'Punctuation',
    symbols: [
      s('—', 'Em dash', ['em dash', 'emdash']),
      s('–', 'En dash', ['en dash', 'endash']),
      s('…', 'Horizontal ellipsis', ['ellipsis', 'dots']),
      s('‘', 'Left single quotation', ['quote', 'single']),
      s('’', 'Right single quotation', ['quote', 'single', 'apostrophe']),
      s('“', 'Left double quotation', ['quote', 'double']),
      s('”', 'Right double quotation', ['quote', 'double']),
      s('«', 'Left-pointing guillemet', ['quote', 'guillemet']),
      s('»', 'Right-pointing guillemet', ['quote', 'guillemet']),
      s('‹', 'Single left guillemet', ['quote', 'guillemet']),
      s('›', 'Single right guillemet', ['quote', 'guillemet']),
      s('¡', 'Inverted exclamation mark', ['exclamation', 'spanish']),
      s('¿', 'Inverted question mark', ['question', 'spanish']),
      s('§', 'Section sign', ['section']),
      s('¶', 'Pilcrow sign', ['paragraph', 'pilcrow']),
      s('·', 'Middle dot', ['dot', 'interpunct']),
      s('‽', 'Interrobang', ['interrobang', 'question', 'exclamation']),
      s('※', 'Reference mark', ['reference', 'note']),
      s('⁂', 'Asterism', ['asterism', 'stars']),
      s('‖', 'Double vertical line', ['double bar', 'norm']),
      s('⁓', 'Swung dash', ['swung dash', 'tilde']),
      s('¦', 'Broken bar', ['broken bar', 'pipe']),
    ],
  },
  {
    name: 'Shapes',
    symbols: [
      s('★', 'Black star', ['star', 'filled', 'favorite']),
      s('☆', 'White star', ['star', 'outline']),
      s('✓', 'Check mark', ['check', 'tick', 'yes', 'done']),
      s('✔', 'Heavy check mark', ['check', 'tick', 'yes', 'done']),
      s('✗', 'Ballot X', ['cross', 'x', 'no']),
      s('✘', 'Heavy ballot X', ['cross', 'x', 'no']),
      s('☑', 'Checked box', ['checkbox', 'checked', 'ballot']),
      s('☒', 'Crossed box', ['checkbox', 'crossed', 'ballot']),
      s('♥', 'Heart', ['heart', 'love', 'suit']),
      s('♦', 'Diamond', ['diamond', 'suit']),
      s('♣', 'Club', ['club', 'suit']),
      s('♠', 'Spade', ['spade', 'suit']),
      s('●', 'Black circle', ['circle', 'filled', 'dot']),
      s('○', 'White circle', ['circle', 'outline']),
      s('◆', 'Black diamond', ['diamond', 'filled']),
      s('◇', 'White diamond', ['diamond', 'outline']),
      s('■', 'Black square', ['square', 'filled']),
      s('□', 'White square', ['square', 'outline']),
      s('▲', 'Black up triangle', ['triangle', 'up']),
      s('▼', 'Black down triangle', ['triangle', 'down']),
      s('►', 'Black right pointer', ['triangle', 'right', 'play']),
      s('◄', 'Black left pointer', ['triangle', 'left']),
      s('☀', 'Sun', ['sun', 'weather', 'sunny']),
      s('☁', 'Cloud', ['cloud', 'weather']),
      s('☂', 'Umbrella', ['umbrella', 'rain']),
      s('☯', 'Yin yang', ['yin yang', 'tao', 'balance']),
      s('♻', 'Recycling', ['recycle', 'recycling']),
      s('⚠', 'Warning', ['warning', 'caution', 'alert']),
      s('⚡', 'High voltage', ['lightning', 'bolt', 'power', 'energy']),
      s('☎', 'Telephone', ['phone', 'telephone']),
      s('✉', 'Envelope', ['envelope', 'mail', 'email']),
      s('✂', 'Scissors', ['scissors', 'cut']),
      s('✎', 'Pencil', ['pencil', 'edit', 'write']),
      s('✈', 'Airplane', ['airplane', 'plane', 'flight']),
    ],
  },
  {
    name: 'Latin',
    symbols: [
      s('à', 'a grave', ['accent', 'grave', 'latin']),
      s('á', 'a acute', ['accent', 'acute', 'latin']),
      s('â', 'a circumflex', ['accent', 'circumflex', 'latin']),
      s('ä', 'a umlaut', ['accent', 'umlaut', 'diaeresis', 'latin']),
      s('ã', 'a tilde', ['accent', 'tilde', 'latin']),
      s('å', 'a ring', ['accent', 'ring', 'latin']),
      s('ç', 'c cedilla', ['accent', 'cedilla', 'latin']),
      s('è', 'e grave', ['accent', 'grave', 'latin']),
      s('é', 'e acute', ['accent', 'acute', 'latin']),
      s('ê', 'e circumflex', ['accent', 'circumflex', 'latin']),
      s('ë', 'e umlaut', ['accent', 'umlaut', 'latin']),
      s('í', 'i acute', ['accent', 'acute', 'latin']),
      s('î', 'i circumflex', ['accent', 'circumflex', 'latin']),
      s('ñ', 'n tilde', ['accent', 'tilde', 'spanish', 'latin']),
      s('ó', 'o acute', ['accent', 'acute', 'latin']),
      s('ô', 'o circumflex', ['accent', 'circumflex', 'latin']),
      s('ö', 'o umlaut', ['accent', 'umlaut', 'latin']),
      s('õ', 'o tilde', ['accent', 'tilde', 'latin']),
      s('ø', 'o slash', ['accent', 'slash', 'latin']),
      s('ú', 'u acute', ['accent', 'acute', 'latin']),
      s('ü', 'u umlaut', ['accent', 'umlaut', 'latin']),
      s('æ', 'ae ligature', ['ligature', 'ae', 'latin']),
      s('œ', 'oe ligature', ['ligature', 'oe', 'latin']),
      s('ß', 'Sharp s', ['eszett', 'sharp s', 'german', 'latin']),
    ],
  },
]

/**
 * Filter the catalog by a free-text query against name, keywords, and the char
 * itself (case-insensitive), then drop any category left empty. An empty query
 * returns every category unchanged.
 */
export function filterSymbols(query: string): SymbolCategory[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return SYMBOL_CATALOG
  }
  return SYMBOL_CATALOG.map((category) => ({
    name: category.name,
    symbols: category.symbols.filter(
      (symbol) =>
        symbol.char === query ||
        symbol.name.toLowerCase().includes(q) ||
        (symbol.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(q)),
    ),
  })).filter((category) => category.symbols.length > 0)
}
