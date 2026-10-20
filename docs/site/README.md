# Rewind explainer site

A static site that explains Rewind for the team and for the SWE5006 presentation:
the product, architecture, design decisions, database, patterns, CI/CD and AWS.
Open `docs/site/html/index.html` in a browser (or serve the folder with
`python3 -m http.server`). Diagrams use the hand-drawn "sketch" style; click a
box to read its detail.

Rebuild after editing content: `python3 docs/site/build.py`.

## Content

`site.json` lists the pages in order. Each page is `content/<slug>.json`:

```json
{
  "title": "Page title",
  "lede": "One-sentence summary.",
  "intro": ["optional paragraphs in a card"],
  "sections": [
    {
      "id": "kebab-id",
      "title": "Section title",
      "summary": "1-2 sentences",
      "paragraphs": ["..."],
      "visuals": [{ "type": "flow", "title": "...", "steps": [{ "label": "..." }] }],
      "notes": ["bullets"],
      "tables": [{ "title": "...", "columns": ["A", "B"], "rows": [["1", "2"]] }],
      "code": "optional preformatted text",
      "terms": [{ "term": "...", "def": "..." }],
      "sources": [{ "label": "server/src/http.ts", "path": "server/src/http.ts", "note": "..." }],
      "qa": [{ "q": "A question a lecturer may ask", "a": "Model answer" }]
    }
  ]
}
```

Every field except `id` and `title` is optional. Strings may use `**bold**`,
`` `code` `` and `[text](url)`. Visuals are `flow`, `layers`, `cards`, `hub` or
`compare`; a box is `{"label", "sub"?, "detail"?, "icon"?, "accent"?}` (at most
two accents per diagram; `icon` is a file in `assets/icons/`). Draw a diagram
only where it is clearer than text. Ground every claim in the repository.
