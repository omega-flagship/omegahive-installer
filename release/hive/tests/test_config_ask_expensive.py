"""Purpose: verify the Ask's "this one looks expensive" numbers are the hive's settings and never the code's (Kabir's
rule: defaults come from the environment or config). Each HIVE_ASK_EXPENSIVE_* key and HIVE_ASK_GO_AHEAD_SECONDS is read
per key from the environment, else the deployment's file (HIVE_CONFIG_FILE), else the tree's defaults (hive/config.json);
one in no layer, or malformed in the layer that has it, refuses load_settings naming the key and the layer.

No network and no hive: load_settings on a temp data folder.
"""
import json

import pytest

from hive.core import ask as ask_module
from hive.core import conductor as cmod
from hive.core import config as config_module
from hive.core.config import ASK_EXPENSIVE_KEYS, CONFIG_FILE, AskExpensive, SettingsRefused, load_settings

KEYS = list(ASK_EXPENSIVE_KEYS)


@pytest.fixture()
def env(monkeypatch, tmp_path):
    """A clean environment for the five keys and a temp data folder; returns a writer for a config file of one's own."""
    monkeypatch.setenv("HIVE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("HIVE_CONFIG_FILE", raising=False)
    for key in KEYS:
        monkeypatch.delenv(key, raising=False)

    def config_file(values):
        path = tmp_path / "config.json"
        path.write_text(json.dumps(values) if not isinstance(values, str) else values)
        monkeypatch.setenv("HIVE_CONFIG_FILE", str(path))
        return path
    return config_file


@pytest.fixture()
def tree(monkeypatch, tmp_path):
    """Swaps the tree's defaults file (hive/config.json) for a temp one; returns a writer for it."""
    def defaults(values):
        path = tmp_path / "tree-config.json"
        if values is not None:
            path.write_text(json.dumps(values))
        monkeypatch.setattr(config_module, "CONFIG_FILE", path)
        return path
    return defaults


def refusal(match):
    return pytest.raises(SettingsRefused, match=match)


def test_the_tree_config_file_carries_every_key_and_loads(env):
    shipped = json.loads(CONFIG_FILE.read_text())
    assert set(KEYS) <= set(shipped)
    assert load_settings().ask_expensive == AskExpensive(10, 1.0, 20, 5, 300)


def test_the_environment_wins_over_the_config_file(env, monkeypatch):
    monkeypatch.setenv("HIVE_ASK_EXPENSIVE_TIMES", "3")
    monkeypatch.setenv("HIVE_ASK_GO_AHEAD_SECONDS", "45.5")
    e = load_settings().ask_expensive
    assert (e.times, e.wait_seconds) == (3.0, 45.5) and (e.over_usd, e.medians, e.fewest) == (1.0, 20, 5)


def test_the_deployment_file_sets_one_key_and_the_rest_come_from_the_defaults(env):
    env({"HIVE_ASK_EXPENSIVE_OVER_USD": 2.5})
    assert load_settings().ask_expensive == AskExpensive(10, 2.5, 20, 5, 300)


def test_the_environment_wins_over_the_deployment_file(env, monkeypatch):
    env({"HIVE_ASK_EXPENSIVE_OVER_USD": 2.5})
    monkeypatch.setenv("HIVE_ASK_EXPENSIVE_OVER_USD", "0.75")
    assert load_settings().ask_expensive.over_usd == 0.75


@pytest.mark.parametrize("layer", ["deployment", "defaults"])
def test_a_malformed_value_is_refused_naming_the_layer_it_came_from(env, tree, layer):
    if layer == "deployment":
        path = env({"HIVE_ASK_EXPENSIVE_MEDIANS": "lots"})
    else:
        path = tree({k: 5 for k in KEYS} | {"HIVE_ASK_EXPENSIVE_MEDIANS": "lots"})
    with refusal(f"HIVE_ASK_EXPENSIVE_MEDIANS='lots' in {path} is not"):
        load_settings()


def test_a_malformed_deployment_value_is_not_rescued_by_the_defaults(env):
    path = env({"HIVE_ASK_EXPENSIVE_TIMES": None})
    with refusal(f"HIVE_ASK_EXPENSIVE_TIMES='None' in {path} is not"):
        load_settings()


def test_a_deployment_file_that_is_not_there_refuses(env, monkeypatch, tmp_path):
    absent = tmp_path / "absent.json"
    monkeypatch.setenv("HIVE_CONFIG_FILE", str(absent))
    with refusal(f"HIVE_CONFIG_FILE='{absent}': no such file"):
        load_settings()


def test_a_key_in_no_layer_refuses_the_start_naming_it_and_every_layer(env, tree):
    deployment = env({"HIVE_ASK_EXPENSIVE_TIMES": 1})
    defaults = tree({k: 1 for k in KEYS if k != "HIVE_ASK_EXPENSIVE_OVER_USD"})
    with refusal(f"HIVE_ASK_EXPENSIVE_OVER_USD is set in none of: the environment, {deployment}, {defaults}"):
        load_settings()


def test_every_missing_key_is_named_at_once(env, tree):
    env({})
    tree({})
    with pytest.raises(SettingsRefused) as exc:
        load_settings()
    assert all(k in str(exc.value) for k in KEYS)


def test_no_config_file_at_all_needs_every_key_from_the_environment(env, tree, monkeypatch):
    tree(None)   # the tree's file absent, no HIVE_CONFIG_FILE
    with refusal("HIVE_ASK_EXPENSIVE_TIMES is set in none of"):
        load_settings()
    for key, value in json.loads(CONFIG_FILE.read_text()).items():   # every other key of config.KEYS from the shipped file
        monkeypatch.setenv(key, str(value))
    for key, value in zip(KEYS, ["2", "0.5", "4", "2", "60"]):
        monkeypatch.setenv(key, value)
    assert load_settings().ask_expensive == AskExpensive(2.0, 0.5, 4, 2, 60.0)


@pytest.mark.parametrize("key,raw", [
    ("HIVE_ASK_EXPENSIVE_TIMES", "ten"), ("HIVE_ASK_EXPENSIVE_TIMES", "0"), ("HIVE_ASK_EXPENSIVE_TIMES", "nan"),
    ("HIVE_ASK_EXPENSIVE_OVER_USD", "-1"), ("HIVE_ASK_EXPENSIVE_OVER_USD", "inf"),
    ("HIVE_ASK_EXPENSIVE_MEDIANS", "2.5"), ("HIVE_ASK_EXPENSIVE_MEDIANS", "0"), ("HIVE_ASK_EXPENSIVE_FEWEST", "-3"),
    ("HIVE_ASK_GO_AHEAD_SECONDS", "0"), ("HIVE_ASK_GO_AHEAD_SECONDS", "100000"),
])
def test_a_malformed_environment_value_refuses_naming_the_key_and_its_source(env, monkeypatch, key, raw):
    monkeypatch.setenv(key, raw)
    with refusal(f"{key}={raw!r} in the environment is not"):
        load_settings()


@pytest.mark.parametrize("value", [True, "10", [10], None, "", 1.5])
def test_a_malformed_config_file_value_refuses(env, value):
    values = {k: 5 for k in KEYS}
    values["HIVE_ASK_EXPENSIVE_MEDIANS"] = value   # "10" as a string is a number of the environment's kind: allowed
    path = env(values)
    if value == "10":
        assert load_settings().ask_expensive.medians == 10
        return
    with refusal(f"HIVE_ASK_EXPENSIVE_MEDIANS=.* in {path} is not"):   # present as null or "" is set, and malformed
        load_settings()


def test_a_config_file_that_is_not_a_json_object_refuses(env):
    path = env("not json")
    with refusal(f"{path} is not readable JSON"):
        load_settings()
    env("[1, 2]")
    with refusal("is not a JSON object"):
        load_settings()


def test_fewest_above_medians_refuses(env, monkeypatch):
    monkeypatch.setenv("HIVE_ASK_EXPENSIVE_FEWEST", "21")
    with refusal(r"HIVE_ASK_EXPENSIVE_FEWEST \(21, in the environment\) is more than "
                 r"HIVE_ASK_EXPENSIVE_MEDIANS \(20, in .*hive/config.json\)"):
        load_settings()


def test_an_override_needs_no_key(env):
    env({})
    mine = AskExpensive(1.5, 0.25, 3, 1, 9.0)
    assert load_settings(ask_expensive=mine).ask_expensive is mine


def test_the_code_holds_none_of_the_numbers():
    for name in ("EXPENSIVE_TIMES", "EXPENSIVE_OVER_USD", "EXPENSIVE_MEDIANS", "EXPENSIVE_FEWEST"):
        assert not hasattr(ask_module, name)
    assert not hasattr(cmod, "GO_AHEAD_SECONDS")
