#!/usr/bin/env python3
"""Convert GitHub JSON dumps to compact, LLM-friendly XML."""

import json
import re
from xml.sax.saxutils import escape


def short_date(iso):
    if not iso:
        return None
    return iso[:10]  # YYYY-MM-DD


def body_element(tag, text, indent, **attrs):
    text = (text or "").strip()
    attr_str = "".join(f' {k}="{escape(str(v))}"' for k, v in attrs.items() if v)
    if not text:
        return f"{indent}<{tag}{attr_str}/>"
    # Escape body text
    text = escape(text)
    return f"{indent}<{tag}{attr_str}>\n{indent}  {text}\n{indent}</{tag}>"


def fmt_comment(c, indent="    "):
    author = (c.get("author") or {}).get("login", "unknown")
    date = short_date(c.get("createdAt"))
    body = (c.get("body") or "").strip()
    if not body:
        return None
    body = escape(body)
    return f'{indent}<comment by="{author}" on="{date}">\n{indent}  {body}\n{indent}</comment>'


def fmt_reply(r, indent="      "):
    author = (r.get("author") or {}).get("login", "unknown")
    date = short_date(r.get("createdAt"))
    body = (r.get("body") or "").strip()
    if not body:
        return None
    body = escape(body)
    return f'{indent}<reply by="{author}" on="{date}">\n{indent}  {body}\n{indent}</reply>'


# ── Issues ────────────────────────────────────────────────────────────────────

with open("issues-dump.json") as f:
    issues = json.load(f)

lines = ['<?xml version="1.0" encoding="utf-8"?>', "<issues>"]
for issue in issues:
    n = issue["number"]
    state = issue["state"].lower()
    author = (issue.get("author") or {}).get("login", "unknown")
    created = short_date(issue.get("createdAt"))
    closed = short_date(issue.get("closedAt"))
    labels = ",".join(l["name"] for l in (issue.get("labels") or []))
    title = escape((issue.get("title") or "").strip())
    body = escape((issue.get("body") or "").strip())

    attrs = f'n="{n}" state="{state}" by="{author}" on="{created}"'
    if closed:
        attrs += f' closed="{closed}"'
    if labels:
        attrs += f' labels="{escape(labels)}"'

    lines.append(f"  <issue {attrs}>")
    lines.append(f"    <title>{title}</title>")
    if body:
        lines.append(f"    <body>{body}</body>")

    for c in issue.get("comments") or []:
        fc = fmt_comment(c)
        if fc:
            lines.append(fc)

    lines.append("  </issue>")

lines.append("</issues>")

with open("issues-dump.xml", "w") as f:
    f.write("\n".join(lines))

print(f"Issues: {len(issues)} written")


# ── PRs ───────────────────────────────────────────────────────────────────────

with open("prs-dump.json") as f:
    prs = json.load(f)

lines = ['<?xml version="1.0" encoding="utf-8"?>', "<prs>"]
for pr in prs:
    n = pr["number"]
    state = pr["state"].lower()
    author = (pr.get("author") or {}).get("login", "unknown")
    created = short_date(pr.get("createdAt"))
    closed = short_date(pr.get("closedAt"))
    labels = ",".join(l["name"] for l in (pr.get("labels") or []))
    title = escape((pr.get("title") or "").strip())
    body = escape((pr.get("body") or "").strip())

    attrs = f'n="{n}" state="{state}" by="{author}" on="{created}"'
    if closed:
        attrs += f' closed="{closed}"'
    if labels:
        attrs += f' labels="{escape(labels)}"'

    lines.append(f"  <pr {attrs}>")
    lines.append(f"    <title>{title}</title>")
    if body:
        lines.append(f"    <body>{body}</body>")

    for c in (pr.get("comments") or []):
        fc = fmt_comment(c)
        if fc:
            lines.append(fc)

    for r in (pr.get("reviews") or []):
        rbody = (r.get("body") or "").strip()
        if not rbody:
            continue
        rauthor = (r.get("author") or {}).get("login", "unknown")
        rdate = short_date(r.get("submittedAt") or r.get("createdAt"))
        rstate = r.get("state", "").lower()
        lines.append(f'    <review by="{rauthor}" on="{rdate}" state="{rstate}">')
        lines.append(f"      {escape(rbody)}")
        lines.append("    </review>")

    lines.append("  </pr>")

lines.append("</prs>")

with open("prs-dump.xml", "w") as f:
    f.write("\n".join(lines))

print(f"PRs: {len(prs)} written")


# ── Discussions ───────────────────────────────────────────────────────────────

with open("discussions-dump.json") as f:
    raw = json.load(f)

discussions = raw["data"]["repository"]["discussions"]["nodes"]

lines = ['<?xml version="1.0" encoding="utf-8"?>', "<discussions>"]
for d in discussions:
    n = d["number"]
    author = (d.get("author") or {}).get("login", "unknown")
    created = short_date(d.get("createdAt"))
    closed = short_date(d.get("closedAt"))
    category = (d.get("category") or {}).get("name", "")
    title = escape((d.get("title") or "").strip())
    body = escape((d.get("body") or "").strip())

    attrs = f'n="{n}" by="{author}" on="{created}"'
    if closed:
        attrs += f' closed="{closed}"'
    if category:
        attrs += f' category="{escape(category)}"'

    lines.append(f"  <discussion {attrs}>")
    lines.append(f"    <title>{title}</title>")
    if body:
        lines.append(f"    <body>{body}</body>")

    for c in (d.get("comments") or {}).get("nodes") or []:
        cauthor = (c.get("author") or {}).get("login", "unknown")
        cdate = short_date(c.get("createdAt"))
        cbody = (c.get("body") or "").strip()

        replies = (c.get("replies") or {}).get("nodes") or []
        reply_lines = [fmt_reply(r) for r in replies]
        reply_lines = [r for r in reply_lines if r]

        if not cbody and not reply_lines:
            continue

        if reply_lines:
            lines.append(f'    <comment by="{cauthor}" on="{cdate}">')
            if cbody:
                lines.append(f"      {escape(cbody)}")
            lines.extend(reply_lines)
            lines.append("    </comment>")
        else:
            if cbody:
                lines.append(f'    <comment by="{cauthor}" on="{cdate}">')
                lines.append(f"      {escape(cbody)}")
                lines.append("    </comment>")

    lines.append("  </discussion>")

lines.append("</discussions>")

with open("discussions-dump.xml", "w") as f:
    f.write("\n".join(lines))

print(f"Discussions: {len(discussions)} written")
