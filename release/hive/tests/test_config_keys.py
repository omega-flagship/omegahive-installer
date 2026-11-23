"""Purpose: verify every number of config.KEYS (T-215 batch 1a) is a hive setting and none is the code's (Kabir's rule:
defaults come from the environment or config). Each key is read per key from the environment, else the deployment's file
(HIVE_CONFIG_FILE), else the tree's defaults (hive/config.json); one in no layer, or malformed where it is set, refuses
load_settings naming the key and the layer, and `python -m hive` exits 78.

No network and no hive: load_settings on a temp data folder, and one subprocess for the exit code.
"""
import json
import os
import pathlib
import re
import subprocess
import sys

import pytest

from hive.core.config import CONFIG_FILE, CORE_ROOT, KEYS, AskLimits, SettingsRefused, load_settings

# The old literals, written from the inventory (T-214), not read from the code: the shipped defaults must equal them.
OLD = {
    "HIVE_ASK_EXPENSIVE_TIMES": 10, "HIVE_ASK_EXPENSIVE_OVER_USD": 1.0, "HIVE_ASK_EXPENSIVE_MEDIANS": 20,
    "HIVE_ASK_EXPENSIVE_FEWEST": 5, "HIVE_ASK_GO_AHEAD_SECONDS": 300,
    "HIVE_ASK_CONDUCTOR_MAX_ACTS": 32, "HIVE_ASK_CONDUCTOR_MAX_MODEL_CALLS": 12, "HIVE_ASK_CONDUCTOR_TURN_SECONDS": 120,
    "HIVE_ASK_CONDUCTOR_RESULT_TIMEOUT_SECONDS": 15, "HIVE_ASK_CONDUCTOR_MAX_TOKENS": 1024,
    "HIVE_ASK_PER_MINUTE": 10, "HIVE_ASK_PER_DAY": 300, "HIVE_ASK_READS_PER_MINUTE": 60, "HIVE_ASK_TIMEOUT_SECONDS": 120,
    "HIVE_MEMBER_MONTHLY_USD": 50, "HIVE_BUDGET_USD": 0, "HIVE_START_LIMIT_MONTH_USD": 50,
}
# one in-bounds value per key, unlike its default
OTHER = {key: (7 if KEYS[key][2] else 7.5) for key in KEYS}
# the team month and the instruction ceiling are retired (config.RETIRED_ENV), so no layer reads them
MONEY = ("HIVE_BUDGET_USD", "HIVE_MEMBER_MONTHLY_USD", "HIVE_START_LIMIT_MONTH_USD")


@pytest.fixture()
def env(monkeypatch, tmp_path):
    """A clean environment for every key and a temp data folder; returns a writer for a deployment file."""
    monkeypatch.setenv("HIVE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("HIVE_CONFIG_FILE", raising=False)
    for key in KEYS:
        monkeypatch.delenv(key, raising=False)

    def deployment(values):
        path = tmp_path / "deployment.json"
        path.write_text(json.dumps(values))
        monkeypatch.setenv("HIVE_CONFIG_FILE", str(path))
        return path
    return deployment


def value(settings, key):
    where, field = KEYS[key][:2]
    return getattr(settings if where == "settings" else getattr(settings, where), field)


def test_the_table_and_the_shipped_file_name_the_same_keys():
    assert set(json.loads(CONFIG_FILE.read_text())) == set(KEYS) == set(OLD)


def test_every_key_is_read_by_code():
    """No dead key: each KEYS field is read outside config.py and the tests, by a file that names the field's group
    (ask_limits, ask_expensive or settings) and reads `.field`; a Settings field may also be read by getattr's
    "field". Generic names (max_tokens, timeout_seconds) appear in unrelated code, hence the group. A key whose
    consumer was dropped, or went back to a module figure, fails here."""
    hive_root = pathlib.Path(__file__).resolve().parents[1]
    sources = [p.read_text(encoding="utf-8") for p in hive_root.rglob("*.py")
               if "tests" not in p.relative_to(hive_root).parts and p != hive_root / "core" / "config.py"]

    def read(where, field, text):
        named = rf"\.{field}\b" + (rf"|getattr\([^)]*[\"']{field}[\"']" if where == "settings" else "")
        return re.search(rf"\b{where}\b", text) and re.search(named, text)
    unread = [key for key, (where, field, *_) in KEYS.items() if not any(read(where, field, t) for t in sources)]
    assert unread == []


def test_the_defaults_are_the_old_literals(env):
    s = load_settings()
    assert {key: value(s, key) for key in KEYS} == OLD
    assert s.ask_limits == AskLimits(32, 12, 120, 15, 1024, 10, 300, 60, 120)
    assert s.budget_env == {}   # every money key from hive/config.json: a default, not set by the operator


@pytest.mark.parametrize("key", list(KEYS))
def test_the_environment_sets_each_key(env, monkeypatch, key):
    monkeypatch.setenv(key, str(OTHER[key]))
    assert value(load_settings(), key) == OTHER[key]


def test_the_deployment_file_sets_one_key_and_the_rest_are_the_defaults(env):
    env({"HIVE_ASK_CONDUCTOR_MAX_ACTS": 64})
    s = load_settings()
    assert s.ask_limits.max_acts == 64 and s.ask_limits.max_model_calls == 12 and s.hive_budget_usd == 0


def test_a_variable_set_but_empty_falls_back_to_the_file(env, monkeypatch):
    env({"HIVE_ASK_PER_DAY": 900})
    monkeypatch.setenv("HIVE_ASK_PER_DAY", "")
    monkeypatch.setenv("HIVE_MEMBER_MONTHLY_USD", "  ")
    s = load_settings()
    assert s.ask_limits.per_day == 900 and s.member_monthly_usd == 50
    assert s.budget_env == {}


@pytest.mark.parametrize("key,raw", [
    ("HIVE_ASK_CONDUCTOR_MAX_ACTS", "0"), ("HIVE_ASK_CONDUCTOR_MAX_ACTS", "1001"), ("HIVE_ASK_CONDUCTOR_MAX_ACTS", "3.5"),
    ("HIVE_ASK_CONDUCTOR_TURN_SECONDS", "0"), ("HIVE_ASK_CONDUCTOR_TURN_SECONDS", "inf"),
    ("HIVE_ASK_PER_DAY", "10000001"), ("HIVE_ASK_TIMEOUT_SECONDS", "two minutes"),
    ("HIVE_BUDGET_USD", "lots"), ("HIVE_BUDGET_USD", "-1"), ("HIVE_MEMBER_MONTHLY_USD", "1000001"),
    ("HIVE_START_LIMIT_MONTH_USD", "nan"), ("HIVE_MEMBER_MONTHLY_USD", "fifty"), ("HIVE_START_LIMIT_MONTH_USD", "abc"),
])
def test_a_malformed_value_refuses_naming_the_key_and_the_environment(env, monkeypatch, key, raw):
    monkeypatch.setenv(key, raw)
    with pytest.raises(SettingsRefused, match=f"{key}={raw!r} in the environment is not"):
        load_settings()


def test_a_malformed_deployment_value_refuses_naming_the_file(env):
    path = env({"HIVE_ASK_READS_PER_MINUTE": "many", "HIVE_BUDGET_USD": None})
    with pytest.raises(SettingsRefused) as exc:
        load_settings()
    assert f"HIVE_ASK_READS_PER_MINUTE='many' in {path} is not" in str(exc.value)
    assert f"HIVE_BUDGET_USD='None' in {path} is not" in str(exc.value)   # both named at once


@pytest.mark.parametrize("key", MONEY)
def test_zero_is_a_money_value(env, monkeypatch, key):
    monkeypatch.setenv(key, "0")
    assert value(load_settings(), key) == 0.0


def test_budget_env_counts_the_environment_and_the_deployment_file_not_the_tree(env, monkeypatch):
    env({"HIVE_MEMBER_MONTHLY_USD": 250, "HIVE_ASK_PER_MINUTE": 3})
    monkeypatch.setenv("HIVE_START_LIMIT_MONTH_USD", " .10 ")
    s = load_settings()
    # the consumers read only which keys are in it; a file's value is its number as text, the environment's as written
    assert s.budget_env == {"HIVE_MEMBER_MONTHLY_USD": "250.0", "HIVE_START_LIMIT_MONTH_USD": ".10"}
    assert (s.member_monthly_usd, s.start_limit_month_usd) == (250.0, 0.1)


def test_a_key_missing_from_every_layer_exits_78_naming_it(tmp_path):
    tree = tmp_path / "tree.json"
    tree.write_text(json.dumps({k: v for k, v in OLD.items() if k != "HIVE_ASK_CONDUCTOR_MAX_TOKENS"}))
    run = (f"import pathlib, runpy; from hive.core import config; config.CONFIG_FILE = pathlib.Path({str(tree)!r}); "
           f"runpy.run_module('hive', run_name='__main__')")
    child_env = {k: v for k, v in os.environ.items() if k not in KEYS and k != "HIVE_CONFIG_FILE"}
    child_env.update(HIVE_DATA_DIR=str(tmp_path / "data"), PYTHONPATH=str(CORE_ROOT))
    done = subprocess.run([sys.executable, "-c", run], cwd=CORE_ROOT, env=child_env, capture_output=True, text=True,
                          timeout=120)
    assert done.returncode == 78, done.stderr[-2000:]
    assert "HIVE_ASK_CONDUCTOR_MAX_TOKENS is set in none of" in done.stderr



def test_settings_without_ask_limits_refuse_at_use_rather_than_guess():
    """Settings built by hand (not by load_settings) carry no ask_limits: the Ask's and the conductor's reads refuse."""
    import types
    from hive.core.ask import ask_limits
    from hive.core.conductor import Conductor
    bare = types.SimpleNamespace(settings=types.SimpleNamespace(ask_limits=None))
    with pytest.raises(RuntimeError, match="ask_limits is unset"):
        ask_limits(bare)
    c = Conductor.__new__(Conductor)
    c.turn_seconds = None
    with pytest.raises(RuntimeError, match="ask_limits is unset"):
        c.deadline()
