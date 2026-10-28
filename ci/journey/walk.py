"""The newcomer's journey after install, in a real browser (test tooling only; no AI key anywhere).

Opens the one-use sign-in link through the tunnel's port (127.0.0.1:8701 -> 8700), then walks the tester guide's
section 5 (First Light) and section 6 (OmegaAssist), and looks for a way into Studio. Every step gets a full-page
screenshot and a row in steps.json (step, URL, visible heading, pass/fail, error). Console errors, page errors and
failed or refused requests are kept per step. Where a step needs a key, the walk takes the page's own Not now / Later
and records what the page said. The sign-in code comes in through the environment and is never written anywhere.

usage: python walk.py OUT_DIR   (env JOURNEY_BASE=http://127.0.0.1:8701, JOURNEY_CODE=<43-char code>)
"""
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
BASE = os.environ["JOURNEY_BASE"].rstrip("/")
CODE = os.environ.pop("JOURNEY_CODE", "")
SIGNIN = re.compile(r"(local-signin)#[A-Za-z0-9_-]*")
LONG = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])")


def red(value):
    s = SIGNIN.sub(r"\1#<redacted>", str(value if value is not None else ""))
    if CODE:
        s = s.replace(CODE, "<redacted>")
    return LONG.sub("<redacted-43>", s)


steps, events = [], []
state = {"n": 0, "step": "start"}


def save():
    with open(os.path.join(OUT, "steps.json"), "w") as f:
        json.dump({"base": BASE, "steps": steps}, f, indent=2)
    with open(os.path.join(OUT, "events.json"), "w") as f:
        json.dump(events, f, indent=2)


def note_event(kind, text, url=""):
    events.append({"step": state["step"], "kind": kind, "text": red(text)[:2000], "url": red(url)[:500]})


PROBE = """() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]') };
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const heads = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter(vis).map(txt).filter(Boolean);
  const dlg = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).map((d) => txt(d).slice(0, 300));
  const panel = document.querySelector('section.fl-panel');
  const layer = document.querySelector('.fl-layer');
  const marks = [...document.querySelectorAll('.fl-mark')].map((m) => m.getAttribute('aria-label'));
  const buttons = [...document.querySelectorAll('button,a[href],[role=button],[role=link],[role=tab],[role=menuitem]')]
    .filter(vis).map((b) => (b.getAttribute('aria-label') || txt(b)).slice(0, 60)).filter(Boolean);
  const alerts = [...document.querySelectorAll('[role=alert],[role=status],.fl-error,.fl-notice')].filter(vis).map(txt).filter(Boolean);
  const frames = [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('title') || f.getAttribute('src') || 'iframe');
  return { title: document.title, heads: heads.slice(0, 8), dialogs: dlg.slice(0, 3),
    fl: panel && vis(panel) ? txt(panel).slice(0, 900) : null,
    fl_beat: layer ? layer.getAttribute('data-beat') : null, fl_step: layer ? layer.getAttribute('data-step') : null,
    fl_path: layer ? layer.getAttribute('data-path') : null, marks,
    buttons: [...new Set(buttons)].slice(0, 60), alerts: alerts.slice(0, 8), iframes: frames,
    body: txt(document.body).slice(0, 1500) };
}"""


def probe(page):
    try:
        info = page.evaluate(PROBE)
    except Exception as e:  # noqa: BLE001
        info = {"probe_error": str(e)[:300]}
    fr = []
    for f in page.frames[1:]:
        try:
            fr.append({"url": red(f.url)[:200], "heads": f.evaluate(
                "() => [...document.querySelectorAll('h1,h2,h3')].map(h => h.innerText.trim()).filter(Boolean).slice(0,6)"),
                "body": red(f.evaluate("() => (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').trim().slice(0,1500)")),
                "buttons": f.evaluate("() => [...document.querySelectorAll('button,a[href],[role=button]')].map(b => (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0,60)).filter(Boolean).slice(0,40)")})
        except Exception as e:  # noqa: BLE001
            fr.append({"url": red(f.url)[:200], "error": str(e)[:200]})
    info["frames"] = fr
    return info


def heading_of(info):
    if info.get("fl"):
        return "First Light: " + (info["fl"][:240])
    for key in ("dialogs", "heads"):
        if info.get(key):
            return info[key][0][:240]
    for f in info.get("frames", []):
        if f.get("heads"):
            return f["heads"][0][:240]
    return info.get("title", "")


def snap(page, name, ok=True, note="", error=""):
    state["n"] += 1
    fn = f"{state['n']:02d}-{name}.png"
    try:
        page.screenshot(path=os.path.join(OUT, fn), full_page=True)
    except Exception as e:  # noqa: BLE001
        error = (error + f" (screenshot failed: {e})").strip()
    info = probe(page)
    row = {"n": state["n"], "step": name, "url": red(page.url), "heading": red(heading_of(info)),
           "pass": bool(ok), "note": red(note), "error": red(error), "screenshot": fn,
           "page": json.loads(red(json.dumps(info)))}
    steps.append(row)
    print(f"[{row['n']:02d}] {'PASS' if ok else 'FAIL'} {name} | {row['url']} | {row['heading'][:120]} | {row['note'][:160]} {row['error'][:200]}", flush=True)
    save()
    return info


def visible(loc, timeout=0):
    try:
        if timeout:
            loc.first.wait_for(state="visible", timeout=timeout)
        return loc.first.is_visible()
    except Exception:  # noqa: BLE001
        return False


def click(loc, timeout=5000):
    loc.first.click(timeout=timeout)


def settle(page, ms=1500):
    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:  # noqa: BLE001
        pass
    page.wait_for_timeout(ms)


def run():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = ctx.new_page()
        page.on("console", lambda m: m.type in ("error", "warning") and note_event("console-" + m.type, m.text, m.location.get("url", "") if m.location else ""))
        page.on("pageerror", lambda e: note_event("pageerror", str(e)))
        page.on("requestfailed", lambda r: note_event("requestfailed", f"{r.method} {r.failure}", r.url))
        page.on("response", lambda r: r.status >= 400 and note_event("http-" + str(r.status), f"{r.request.method} {r.status}", r.url))

        # ---- sign in: the link the hive printed, through the tunnel's port ----
        state["step"] = "signin"
        try:
            page.goto(f"{BASE}/local-signin#{CODE}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_url(lambda u: "local-signin" not in u, timeout=30000)
            settle(page, 4000)
            has_token = page.evaluate("() => { try { return !!localStorage.getItem('omegadots.hive.token') } catch (e) { return false } }")
            snap(page, "signin", ok=has_token, note=f"browser holds a session: {has_token}")
        except Exception as e:  # noqa: BLE001
            snap(page, "signin", ok=False, error=str(e)[:400])
            return
        finally:
            pass

        # ---- section 5: First Light ----
        state["step"] = "arrive"
        page.wait_for_timeout(4000)
        info = snap(page, "arrive-landing", note="what a newcomer sees first after the sign-in link")
        if visible(page.get_by_role("button", name=re.compile(r"Explore on my own", re.I))):
            click(page.get_by_role("button", name=re.compile(r"Explore on my own", re.I)))
            settle(page)
            info = snap(page, "arrive-welcome-explore", note="Welcome dialog answered with Explore on my own")

        way = None
        if info.get("fl"):
            way = "it opened by itself"
        if not way:
            cand = page.get_by_role("button", name=re.compile(r"first light|finish setting up|set me up|set up your hive|get started|start setup", re.I))
            link = page.get_by_role("link", name=re.compile(r"first light|finish setting up|set me up|set up your hive|get started", re.I))
            for loc, what in ((cand, "button"), (link, "link")):
                if visible(loc):
                    label = (loc.first.get_attribute("aria-label") or loc.first.inner_text() or "").strip()
                    click(loc)
                    settle(page)
                    way = f"{what} '{label[:60]}'"
                    break
        if way and not visible(page.locator("section.fl-panel"), 8000) and "first light" not in way.lower():
            snap(page, "firstlight-way-in-page", note=f"pressed {way}; First Light not yet open")
            cand = page.get_by_role("button", name=re.compile(r"first light|start|begin|continue", re.I))
            if visible(cand):
                label = (cand.first.inner_text() or "").strip()
                click(cand)
                settle(page)
                way += f", then '{label[:60]}'"
        if not visible(page.locator("section.fl-panel"), 3000):
            box = page.get_by_role("textbox").filter(has_not=page.locator("[type=password]"))
            if visible(box):
                try:
                    box.first.click(timeout=3000)
                    box.first.fill("start first light")
                    box.first.press("Enter")
                    settle(page)
                    if visible(page.locator("section.fl-panel"), 8000):
                        way = (way + "; " if way else "") + "typed 'start first light' in the Ask"
                except Exception as e:  # noqa: BLE001
                    note_event("walk", f"Ask way in failed: {e}")
        if not visible(page.locator("section.fl-panel"), 2000):
            page.goto(f"{BASE}/#/first-light", wait_until="domcontentloaded")
            settle(page, 3000)
            if visible(page.locator("section.fl-panel"), 10000):
                way = (way + "; " if way else "") + "address #/first-light (no visible way in found)"
        fl_open = visible(page.locator("section.fl-panel"), 5000)
        info = snap(page, "firstlight-open", ok=fl_open, note=f"way in: {way}", error="" if fl_open else "First Light did not open")

        walked = {"role": 0, "look": 0, "key": 0, "limit": 0, "apps": 0, "ask": 0, "wake": 0, "next": 0}
        apps_seen = []
        last_sig, same_since = None, time.time()
        deadline = time.time() + 420
        ended_how = "time ran out"
        panel = page.locator("section.fl-panel")
        while time.time() < deadline:
            if not visible(panel):
                ended_how = "panel closed"
                break
            info = probe(page)
            sig = (info.get("fl_step"), info.get("fl"))
            if sig != last_sig:
                state["step"] = f"fl-{info.get('fl_beat')}-{info.get('fl_step')}"
                snap(page, f"fl-{info.get('fl_beat')}-{info.get('fl_step')}", note=f"beat {info.get('fl_beat')} step {info.get('fl_step')} path {info.get('fl_path')}")
                last_sig, same_since = sig, time.time()
            beat = info.get("fl_beat")
            acted = False
            try:
                role = panel.get_by_role("group", name="What you will mostly do")
                look_keep = panel.get_by_role("button", name="Keep the look I have")
                key_card = panel.locator("[data-presence-region]").filter(has=page.get_by_role("button", name=re.compile("added it")))
                limit = panel.get_by_role("group", name="Your monthly limit")
                apps = panel.locator('[data-presence-region="fl-apps"]')
                ask = panel.locator('[data-presence-region="fl-ask"]')
                wake = panel.locator('[data-presence-region="fl-wake"]')
                start = panel.locator('[data-presence-region="fl-start"]')
                if walked["role"] < 2 and visible(role):
                    click(role.get_by_role("button", name="Build and code"))
                    walked["role"] += 1
                    acted = True
                elif walked["look"] < 2 and visible(look_keep):
                    click(look_keep)
                    walked["look"] += 1
                    acted = True
                elif walked["key"] < 2 and visible(key_card) and visible(key_card.get_by_role("button", name="Not now")):
                    snap(page, "fl-models-key-card", note="needs a key: the walk presses Not now (no key in CI)")
                    click(key_card.get_by_role("button", name="Not now"))
                    walked["key"] += 1
                    acted = True
                elif walked["limit"] < 2 and visible(limit):
                    click(limit.get_by_role("button", name="$5", exact=True))
                    walked["limit"] += 1
                    acted = True
                elif walked["apps"] < 2 and visible(apps) and visible(apps.get_by_role("button", name="Next")):
                    apps_seen = [t.strip() for t in apps.locator("li").all_inner_texts()]
                    snap(page, "fl-apps-card", note=f"apps offered: {apps_seen}")
                    click(apps.get_by_role("button", name="Next"))
                    walked["apps"] += 1
                    acted = True
                elif walked["ask"] < 2 and visible(ask) and visible(ask.get_by_role("button", name="Save")):
                    ask.get_by_label("Its name").fill("Wren")
                    how = ask.locator("textarea")
                    if visible(how) and how.first.is_enabled():
                        how.first.fill("warm and brief, plain words")
                    snap(page, "fl-ask-filled", note="named the Ask Wren")
                    click(ask.get_by_role("button", name="Save"))
                    page.wait_for_timeout(2500)
                    err = ask.locator(".fl-error")
                    snap(page, "fl-ask-saved", ok=not visible(err), error=err.first.inner_text() if visible(err) else "")
                    walked["ask"] += 1
                    acted = True
                elif walked["wake"] < 1 and visible(wake) and visible(wake.get_by_role("button", name="Wake")):
                    snap(page, "fl-hello-wake-card", note="Wake needs a key to think; the walk presses it once to record what the page says")
                    click(wake.get_by_role("button", name="Wake"))
                    page.wait_for_timeout(8000)
                    snap(page, "fl-hello-after-wake", note="after pressing Wake with no key")
                    walked["wake"] += 1
                    acted = True
                elif visible(start) and visible(start.get_by_role("button", name=re.compile("^Open "))):
                    snap(page, "fl-start-card")
                    click(start.get_by_role("button", name=re.compile("^Open ")))
                    settle(page, 3000)
                    ended_how = "pressed Open (hand-off)"
                    break
            except Exception as e:  # noqa: BLE001
                note_event("walk", f"action failed at {beat}: {e}")
            if acted:
                settle(page, 1200)
                continue
            if time.time() - same_since > 25:
                ctl = panel.get_by_role("group", name="First Light controls")
                nxt = ctl.get_by_role("button", name="Next", exact=True)
                later = ctl.get_by_role("button", name="Later", exact=True)
                close = ctl.get_by_role("button", name="Close", exact=True)
                if walked["next"] < 12 and visible(nxt) and nxt.first.is_enabled():
                    snap(page, f"fl-stuck-{info.get('fl_step')}", note="nothing moved for 25s; pressing Next")
                    click(nxt)
                    walked["next"] += 1
                elif walked["next"] < 12 and visible(later):
                    snap(page, f"fl-stuck-{info.get('fl_step')}", note="nothing moved for 25s and Next is not on; pressing Later")
                    click(later)
                    walked["next"] += 1
                elif visible(close):
                    snap(page, "fl-last-line", note="the last line of First Light; pressing Close")
                    click(close)
                    ended_how = "pressed Close on the last line"
                    break
                else:
                    snap(page, f"fl-dead-end-{info.get('fl_step')}", ok=False, error="no way on (no Next, Later or Close)")
                    ended_how = "dead end"
                    break
                same_since = time.time()
                settle(page, 1200)
                continue
            page.wait_for_timeout(1000)
        info = probe(page)
        state["step"] = "fl-end"
        snap(page, "firstlight-end", ok=ended_how not in ("dead end", "time ran out"),
             note=f"ended: {ended_how}; walked {walked}; apps offered {apps_seen}; marks {info.get('marks')}")

        # ---- section 5.7 / 6: OmegaAssist ----
        state["step"] = "omegaassist"
        in_app = "#/program/" in page.url
        if not in_app:
            apps_nav = page.get_by_role("link", name=re.compile(r"^apps$", re.I))
            apps_btn = page.get_by_role("button", name=re.compile(r"^apps$", re.I))
            if visible(apps_nav):
                click(apps_nav)
            elif visible(apps_btn):
                click(apps_btn)
            else:
                page.goto(f"{BASE}/#/programs", wait_until="domcontentloaded")
            settle(page, 3000)
            snap(page, "apps-page", note="the hive's Apps")
            oa = page.get_by_role("button", name=re.compile("OmegaAssist")).or_(page.get_by_role("link", name=re.compile("OmegaAssist")))
            if visible(oa):
                click(oa)
            elif visible(page.get_by_text("OmegaAssist")):
                click(page.get_by_text("OmegaAssist"))
            settle(page, 3000)
            opn = page.get_by_role("button", name=re.compile(r"^open( omegaassist)?$", re.I))
            if "#/program/" not in page.url and visible(opn):
                click(opn)
                settle(page, 3000)
        page.wait_for_timeout(6000)
        info = probe(page)
        in_app = "#/program/" in page.url or any("assist" in (f.get("url") or "").lower() for f in info.get("frames", []))
        snap(page, "omegaassist-open", ok=in_app, error="" if in_app else "OmegaAssist did not open")

        sent = False
        targets = [page] + list(page.frames[1:])
        for t in targets:
            try:
                box = t.locator("textarea, [contenteditable=true], input[type=text]")
                if box.count() and box.first.is_visible():
                    box.first.click(timeout=3000)
                    box.first.fill("hello")
                    box.first.press("Enter")
                    sent = True
                    break
            except Exception as e:  # noqa: BLE001
                note_event("walk", f"typing hello failed: {e}")
        page.wait_for_timeout(15000)
        snap(page, "omegaassist-hello", ok=sent, note="typed hello and pressed Enter (no key: the answer, if any, is what the page says)",
             error="" if sent else "no text box found")

        # ---- Studio, if there is a way in ----
        state["step"] = "studio"
        found = None
        for t in [page] + list(page.frames[1:]):
            try:
                loc = t.get_by_role("button", name=re.compile("Studio")).or_(t.get_by_role("link", name=re.compile("Studio")))
                if loc.count() and loc.first.is_visible():
                    found = (t, loc)
                    break
            except Exception:  # noqa: BLE001
                pass
        if not found:
            page.goto(f"{BASE}/#/programs", wait_until="domcontentloaded")
            settle(page, 3000)
            loc = page.get_by_role("button", name=re.compile("Studio")).or_(page.get_by_role("link", name=re.compile("Studio")))
            if visible(loc):
                found = (page, loc)
            elif visible(page.get_by_text(re.compile("Studio"))):
                found = (page, page.get_by_text(re.compile("Studio")))
        if found:
            label = (found[1].first.get_attribute("aria-label") or found[1].first.inner_text() or "").strip()
            click(found[1])
            settle(page, 6000)
            snap(page, "studio-open", note=f"pressed '{label[:60]}'")
        else:
            snap(page, "studio-no-way-in", ok=False, error="no Studio button or link on the Apps page or in OmegaAssist")
        browser.close()


try:
    run()
finally:
    save()
    fails = [s["step"] for s in steps if not s["pass"]]
    print(f"steps {len(steps)}, failed {len(fails)}: {fails}; events {len(events)}", flush=True)
