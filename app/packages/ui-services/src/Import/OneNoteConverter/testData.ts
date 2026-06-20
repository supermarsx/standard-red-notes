/**
 * Synthetic fixtures for the OneNote importer tests. These mimic the markers an
 * actual OneNote / Office "Web Page" export produces, but are hand-written and
 * minimal.
 */

export const oneNoteHtmlPage = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:o1="urn:schemas-microsoft-com:office:onenote">
<head>
  <meta name="Generator" content="Microsoft OneNote 15">
  <meta name="NotebookName" content="Work">
  <meta name="SectionName" content="Meetings">
  <title>Project Kickoff</title>
</head>
<body>
  <h1>Project Kickoff</h1>
  <p>Discussed the <b>timeline</b> and deliverables.</p>
  <ul>
    <li>Define scope</li>
    <li>Assign owners</li>
  </ul>
</body>
</html>`

export const oneNoteHtmlNoTitle = `<html>
<head><meta name="Generator" content="Microsoft OneNote 15"></head>
<body><h1>Heading As Title</h1><p>Body text.</p></body>
</html>`

export const genericHtml = `<!DOCTYPE html>
<html><head><title>Just HTML</title></head><body><p>Nothing special.</p></body></html>`

export const oneNoteMarkdown = `# Grocery List

- Milk
- Eggs
- Bread`
