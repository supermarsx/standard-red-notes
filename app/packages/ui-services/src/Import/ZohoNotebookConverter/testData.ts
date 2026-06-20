/**
 * Synthetic fixtures for the Zoho Notebook importer tests. These mimic the
 * markup a Zoho Notebook notecard export produces, hand-written and minimal.
 */

export const zohoCardHtml = `<!DOCTYPE html>
<html>
<head>
  <meta name="generator" content="Zoho Notebook">
  <meta name="notebook" content="Personal">
  <title>Reading List</title>
</head>
<body class="znote">
  <div class="note-card" data-notebook="Personal">
    <div class="note-title">Reading List</div>
    <div class="note-content">
      <p>Books to read this year.</p>
      <ul>
        <li class="checked">Dune</li>
        <li>Foundation</li>
      </ul>
    </div>
  </div>
</body>
</html>`

export const zohoCardCheckbox = `<html>
<head><meta name="generator" content="Zoho Notebook"></head>
<body class="znote">
  <div class="note-content">
    <ul>
      <li><input type="checkbox" checked>Buy milk</li>
      <li><input type="checkbox">Walk the dog</li>
    </ul>
  </div>
</body>
</html>`

export const zohoCardUnknownShape = `<html>
<head><meta name="generator" content="Zoho Notebook"></head>
<body class="zn-something">
  <p>A card type the importer does not specifically understand.</p>
</body>
</html>`

export const genericHtml = `<!DOCTYPE html>
<html><head><title>Plain</title></head><body><p>Nothing special.</p></body></html>`
