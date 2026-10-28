"""r17 "app frame parts": the rules for an app interface whose ui/bundle.lock.json declares ``"scripts"``.

Pure checks, each returning a refusal reason or None. ``hive/ui/src/lib/appFrame.ts`` applies the same rules before it
inlines anything (PROGRAMS.md §9). A bundle without a ``scripts`` key never reaches this module.

index.html must end with the canonical part block: the listed parts' module tags, in order, separated only by
whitespace, then ``</body>`` (and optionally ``</html>``). Everything before the block is scanned the way the browser
tokenizes it, so no tag can sit in a comment, an attribute value, a raw-text element or a template, where it would
never run. These checks are about the parts running; the CSP does not depend on them (the client writes it first).
"""
from __future__ import annotations

import re

PART_MAX = 600_000        # each file the frame inlines: index.html, style.css and every part
TOTAL_MAX = 1_800_000     # all of them together
MAX_PARTS = 3
PART_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,60}\.js\Z")       # no dots in the stem; \Z, so no trailing newline

WS = " \t\n\f\r"
RAW_TEXT = {"script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"}
REFUSED = {"template", "plaintext", "svg", "math", "frameset", "frame"}   # inert, foreign, or drops later scripts
ALPHA = re.compile(r"[A-Za-z]")
TAG_NAME = re.compile(r"[A-Za-z][^ \t\n\f\r/>]*")
TAIL = re.compile(r"[ \t\n\f\r]*</body>[ \t\n\f\r]*(?:</html>[ \t\n\f\r]*)?\Z")      # matched on ascii_lower text
_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def ascii_lower(text):
    """The browser folds only ASCII case in tag names, and str.lower() can change a string's length."""
    return text.translate(_LOWER)


def tag(name):
    return f'<script type="module" src="./{name}"></script>'


def lock_reason(lock):
    """The scripts list and the pins. With a list, the lock pins exactly index.html, style.css and the parts."""
    scripts, pinned = lock.get("scripts"), lock.get("files")
    if (not isinstance(scripts, list) or not 1 <= len(scripts) <= MAX_PARTS
            or not all(isinstance(s, str) and PART_NAME.fullmatch(s) for s in scripts)):
        return f"scripts lists 1 to {MAX_PARTS} plain .js file names (no dots before .js)"
    if len(set(scripts)) != len(scripts):
        return "scripts lists a part twice"
    if scripts[-1] != "app.js":
        return "app.js is the last of scripts"
    if not isinstance(pinned, dict):
        return "bundle.lock.json lists the bundle's files and their sha256"
    want = {"index.html", "style.css", *scripts}
    for name in ("index.html", "style.css", *scripts):
        if name not in pinned:
            return f"{name} is not pinned in bundle.lock.json"
    extra = sorted(set(pinned) - want)
    if extra:
        return f"unlisted file {extra[0]} (with scripts, the lock pins exactly index.html, style.css and the parts)"
    return None


def disk_reason(present, pinned):
    """What is on disk must be exactly what the lock pins."""
    for name in sorted(set(pinned) - present):
        return f"pinned file {name} is missing"
    for name in sorted(present - set(pinned)):
        return f"file {name} is not pinned in bundle.lock.json"
    return None


def size_reason(sizes):
    """``sizes``: {name: UTF-8 byte count}."""
    for name, size in sizes.items():
        if size > PART_MAX:
            return f"{name} is over {PART_MAX} bytes"
    if sum(sizes.values()) > TOTAL_MAX:
        return f"the interface is over {TOTAL_MAX} bytes in all"
    return None


def part_reason(name, text):
    """``<!--`` inside an inlined script switches the browser's script-data state, so its closing tag may no longer
    close it and the next part would be swallowed."""
    if "<!--" in text:
        return f"{name} contains <!--, which would change where its inlined script ends"
    return None


def html_reason(html, scripts):
    """index.html: one tag per part, in order, as the canonical block at the end of the body, with live markup
    before it."""
    at = -1
    for name in scripts:
        if html.count(tag(name)) != 1:
            return f"index.html needs exactly one {tag(name)}"
        if html.index(tag(name)) < at:
            return "index.html tags the script parts out of their listed order"
        at = html.index(tag(name))
    if ascii_lower(html).count("<script") != len(scripts):
        return "index.html has a script tag for an unlisted file"
    start = html.index(tag(scripts[0]))
    end = start + len(tag(scripts[0]))
    for name in scripts[1:]:
        nxt = html.index(tag(name), end)
        if html[end:nxt].strip(WS):
            return "index.html keeps the part tags together, with only whitespace between them"
        end = nxt + len(tag(name))
    if not TAIL.match(ascii_lower(html), end):
        return "index.html ends with the part tags, then </body>"
    reason, starts = _scan(html[:start])
    if reason:
        return reason
    # The client writes the stylesheet over the first link, so that must be a real tag. (The CSP no longer depends
    # on index.html: the client writes it ahead of all app markup.)
    link = '<link rel="stylesheet" href="./style.css">'
    if starts.get(html.find(link)) != "link":
        return f"index.html needs a real {link} tag before the part tags"
    return None


def _skip_tag(s, k):
    """From just after a tag name to just after its '>', following the HTML tokenizer's attribute states; -1 if the
    tag never closes (an open quote would swallow the rest of the page)."""
    n = len(s)
    while True:
        while k < n and (s[k] in WS or s[k] == "/"):
            k += 1
        if k >= n:
            return -1
        if s[k] == ">":
            return k + 1
        k += 1                                               # first name character, '=' included
        while k < n and s[k] not in WS and s[k] not in "/>=":
            k += 1
        while k < n and s[k] in WS:
            k += 1
        if k < n and s[k] == "=":
            k += 1
            while k < n and s[k] in WS:
                k += 1
            if k < n and s[k] in "\"'":
                close = s.find(s[k], k + 1)
                if close < 0:
                    return -1
                k = close + 1
            else:
                while k < n and s[k] not in WS and s[k] != ">":
                    k += 1


def _raw_end(low, name, k):
    """Where a raw-text element ends: ``</name`` followed by whitespace, '/' or '>' (the browser's appropriate end
    tag); -1 if it never does."""
    while True:
        k = low.find("</" + name, k)
        if k < 0:
            return -1
        after = k + 2 + len(name)
        if after < len(low) and (low[after] in WS or low[after] in "/>"):
            return k
        k = after


def inert_reason(prefix):
    """None when the markup before the part block ends in the browser's data state: no comment, no open tag or quote,
    no unclosed raw-text element, no template or foreign content."""
    return _scan(prefix)[0]


def _scan(prefix):
    """(reason or None, {position: name} of every real start tag)."""
    s, low, i, starts = prefix, ascii_lower(prefix), 0, {}
    while True:
        j = s.find("<", i)
        if j < 0:
            return None, starts
        if low.startswith("<!--", j):
            return "index.html has a comment before the part tags", starts
        nxt = s[j + 1:j + 2]
        if nxt in ("!", "?") or (nxt == "/" and not ALPHA.match(s, j + 2)):
            close = s.find(">", j)                           # doctype or bogus comment: ends at the first '>'
            if close < 0:
                return "index.html has unclosed markup before the part tags", starts
            i = close + 1
            continue
        end_tag = nxt == "/"
        m = TAG_NAME.match(s, j + (2 if end_tag else 1))
        if not m:
            i = j + 1                                        # a bare '<' is text
            continue
        name = ascii_lower(m.group(0))
        k = _skip_tag(s, m.end())
        if k < 0:
            return f"index.html has an unclosed <{name}> tag before the part tags", starts
        if not end_tag and name in REFUSED:
            return f"index.html has <{name}> before the part tags", starts
        if not end_tag and name in RAW_TEXT:
            k = _raw_end(low, name, k)
            if k < 0:
                return f"index.html has an unclosed <{name}> before the part tags", starts
        if not end_tag:
            starts[j] = name
        i = k
