"""How an outside agent joins: the steps the hive gives with each invitation (mcp.py JOIN), its address and code filled in.

Pure: no hive is started. INVENTED address and code only."""
import shlex
import tomllib

from hive.core.mcp import HARNESSES, JOIN, join_steps

URL, CODE = "https://hive.example/omegahive/mcp", "ohv1_INVENTED-code_1"


def test_every_harness_has_steps_with_its_address_and_code_filled_in():
    assert set(JOIN) == set(HARNESSES)
    for harness in HARNESSES:
        text = "\n".join(step["text"] for step in join_steps(harness, URL, CODE))
        assert URL in text and CODE in text and "{url}" not in text and "{code}" not in text, harness


def test_codex_reads_the_code_from_its_config_file_or_for_a_terminal_from_a_shell():
    # an exported variable never reaches the Codex app opened from the Dock; config.toml reaches the app and the CLI, with
    # the key in that file in plain text, which the step says; Codex run only from a terminal can keep it in the shell
    config, terminal, shell, check = join_steps("codex", URL, CODE)
    assert tomllib.loads(config["text"])["mcp_servers"]["omegahive"] == {"url": URL, "http_headers": {"Authorization": f"Bearer {CODE}"}}
    assert "plain text" in config["label"]
    assert tomllib.loads(terminal["text"])["mcp_servers"]["omegahive"] == {"url": URL, "bearer_token_env_var": "OMEGAHIVE_TOKEN"}
    assert "terminal" in terminal["label"] and shell["text"] == f"export OMEGAHIVE_TOKEN={CODE}"
    assert check == {"label": "Then quit Codex and open it again, and type this to check it lists omegahive", "text": "/mcp"}


def test_claude_code_replaces_an_earlier_entry_and_adds_it_for_every_folder():
    # `claude mcp add` refuses a name its scope holds and a local entry shadows a user one: remove both, add at user scope
    install, command, check = join_steps("claude-code", URL, CODE)
    assert install["text"] == "curl -fsSL https://claude.ai/install.sh | bash" and "desktop app does not add it" in install["label"]
    remove_local, remove_user, add = (shlex.split(part) for part in command["text"].split("; "))
    assert remove_local == ["claude", "mcp", "remove", "omegahive", "-s", "local"]
    assert remove_user == ["claude", "mcp", "remove", "omegahive", "-s", "user"]
    assert add == ["claude", "mcp", "add", "--scope", "user", "--transport", "http", "omegahive", URL, "--header", f"Authorization: Bearer {CODE}"]
    assert check == {"label": "Then start a new Claude Code session, and type this to check it lists omegahive", "text": "/mcp"}
