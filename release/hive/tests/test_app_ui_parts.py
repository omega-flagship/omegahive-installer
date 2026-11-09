"""r17 "app frame parts": ui/bundle.lock.json may declare up to 3 ordered script parts, app.js last, each pinned."""
import hashlib
import json
import pathlib

import pytest

from hive.core import ui_parts

from hive.tests.test_app_ui import FILES
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

PARTS = ["native-three.js", "native-three-addons.js", "app.js"]


def page(names):
    tags = "".join(f'<script type="module" src="./{n}"></script>' for n in names)
    return f'<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body>{tags}</body></html>'


def bundle(names=PARTS, html=None):
    files = {"index.html": html if html is not None else page(names), "style.css": "body{}"}
    files.update({n: f"globalThis.part_{i} = {i}" for i, n in enumerate(names)})
    return files


def install(client, tmp_path, files, scripts=PARTS, pin=None, extra_lock=None):
    app = tmp_path / "demo-app"
    (app / "ui").mkdir(parents=True)
    (app / "plugin.json").write_text(json.dumps({"id": "demo", "name": "Demo", "version": "0.1"}))
    for n, t in files.items():
        (app / "ui" / n).write_text(t)
    lock = {"files": {n: hashlib.sha256(t.encode()).hexdigest() for n, t in files.items() if pin is None or n in pin}}
    if scripts is not None:
        lock["scripts"] = scripts
    lock.update(extra_lock or {})
    (app / "ui" / "bundle.lock.json").write_text(json.dumps(lock))
    hive = client.app.state.hive
    hive.programs.programs["demo"] = {"id": "demo", "name": "Demo", "version": "0.1", "description": "", "icon": None,
                                      "capabilities": [], "source": "test", "path": str(app), "module": None, "error": None,
                                      "digest": hive.programs.source_digest(app)}
    return app


def refused(client, needle):
    r = client.get("/api/programs/demo/ui")
    assert r.status_code == 422, r.text
    body = r.json()
    assert "bad_app_ui" in json.dumps(body) and needle in json.dumps(body), body


def test_three_parts_are_served_in_order(client, tmp_path):
    files = bundle()
    install(client, tmp_path, files)
    out = client.get("/api/programs/demo/ui").json()
    assert out["scripts"] == PARTS
    assert out["files"] == files
    assert set(out) == {"program", "files", "scripts", "release"}
    assert out["release"] == {"digest": client.app.state.hive.programs.programs["demo"]["digest"]}


def test_one_part_list(client, tmp_path):
    install(client, tmp_path, bundle(["app.js"]), scripts=["app.js"])
    out = client.get("/api/programs/demo/ui").json()
    assert out["scripts"] == ["app.js"] and set(out["files"]) == {"index.html", "app.js", "style.css"}


def test_no_scripts_list_is_unchanged(client, tmp_path):
    install(client, tmp_path, dict(FILES), scripts=None)
    out = client.get("/api/programs/demo/ui").json()
    assert out == {"program": "demo", "files": FILES, "release": {"digest": client.app.state.hive.programs.programs["demo"]["digest"]}}  # same files/scripts contract, plus host-only P8 release


def test_no_scripts_list_keeps_the_old_answer_for_an_extra_pinned_file(client, tmp_path):
    # Measured at 6614939 (and a17bdda, whose ui_bundle/verify_bundle are the same): with no scripts list, an extra
    # pinned file that is also on disk passes verify_bundle and is simply not served (200). Kept, not changed (r17
    # ruling 3: keep what the old code did). This test passes unmodified against 6614939's programs.py.
    install(client, tmp_path, dict(FILES, **{"extra.js": "x"}), scripts=None)
    out = client.get("/api/programs/demo/ui").json()
    assert out == {"program": "demo", "files": FILES, "release": {"digest": client.app.state.hive.programs.programs["demo"]["digest"]}}


@pytest.mark.parametrize("scripts, needle", [
    ([], "1 to 3"),
    (["a.js", "b.js", "c.js", "app.js"], "1 to 3"),
    ("app.js", "1 to 3"),
    (None, "1 to 3"),                                  # "scripts": null is not "no list"
    (["../x.js", "app.js"], "1 to 3"),
    (["sub/x.js", "app.js"], "1 to 3"),
    (["x.mjs", "app.js"], "1 to 3"),
    (["style.css", "app.js"], "1 to 3"),
    ([1, "app.js"], "1 to 3"),
])
def test_bad_lists_are_refused(client, tmp_path, scripts, needle):
    install(client, tmp_path, bundle(["app.js"]), scripts=None, extra_lock={"scripts": scripts})
    refused(client, needle)


def test_duplicate_part_is_refused(client, tmp_path):
    install(client, tmp_path, bundle(["app.js"]), scripts=["app.js", "app.js"])
    refused(client, "twice")


def test_app_js_must_be_last(client, tmp_path):
    install(client, tmp_path, bundle(["app.js", "native-three.js"]), scripts=["app.js", "native-three.js"])
    refused(client, "app.js is the last")


def test_unpinned_part_is_refused(client, tmp_path):
    files = bundle()
    install(client, tmp_path, {k: v for k, v in files.items() if k != "native-three.js"})   # listed, not on disk, not pinned
    refused(client, "native-three.js is not pinned")


def test_listed_part_on_disk_but_unpinned_is_422(client, tmp_path):
    files = bundle()
    install(client, tmp_path, files, pin=[n for n in files if n != "native-three.js"])
    refused(client, "native-three.js is not pinned")                   # was 404 no_app_ui in 82bdc26 (stand-in 2)


def test_unlisted_unpinned_file_on_disk_is_422(client, tmp_path):
    files = dict(bundle(), **{"other.js": "x"})
    install(client, tmp_path, files, pin=[n for n in files if n != "other.js"])
    refused(client, "file other.js is not pinned")


def test_pinned_file_missing_from_disk_is_422(client, tmp_path):
    app = install(client, tmp_path, bundle())
    (app / "ui" / "native-three-addons.js").unlink()
    client.app.state.hive.programs.programs["demo"]["digest"] = client.app.state.hive.programs.source_digest(app)
    refused(client, "pinned file native-three-addons.js is missing")


def test_lock_must_pin_index_and_style(client, tmp_path):
    # Kimi 2: the pinned set EQUALS {index.html, style.css, *scripts}; pins for the parts alone are not enough
    files = bundle()
    install(client, tmp_path, files, pin=[n for n in files if n != "index.html"])
    refused(client, "index.html is not pinned")
    install(client, tmp_path / "b", files, pin=[n for n in files if n != "style.css"])
    refused(client, "style.css is not pinned")


def test_unlisted_pinned_file_is_refused(client, tmp_path):
    files = dict(bundle(), **{"other.js": "x"})
    install(client, tmp_path, files)
    refused(client, "unlisted file other.js")


def test_unlisted_script_tag_is_refused(client, tmp_path):
    html = page(PARTS).replace("</body>", '<script type="module" src="./other.js"></script></body>')
    install(client, tmp_path, bundle(html=html))
    refused(client, "unlisted")


def test_wrong_order_is_refused(client, tmp_path):
    install(client, tmp_path, bundle(html=page(["native-three-addons.js", "native-three.js", "app.js"])))
    refused(client, "out of their listed order")


def test_missing_tag_is_refused(client, tmp_path):
    install(client, tmp_path, bundle(html=page(["native-three.js", "app.js"])))
    refused(client, "exactly one")


def test_duplicate_tag_is_refused(client, tmp_path):
    install(client, tmp_path, bundle(html=page(["native-three.js", "native-three.js", "native-three-addons.js", "app.js"])))
    refused(client, "exactly one")


def test_missing_style_is_refused(client, tmp_path):
    files = bundle()
    del files["style.css"]
    install(client, tmp_path, files)
    refused(client, "style.css is not pinned")


def test_oversize_part_is_refused(client, tmp_path):
    files = bundle()
    files["native-three.js"] = "x" * 600_001
    install(client, tmp_path, files)
    refused(client, "native-three.js is over 600000 bytes")


def test_part_at_the_limit_is_served(client, tmp_path):
    files = bundle()
    files["native-three.js"] = "x" * 600_000
    install(client, tmp_path, files)
    assert client.get("/api/programs/demo/ui").status_code == 200


def test_size_counts_bytes_not_characters(client, tmp_path):
    files = bundle()
    files["native-three.js"] = "é" * 300_001         # 600,002 UTF-8 bytes
    install(client, tmp_path, files)
    refused(client, "over 600000 bytes")


def test_whole_ui_limit(client, tmp_path):
    files = bundle()
    files["native-three.js"] = "x" * 600_000
    files["native-three-addons.js"] = "x" * 600_000
    files["app.js"] = "x" * 599_000
    files["style.css"] = "x" * 1_000                     # total: 1,800,000 + index.html > limit
    install(client, tmp_path, files)
    refused(client, "over 1800000 bytes in all")


def test_whole_ui_at_the_limit_is_served(client, tmp_path):
    files = bundle()
    html_len = len(files["index.html"].encode())
    files["native-three.js"] = "x" * 600_000
    files["native-three-addons.js"] = "x" * 600_000
    files["app.js"] = "x" * (600_000 - html_len - len(files["style.css"]))
    install(client, tmp_path, files)
    assert client.get("/api/programs/demo/ui").status_code == 200


def test_changed_part_is_refused(client, tmp_path):
    app = install(client, tmp_path, bundle())
    (app / "ui" / "native-three.js").write_text("fetch('https://evil')")
    assert client.get("/api/programs/demo/ui").status_code in (403, 404)


CASES = json.loads((pathlib.Path(__file__).parent / "fixtures" / "ui_parts_cases.json").read_text())


@pytest.mark.parametrize("name, ok", sorted(CASES["names"].items()))
def test_part_names_shared_with_the_client(name, ok):
    """Kimi 1: no dots in the stem, anchored (no trailing newline). The client checks the same table."""
    assert bool(ui_parts.PART_NAME.fullmatch(name)) is ok
    assert (ui_parts.lock_reason({"scripts": [name, "app.js"] if name != "app.js" else ["app.js"],
                                  "files": {"index.html": "", "style.css": "", name: "", "app.js": ""}}) is None) is ok


@pytest.mark.parametrize("name", ["a.b.js", "app.min.js", "app.js\n"])
def test_dotted_or_newline_names_are_422(client, tmp_path, name):
    install(client, tmp_path, bundle(["app.js"]), scripts=[name, "app.js"])
    refused(client, "no dots before .js")


@pytest.mark.parametrize("case", CASES["html"], ids=[c["name"] for c in CASES["html"]])
def test_index_html_cases_shared_with_the_client(case):
    """Stand-in 3: tags that would be inert (comment, attribute value, raw text, template, foreign content) refuse.
    The client checks the same table, and a real browser runs every accepted case (appFrame.browser.test.ts)."""
    assert ui_parts.html_reason(case["html"], case["scripts"]) == case["reason"]


def test_tags_inside_a_comment_are_422(client, tmp_path):
    html = page(PARTS).replace("<body>", "<body><!--").replace("</body>", "--></body>")
    install(client, tmp_path, bundle(html=html))
    refused(client, "ends with the part tags")
    html = page(PARTS).replace("<body>", "<body><!-- x -->")
    install(client, tmp_path / "b", bundle(html=html))
    refused(client, "comment before the part tags")


def test_tags_inside_an_attribute_value_are_422(client, tmp_path):
    install(client, tmp_path, bundle(html=page(PARTS).replace("<body>", '<body><div title="')))
    refused(client, "unclosed <div> tag")


def test_comment_opener_inside_a_part_is_422(client, tmp_path):
    files = bundle()
    files["native-three.js"] = 'const s = "<!--<script>"'
    install(client, tmp_path, files)
    refused(client, "native-three.js contains <!--")



def test_declared_assets_are_served_beside_the_frame_files(client, tmp_path):
    """Opt-in "assets" (a Create app's icon.svg): pinned, served for appDocument to inline. Without the key, the old
    answer stands (test_no_scripts_list_keeps_the_old_answer_for_an_extra_pinned_file)."""
    icon = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    install(client, tmp_path, dict(FILES, **{"icon.svg": icon, "moon.svg": icon}), scripts=None,
            extra_lock={"assets": ["icon.svg", "moon.svg"]})
    out = client.get("/api/programs/demo/ui").json()
    assert out["files"] == dict(FILES, **{"icon.svg": icon, "moon.svg": icon})


@pytest.mark.parametrize("assets, needle", [
    ("icon.svg", "list"),
    (["missing.svg"], "not a pinned asset"),
    (["../icon.svg"], "not a pinned asset"),
    (["app.js"], "not a pinned asset"),
    (["bundle.lock.json"], "not a pinned asset"),
    (["icon.svg", "icon.svg"], "distinct"),
])
def test_bad_asset_lists_are_refused(client, tmp_path, assets, needle):
    install(client, tmp_path, dict(FILES, **{"icon.svg": "<svg/>"}), scripts=None, extra_lock={"assets": assets})
    refused(client, needle)


def test_an_asset_must_be_pinned(client, tmp_path):
    install(client, tmp_path, dict(FILES, **{"icon.svg": "<svg/>"}), scripts=None, pin=set(FILES),
            extra_lock={"assets": ["icon.svg"]})
    r = client.get("/api/programs/demo/ui")
    assert r.status_code in (404, 422), r.text                  # verify_bundle refuses the unpinned file first
