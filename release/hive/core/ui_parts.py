# Purpose: the rules an app's page must meet in the app frame: the r17 parts checks, the single-file frame's tags and
# policy, and the rules that follow from them for Create's minds: FRAME_RULE for those that build a page, built on one
# FRAME_DOCUMENT with FRAME_CHECK_RULE for the test author who writes its acceptance check, and FRAME_PLAN_RULE for the
# planner.
"""r17 "app frame parts": the rules for an app interface whose ui/bundle.lock.json declares ``"scripts"``.

Pure checks, each returning a refusal reason or None. ``hive/ui/src/lib/appFrame.ts`` applies the same rules before it
inlines anything (PROGRAMS.md §9). A bundle without a ``scripts`` key never reaches these checks; its single-file frame
finds its stylesheet link with ``frame_tags`` and how it loads ./app.js, a module or a classic script, with
``frame_script``, on the same tokenizing.

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


# The single-file app frame (hive/ui/src/lib/appFrame.ts appDocument, create_plan_ports.frame_document): the two tags by
# which index.html loads its style and code, which the frame replaces with the files' text, and the policy it shows the
# page under. FRAME_DOCUMENT is the page the frame shows, said once; FRAME_RULE says what follows for a page in the
# words every Create mind that builds one is given, FRAME_PLAN_RULE what its planner needs of it, and FRAME_CHECK_RULE
# what follows for its acceptance check, in the words its test author is given, so none of them can plan, check or
# build a page the frame won't run: on staging (acceptance-tests#30, 21 Nov) a plan gave its one piece index.html alone
# and its probe read "self-contained" as no link or script tags, and no page passed.
FRAME_LINK = '<link rel="stylesheet" href="./style.css">'
FRAME_SCRIPT = '<script type="module" src="./app.js"></script>'
FRAME_DOCUMENT = (f"index.html, with the text of style.css and app.js put in place of the {FRAME_LINK} and "
                  f"{FRAME_SCRIPT} that load them")


def frame_csp(nonce):
    """The frame's Content-Security-Policy for a document whose style and script carry `nonce`: the string appFrame.ts
    frameCsp writes, which a test holds this one to."""
    return (f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; "
            "connect-src 'none'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'")


FRAME_RULE = (
    f"The app frame shows a page as one document: {FRAME_DOCUMENT}, under the Content-Security-Policy "
    f"\"{frame_csp('<nonce>')}\". So a "
    "page's style is written in style.css and its code in app.js, and a <style> or <script> written into index.html "
    "itself never runs (a style attribute does). A page is self-contained when it loads nothing from another origin, "
    "no http:, https: or // address: its style.css and app.js, and any image or font of the app that index.html or "
    "style.css names as ./its-name, are part of it. The acceptance check plays the page as the frame composes it, with "
    "those two tags already replaced.")

# The test author reads its rules in its goal, of which a mind reads 4,000 characters in one result
# (hive_goal_get.DETAIL_CHARS, all a goal keeps), and the whole FRAME_RULE took the author's goal to 4,070 (the gate of
# 22 Nov, test_create_step_rules_in_goal): the check needs the document it plays and what self-contained counts, not
# the policy or where a page's style and code are written, which are its builders'.
FRAME_CHECK_RULE = (
    f"The acceptance check plays a page as the app frame shows it, one document: {FRAME_DOCUMENT}. So a case for "
    "self-contained counts what the page loads from another origin, such as [src^=\"http\"], [href^=\"http\"], "
    "[src^=\"//\"] and [href^=\"//\"], never those two tags.")

# The planner reads its plan's whole shape and rules in its goal too (create_plan_ports.task_text), and the 21 plan
# rules leave no room there for the whole FRAME_RULE: with it the planner's goal ran to 4,448 characters with no room
# for the person's words (v0.43's gate, 24 Nov). A plan needs where a page's style and code go and what self-contained
# means, which acceptance-tests#30's planner misread, not the frame's policy or document, which are its builders'.
FRAME_PLAN_RULE = (
    "The app frame runs a page's style and code only from style.css and app.js, whose text it puts in place of the two "
    "tags in index.html that load them. So a page's style goes in style.css and its code in app.js, and a "
    "self-contained page loads nothing from another origin.")


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
    if starts.get(html.find(FRAME_LINK)) != "link":
        return f"index.html needs a real {FRAME_LINK} tag before the part tags"
    return None


def _tag_attrs(s, k):
    """From just after a tag name to just after its '>', following the HTML tokenizer's attribute states: (its
    attributes, names ASCII-lowercased and the first of a repeated name kept, values quoted either way or bare, where
    the tag ends). The end is -1 if the tag never closes (an open quote would swallow the rest of the page)."""
    n, attrs = len(s), {}
    while True:
        while k < n and (s[k] in WS or s[k] == "/"):
            k += 1
        if k >= n:
            return attrs, -1
        if s[k] == ">":
            return attrs, k + 1
        first = k
        k += 1                                               # first name character, '=' included
        while k < n and s[k] not in WS and s[k] not in "/>=":
            k += 1
        name, value = ascii_lower(s[first:k]), ""
        while k < n and s[k] in WS:
            k += 1
        if k < n and s[k] == "=":
            k += 1
            while k < n and s[k] in WS:
                k += 1
            if k < n and s[k] in "\"'":
                close = s.find(s[k], k + 1)
                if close < 0:
                    return attrs, -1
                value, k = s[k + 1:close], close + 1
            else:
                bare = k
                while k < n and s[k] not in WS and s[k] != ">":
                    k += 1
                value = s[bare:k]
        attrs.setdefault(name, value)


def _skip_tag(s, k):
    return _tag_attrs(s, k)[1]


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


# what a script's type may say and still be a classic script (the HTML spec's JavaScript MIME type essences, or none)
JS_TYPES = frozenset(("", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript",
                      "application/x-javascript", "text/x-javascript", "text/jscript", "text/livescript"))


def frame_tags(html):
    """A single-file frame (no scripts list): where index.html loads style.css and app.js, as ((start, end) of its
    first stylesheet link to ./style.css, (start, end) of its first module script element for ./app.js, end tag
    included), read the way the browser tokenizes: any quoting, attribute order, case or other attributes, never a
    tag inside a comment or a raw-text element. None for a file it doesn't load that way. A classic script is not
    taken here, since inlined as a module it would run differently; frame_script takes one as itself.
    appFrameParts.ts frameTags is the same rule. Time: one pass over html."""
    link, script, _classic, _kind = _frame_scan(html)
    return link, script


def frame_script(html):
    """How index.html loads ./app.js: ((start, end), kind) of its first module script for it, else of its first
    classic one, kind "module", "classic" (runs where it stands) or "deferred" (a classic script with defer or async,
    which runs once the page is parsed); (None, None) when it loads none. A page builder rewrote a scaffold's module
    tag as <script src='./app.js'> on the published v0.39 (19 Nov), which a browser runs and the frame refused, so the
    frame now takes a classic script and inlines it as one. appFrameParts.ts frameScript is the same rule."""
    _link, script, classic, kind = _frame_scan(html)
    return (script, "module") if script else (classic, kind) if classic else (None, None)


def _frame_scan(html):
    """frame_tags' one tokenizing pass, also noting the first classic script for ./app.js and whether it is deferred.
    Time: one pass over html."""
    s, low, i, link, script, classic, kind = html, ascii_lower(html), 0, None, None, None, None
    while link is None or script is None:
        j = s.find("<", i)
        if j < 0:
            break
        if low.startswith("<!--", j):
            if low.startswith("<!-->", j) or low.startswith("<!--->", j):   # an empty comment closes at once
                i = s.find(">", j) + 1
                continue
            close = s.find("-->", j + 4)
            if close < 0:
                break
            i = close + 3
            continue
        nxt = s[j + 1:j + 2]
        if nxt in ("!", "?") or (nxt == "/" and not ALPHA.match(s, j + 2)):
            close = s.find(">", j)                           # doctype or bogus comment: ends at the first '>'
            if close < 0:
                break
            i = close + 1
            continue
        end_tag = nxt == "/"
        m = TAG_NAME.match(s, j + (2 if end_tag else 1))
        if not m:
            i = j + 1                                        # a bare '<' is text
            continue
        name = ascii_lower(m.group(0))
        attrs, k = _tag_attrs(s, m.end())
        if k < 0:
            break
        if end_tag:
            i = k
            continue
        if (name == "link" and link is None and "stylesheet" in re.split("[ \t\n\f\r]+", ascii_lower(attrs.get("rel", "")))
                and attrs.get("href", "").strip(WS) == "./style.css"):
            link = (j, k)
        if name in RAW_TEXT:
            close = _raw_end(low, name, k)
            close = s.find(">", close) if close >= 0 else -1
            if close < 0:
                break
            if name == "script" and attrs.get("src", "").strip(WS) == "./app.js":
                kind_of = ascii_lower(attrs.get("type", "")).strip(WS)
                if kind_of == "module" and script is None:
                    script = (j, close + 1)
                elif kind_of in JS_TYPES and classic is None:
                    classic = (j, close + 1)
                    kind = "deferred" if ("defer" in attrs or "async" in attrs) else "classic"
            i = close + 1
            continue
        i = k
    return link, script, classic, kind


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
