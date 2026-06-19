import { markdownToHtml } from './markdownToHtml'

describe('markdownToHtml', () => {
  describe('headings', () => {
    it('renders h1 through h6', () => {
      expect(markdownToHtml('# One')).toBe('<h1>One</h1>')
      expect(markdownToHtml('## Two')).toBe('<h2>Two</h2>')
      expect(markdownToHtml('### Three')).toBe('<h3>Three</h3>')
      expect(markdownToHtml('#### Four')).toBe('<h4>Four</h4>')
      expect(markdownToHtml('##### Five')).toBe('<h5>Five</h5>')
      expect(markdownToHtml('###### Six')).toBe('<h6>Six</h6>')
    })

    it('does not treat 7 hashes as a heading', () => {
      expect(markdownToHtml('####### Seven')).toBe('<p>####### Seven</p>')
    })

    it('requires whitespace after the hashes', () => {
      expect(markdownToHtml('#nospace')).toBe('<p>#nospace</p>')
    })

    it('renders inline formatting inside a heading', () => {
      expect(markdownToHtml('# Hello **bold**')).toBe('<h1>Hello <strong>bold</strong></h1>')
    })
  })

  describe('emphasis', () => {
    it('renders ** bold', () => {
      expect(markdownToHtml('**strong**')).toBe('<p><strong>strong</strong></p>')
    })

    it('renders __ bold', () => {
      expect(markdownToHtml('__strong__')).toBe('<p><strong>strong</strong></p>')
    })

    it('renders * italic', () => {
      expect(markdownToHtml('*emph*')).toBe('<p><em>emph</em></p>')
    })

    it('renders _ italic', () => {
      expect(markdownToHtml('_emph_')).toBe('<p><em>emph</em></p>')
    })

    it('renders mixed bold and italic in one line', () => {
      expect(markdownToHtml('**b** and *i*')).toBe('<p><strong>b</strong> and <em>i</em></p>')
    })

    it('renders strikethrough', () => {
      expect(markdownToHtml('~~gone~~')).toBe('<p><del>gone</del></p>')
    })
  })

  describe('inline code', () => {
    it('renders inline code', () => {
      expect(markdownToHtml('`code`')).toBe('<p><code>code</code></p>')
    })

    it('renders inline code embedded in a sentence', () => {
      expect(markdownToHtml('run `npm test` now')).toBe('<p>run <code>npm test</code> now</p>')
    })
  })

  describe('fenced code blocks', () => {
    it('renders a fenced code block', () => {
      const input = '```\nconst x = 1\n```'
      expect(markdownToHtml(input)).toBe('<pre><code>const x = 1</code></pre>')
    })

    it('preserves multiple lines inside a code block', () => {
      const input = '```\na\nb\nc\n```'
      expect(markdownToHtml(input)).toBe('<pre><code>a\nb\nc</code></pre>')
    })

    it('does not transform markdown syntax inside a code block', () => {
      const input = '```\n# not a heading\n**not bold**\n```'
      expect(markdownToHtml(input)).toBe('<pre><code># not a heading\n**not bold**</code></pre>')
    })

    it('escapes html inside a code block', () => {
      const input = '```\n<div> & </div>\n```'
      expect(markdownToHtml(input)).toBe('<pre><code>&lt;div&gt; &amp; &lt;/div&gt;</code></pre>')
    })

    it('closes an unterminated code block at end of input', () => {
      const input = '```\nunfinished'
      expect(markdownToHtml(input)).toBe('<pre><code>unfinished</code></pre>')
    })

    it('supports a fence with a language identifier', () => {
      const input = '```ts\nlet y = 2\n```'
      expect(markdownToHtml(input)).toBe('<pre><code>let y = 2</code></pre>')
    })
  })

  describe('unordered lists', () => {
    it('renders a dash list', () => {
      const input = '- one\n- two'
      expect(markdownToHtml(input)).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
    })

    it('renders a plus list', () => {
      const input = '+ one\n+ two'
      expect(markdownToHtml(input)).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
    })

    it('renders inline formatting in list items', () => {
      const input = '- **bold** item'
      expect(markdownToHtml(input)).toBe('<ul>\n<li><strong>bold</strong> item</li>\n</ul>')
    })
  })

  describe('ordered lists', () => {
    it('renders an ordered list', () => {
      const input = '1. one\n2. two\n3. three'
      expect(markdownToHtml(input)).toBe('<ol>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ol>')
    })

    it('starts a new list when switching from unordered to ordered', () => {
      const input = '- a\n1. b'
      expect(markdownToHtml(input)).toBe('<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>')
    })

    it('closes a list on a blank line', () => {
      const input = '- a\n\n- b'
      expect(markdownToHtml(input)).toBe('<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>')
    })
  })

  describe('task lists', () => {
    it('renders an unchecked task', () => {
      const input = '- [ ] todo'
      expect(markdownToHtml(input)).toBe('<ul>\n<li><input type="checkbox" disabled /> todo</li>\n</ul>')
    })

    it('renders a checked task (lowercase x)', () => {
      const input = '- [x] done'
      expect(markdownToHtml(input)).toBe('<ul>\n<li><input type="checkbox" disabled checked /> done</li>\n</ul>')
    })

    it('renders a checked task (uppercase X)', () => {
      const input = '- [X] done'
      expect(markdownToHtml(input)).toBe('<ul>\n<li><input type="checkbox" disabled checked /> done</li>\n</ul>')
    })

    it('mixes checked and unchecked tasks in one list', () => {
      const input = '- [x] a\n- [ ] b'
      expect(markdownToHtml(input)).toBe(
        '<ul>\n<li><input type="checkbox" disabled checked /> a</li>\n<li><input type="checkbox" disabled /> b</li>\n</ul>',
      )
    })
  })

  describe('links', () => {
    it('renders a link', () => {
      expect(markdownToHtml('[text](https://example.com)')).toBe(
        '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">text</a></p>',
      )
    })

    it('escapes an ampersand in a link url', () => {
      expect(markdownToHtml('[t](https://x.com?a=1&b=2)')).toBe(
        '<p><a href="https://x.com?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">t</a></p>',
      )
    })
  })

  describe('images', () => {
    it('renders an image', () => {
      expect(markdownToHtml('![alt text](https://example.com/i.png)')).toBe(
        '<p><img alt="alt text" src="https://example.com/i.png" /></p>',
      )
    })

    it('renders an image with empty alt text', () => {
      expect(markdownToHtml('![](https://example.com/i.png)')).toBe(
        '<p><img alt="" src="https://example.com/i.png" /></p>',
      )
    })
  })

  describe('blockquotes', () => {
    it('renders a blockquote', () => {
      expect(markdownToHtml('> quoted')).toBe('<blockquote>quoted</blockquote>')
    })

    it('renders inline formatting inside a blockquote', () => {
      expect(markdownToHtml('> a *b* c')).toBe('<blockquote>a <em>b</em> c</blockquote>')
    })
  })

  describe('horizontal rules', () => {
    it('renders --- as an hr', () => {
      expect(markdownToHtml('---')).toBe('<hr />')
    })

    it('renders *** as an hr', () => {
      expect(markdownToHtml('***')).toBe('<hr />')
    })

    it('renders ___ as an hr', () => {
      expect(markdownToHtml('___')).toBe('<hr />')
    })

    it('renders spaced rule markers as an hr', () => {
      expect(markdownToHtml('- - -')).toBe('<hr />')
    })
  })

  describe('paragraphs', () => {
    it('wraps plain text in a paragraph', () => {
      expect(markdownToHtml('just text')).toBe('<p>just text</p>')
    })

    it('renders consecutive text lines as separate paragraphs', () => {
      expect(markdownToHtml('line one\nline two')).toBe('<p>line one</p>\n<p>line two</p>')
    })
  })

  describe('html escaping', () => {
    it('escapes <, > and & in plain text', () => {
      expect(markdownToHtml('a < b & c > d')).toBe('<p>a &lt; b &amp; c &gt; d</p>')
    })

    it('escapes html-looking content in a paragraph', () => {
      expect(markdownToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    })

    it('escapes html inside a heading', () => {
      expect(markdownToHtml('# <b>x</b>')).toBe('<h1>&lt;b&gt;x&lt;/b&gt;</h1>')
    })
  })

  describe('robustness', () => {
    it('returns an empty string for empty input', () => {
      expect(markdownToHtml('')).toBe('')
    })

    it('does not throw on whitespace-only input', () => {
      expect(() => markdownToHtml('   \n\t\n  ')).not.toThrow()
      expect(markdownToHtml('   \n\t\n  ')).toBe('')
    })

    it('normalizes CRLF line endings', () => {
      expect(markdownToHtml('a\r\nb')).toBe('<p>a</p>\n<p>b</p>')
    })

    it('does not throw on unbalanced markers', () => {
      expect(() => markdownToHtml('**unclosed and *also* `weird')).not.toThrow()
    })

    it('does not throw on a long pathological input', () => {
      const weird = '#'.repeat(1000) + ' ' + '*'.repeat(1000) + '\n'.repeat(100) + '[x'.repeat(500)
      expect(() => markdownToHtml(weird)).not.toThrow()
    })

    it('does not throw on only newlines', () => {
      expect(() => markdownToHtml('\n\n\n')).not.toThrow()
    })
  })

  describe('combined document', () => {
    it('renders a multi-feature document', () => {
      const input = ['# Title', '', 'Some **bold** and `code`.', '', '- item one', '- item two', '', '> quote'].join(
        '\n',
      )
      expect(markdownToHtml(input)).toBe(
        [
          '<h1>Title</h1>',
          '<p>Some <strong>bold</strong> and <code>code</code>.</p>',
          '<ul>',
          '<li>item one</li>',
          '<li>item two</li>',
          '</ul>',
          '<blockquote>quote</blockquote>',
        ].join('\n'),
      )
    })
  })
})
