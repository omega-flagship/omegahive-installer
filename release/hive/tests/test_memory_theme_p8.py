"""P8 scalar theme schema and host contrast contract; no inference or memory content."""
import math

import pytest

from hive.core.memory_theme import memory_color_contrast, memory_palette, parse_memory_themes


def test_optional_default_dark_and_named_theme_contract():
    manifest = {"name": "Example", "memory_theme": {
        "surface": "#FEFDFC", "accent": "#123456", "font": "humanist", "radius": 0.5, "motion": "none",
        "calm": {"accent": "#234567", "dark": {"surface": "#101010", "text": "#fefefe"}},
        "bright-2": {"font": "mono"},
    }, "memory_theme_dark": {"surface": "#101010", "text": "#ffffff"}}
    result = parse_memory_themes(manifest)
    assert set(result) == {"memory_theme", "memory_theme_dark"}
    assert result["memory_theme"]["surface"] == "#fefdfc"
    assert result["memory_theme"]["calm"]["dark"]["surface"] == "#101010"
    assert result["memory_theme"]["radius"] == 0.5
    assert manifest["memory_theme"]["surface"] == "#FEFDFC"  # validation does not alter the source manifest
    assert parse_memory_themes({}) == {}


@pytest.mark.parametrize("theme", [
    {"surface": "url(https://example.invalid/font)"},
    {"accent": "#fff"},
    {"text": "<style>body{}</style>"},
    {"font": "https://example.invalid/font.woff"},
    {"font": "withdrawn-font"},
    {"motion": "@import 'https://example.invalid/x.css'"},
    {"radius": True},
    {"radius": -1},
    {"radius": 33},
    {"radius": math.inf},
    {"radius": math.nan},
    {"radius": 10 ** 1000},
    {"padding": 8},
    {"accent_text": "#ffffff"},
    {"constructor": {}},
    {"x" * 25: {}},
    {"Upper": {}},
    {"dark": {"surface": "#000000"}},
    {"calm": {"dark": {"font": "remote-font"}}},
    {"calm": {"nested": {"surface": "#000000"}}},
])
def test_unsafe_unknown_or_nonfinite_values_refuse_loading(theme):
    with pytest.raises(ValueError):
        parse_memory_themes({"memory_theme": theme})


def test_all_named_and_dark_branches_receive_strict_validation():
    four = {"one": {}, "two": {}, "three": {}, "four": {"dark": {"font": "serif"}}}
    assert len(parse_memory_themes({"memory_theme": four})["memory_theme"]) == 4
    with pytest.raises(ValueError):
        parse_memory_themes({"memory_theme": dict(four, fifth={})})
    with pytest.raises(ValueError):
        parse_memory_themes({"memory_theme_dark": {"calm": {}}})
    with pytest.raises(ValueError):
        parse_memory_themes({"memory_theme_dark": None})
    with pytest.raises(ValueError):
        parse_memory_themes({"memory_theme": {"calm": {"dark": {"accent": "expression(1)"}}}})


@pytest.mark.parametrize("tokens", [
    {"surface": "#ffffff", "panel": "#000000", "text": "#777777", "muted": "#777777"},
    {"surface": "#777777", "panel": "#777777", "text": "#777777", "accent": "#777777"},
    {"surface": "#010101", "panel": "#202020", "text": "#020202", "accent": "#ffffff"},
    {"surface": "#fefefe", "panel": "#eeeeee", "text": "#ffffff", "accent": "#000000"},
])
def test_host_substitution_keeps_all_display_text_and_accent_at_aa(tokens):
    theme = memory_palette(tokens)
    for foreground in ("text", "muted", "positive", "danger"):
        for background in ("surface", "panel"):
            assert memory_color_contrast(theme[foreground], theme[background]) >= 4.5
    assert theme["accent_text"] in ("#ffffff", "#0b0820")
    assert memory_color_contrast(theme["accent_text"], theme["accent"]) >= 4.5


def test_middle_accent_cannot_rely_on_foreground_choice_alone():
    assert max(memory_color_contrast("#777777", ink) for ink in ("#ffffff", "#0b0820")) < 4.5
    theme = memory_palette({"accent": "#777777"})
    assert theme["accent"] != "#777777"
    assert memory_color_contrast(theme["accent_text"], theme["accent"]) >= 4.5
