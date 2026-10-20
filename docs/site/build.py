#!/usr/bin/env python3
"""Build the Rewind explainer site: site.json + content/<slug>.json -> html/.

Run from the repo root: python3 docs/site/build.py
Page and diagram schema: docs/site/README.md. Diagrams follow the sketch-diagrams style.
"""
import html, json, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "html"
SITE = json.loads((ROOT / "site.json").read_text())
REPO = SITE["repo"].rstrip("/")
BRANCH = SITE.get("branch", "dev")
VISUAL_KEYS = {"flow": "steps", "layers": "layers", "cards": "items", "hub": "items", "compare": "rows"}


def esc(s):
    return html.escape(str(s), quote=True)


def rich(s):
    """Escape, then allow **bold**, `code` and [text](url)."""
    s = esc(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    return re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', s)


def node(item, cls="box", i=0):
    """A diagram box. Boxes with `detail` are clickable and fill the figure's detail panel."""
    has_icon = item.get("icon") and (ROOT / "assets" / "icons" / f"{item['icon']}.svg").exists()
    icon = f'<img class="logo" src="assets/icons/{esc(item["icon"])}.svg" alt="">' if has_icon else ""
    sub = f'<span class="sub">{esc(item["sub"])}</span>' if item.get("sub") else ""
    accent = " accent" if item.get("accent") else ""
    inner = f'{icon}<span class="label">{esc(item["label"])}</span>{sub}'
    if item.get("detail"):
        return f'<button type="button" class="{cls} c{i % 6}{accent}" aria-pressed="false" data-detail="{esc(item["detail"])}">{inner}</button>'
    return f'<div class="{cls} c{i % 6}{accent}">{inner}</div>'


def visual(v, where):
    t = v.get("type")
    if t not in VISUAL_KEYS or VISUAL_KEYS[t] not in v:
        sys.exit(f"{where}: bad visual {v.get('title', t)!r}")
    if t == "flow":
        n = len(v["steps"])
        row_count = max(1, (n + 3) // 4)
        row_size = max(1, (n + row_count - 1) // row_count)
        rows = []
        for start in range(0, n, row_size):
            steps = v["steps"][start:start + row_size]
            boxes = '<span class="arrow" aria-hidden="true">→</span>'.join(node(x, i=start + k) for k, x in enumerate(steps))
            cols = " 40px ".join("minmax(0,1fr)" for _ in steps)
            rows.append(f'<div class="flow" style="grid-template-columns:{cols}">{boxes}</div>')
        cont = '<div class="flow-continue" aria-hidden="true"><span class="flow-continue-label">Continues below</span><span class="arrow down">↓</span></div>'
        body = '<div class="flow-rows">' + cont.join(rows) + "</div>"
        boxes = v["steps"]
    elif t == "layers":
        boxes = v["layers"]
        body = '<div class="layers">' + "".join(node(x, "box layer", k) for k, x in enumerate(boxes)) + "</div>"
    elif t == "cards":
        boxes = v["items"]
        body = '<div class="cards">' + "".join(node(x, i=k) for k, x in enumerate(boxes)) + "</div>"
    elif t == "hub":
        boxes = [v["center"]] + v["items"]
        items = "".join(node(x, i=k) for k, x in enumerate(v["items"]))
        body = f'<div class="hub">{node(v["center"], "box center")}<span class="arrow down">↓</span><div class="cards">{items}</div></div>'
    else:
        boxes = []
        cols = v["columns"]
        for r in v["rows"]:
            if len(r) != len(cols):
                sys.exit(f"{where}: compare row {r[0]!r} has {len(r)} cells, expected {len(cols)}")
        head = "".join(f"<th>{esc(c)}</th>" for c in cols)
        rows = "".join("<tr>" + "".join(f"<{'th' if k == 0 else 'td'}>{rich(c)}</{'th' if k == 0 else 'td'}>" for k, c in enumerate(r)) + "</tr>" for r in v["rows"])
        body = f'<div class="scroll"><table class="compare"><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>'
    for b in boxes:
        if "label" not in b:
            sys.exit(f"{where}: box without label in {v.get('title', t)!r}")
    title = f'<p class="vtitle">{esc(v["title"])}</p>' if v.get("title") else ""
    caption = f'<p class="caption">{rich(v["caption"])}</p>' if v.get("caption") else ""
    panel = '<div class="detail" aria-live="polite">Select a box for details.</div>' if any(b.get("detail") for b in boxes) else ""
    return f'<figure class="visual v-{t}">{title}{body}{panel}{caption}</figure>'


def grid(t):
    head = "".join(f"<th>{esc(c)}</th>" for c in t["columns"])
    rows = "".join("<tr>" + "".join(f"<td>{rich(c)}</td>" for c in r) + "</tr>" for r in t["rows"])
    title = f'<p class="tabletitle">{esc(t["title"])}</p>' if t.get("title") else ""
    return f'{title}<div class="scroll"><table class="grid"><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>'


def source_link(s):
    path = s["path"]
    url = path if path.startswith("http") else f"{REPO}/blob/{BRANCH}/{path}"
    return f'<li><a href="{esc(url)}">{esc(s.get("label") or path)}</a>{" · " + rich(s["note"]) if s.get("note") else ""}</li>'


def section(s, where):
    parts = [f'<section id="{esc(s["id"])}"><h2>{esc(s["title"])}</h2>']
    if s.get("summary"):
        parts.append(f'<p class="summary">{rich(s["summary"])}</p>')
    parts += [f"<p>{rich(p)}</p>" for p in s.get("paragraphs", [])]
    parts += [visual(v, where) for v in s.get("visuals", [])]
    if s.get("notes"):
        parts.append('<ul class="notes">' + "".join(f"<li>{rich(n)}</li>" for n in s["notes"]) + "</ul>")
    parts += [grid(t) for t in s.get("tables", [])]
    if s.get("code"):
        parts.append(f'<pre class="code"><code>{esc(s["code"])}</code></pre>')
    if s.get("terms"):
        parts.append('<dl class="terms">' + "".join(f"<dt>{esc(t['term'])}</dt><dd>{rich(t['def'])}</dd>" for t in s["terms"]) + "</dl>")
    if s.get("sources"):
        parts.append('<p class="srchead">In the code</p><ul class="sources">' + "".join(source_link(x) for x in s["sources"]) + "</ul>")
    if s.get("qa"):
        parts.append("<h3>Questions to expect</h3>" + "".join(
            f'<details class="qa"><summary>{rich(x["q"])}</summary><div class="answer">{rich(x["a"])}</div></details>' for x in s["qa"]))
    parts.append("</section>")
    return "".join(parts)


def shell(title, body, nav):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)} · Rewind explainer</title><link rel="stylesheet" href="assets/style.css"><link rel="stylesheet" href="assets/sketch.css"><link rel="stylesheet" href="assets/site.css"></head>
<body><div class="layout">{nav}<main>{body}</main></div><script src="assets/app.js"></script></body></html>
"""


def sidebar(current, sections):
    links = []
    for p in SITE["pages"]:
        on = ' aria-current="page" class="on"' if p["slug"] == current else ""
        links.append(f'<li><a href="{p["slug"]}.html"{on}>{esc(p["title"])}</a></li>')
    toc = "".join(f'<li><a href="#{esc(s["id"])}">{esc(s["title"])}</a></li>' for s in sections)
    return f"""<aside class="sidebar"><a class="back" href="index.html">Rewind explainer</a>
<details class="toc" open><summary>On this page</summary><ul>{toc}</ul></details>
<details class="toc" open><summary>All pages</summary><ul>{"".join(links)}</ul></details></aside>"""


def page_cards():
    cards = "".join(
        f'<a class="topic" href="{p["slug"]}.html"><span class="num">{k}</span><span><strong>{esc(p["title"])}</strong>'
        f'<span class="desc">{esc(p["blurb"])}</span></span></a>'
        for k, p in enumerate(SITE["pages"][1:], 1))
    return f'<section id="pages"><h2>Pages</h2><div class="topics">{cards}</div></section>'


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(ROOT / "assets", OUT / "assets")
    pages = SITE["pages"]
    for k, p in enumerate(pages):
        f = ROOT / "content" / f"{p['slug']}.json"
        if not f.exists():
            print(f"skip {p['slug']}: no content yet")
            continue
        c = json.loads(f.read_text())
        where = f.name
        body = [f'<h1 id="top">{esc(c["title"])}</h1>', f'<p class="lede">{rich(c["lede"])}</p>']
        if c.get("intro"):
            body.append(f'<div class="card">{"".join(f"<p>{rich(x)}</p>" for x in c["intro"])}</div>')
        body += [section(s, where) for s in c["sections"]]
        sections = list(c["sections"])
        if p["slug"] == "index":
            body.append(page_cards())
            sections.append({"id": "pages", "title": "Pages"})
        prev = pages[k - 1] if k > 0 else None
        nxt = pages[k + 1] if k + 1 < len(pages) else None
        pn = (f'<a href="{prev["slug"]}.html">← {esc(prev["title"])}</a>' if prev else "") + \
             (f'<a class="next" href="{nxt["slug"]}.html">{esc(nxt["title"])} →</a>' if nxt else "")
        body.append(f'<nav class="pager">{pn}</nav>')
        body.append(f'<p class="muted small">Generated from <code>docs/site/content/{p["slug"]}.json</code> by <code>docs/site/build.py</code>.</p>')
        (OUT / f"{p['slug']}.html").write_text(shell(c["title"], "".join(body), sidebar(p["slug"], sections)))
        print(f"built {p['slug']}.html")


if __name__ == "__main__":
    build()
