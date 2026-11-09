# Compatibility facade for OmegaClaw Python helper functions.
#
# The implementation is split into smaller membranes so core syntax, MeTTa
# atom construction, history lookup, promotion storage, and reboot control can
# be reviewed independently. Existing MeTTa calls keep using helper.* names.

from datetime import datetime
import pathlib
import sys

try:
    from .python_runtime import configure_embedded_python_runtime
except Exception:  # pragma: no cover - direct script import fallback
    from python_runtime import configure_embedded_python_runtime

configure_embedded_python_runtime()

try:
    from .helper_history import (
        extract_timestamp,
        coerce_recall_lines,
        around_time,
        normalize_episode_time,
        episodes_at,
    )
    from .helper_metta import (
        CORE_ROOT,
        OMEGACLAW_ROOT,
        context_prompt,
        context_history_tail,
        context_recent_history_entries,
        context_last_results,
        context_current_frame,
        ensure_runtime_memory_files,
        memory_file,
        protected_atom,
        evict_receipt,
        save_begin,
        save_commit,
        _escape_metta_string,
        _metta_string,
        _has_unescaped_quote,
        _metta_expr_syntax_error,
        _take_balanced_metta_expr,
        _split_collapsed_space_transform_args,
        _split_with_confidence,
        _pipe_parts,
        _source_trace,
        _numeric_text,
        config_assignment_atom,
        persistent_fact_atom,
        persistent_note_atom,
        persistent_rule_atom,
        world_fact_atom,
        belief_claim_atom,
        agenda_goal_atom,
        agenda_goal_name,
        agenda_goal_name_atom,
        event_note_atom,
        cleanup_candidate_id,
        cleanup_proposal_id,
        cleanup_preview,
        assimilation_event_atom,
        assimilation_world_atom,
        assimilation_belief_atom,
        assimilation_persistent_atom,
        space_transform_spec_atom,
        test_metta_expression,
        persistent_expression_atom,
        run_metta_file,
        _safe_writable_path,
        write_file_base64,
        append_file_base64,
        normalize_string,
    )
    from .helper_command_parser import (
        SignatureParseError,
        SIGNATURE_KNOWN_SPACES,
        SIGNATURE_MULTILINE_LOWERING,
        SIGNATURE_COMMANDS,
        SIGNATURE_DECLARATIONS_PATH,
        _strip_signature_comment,
        _load_signature_commands,
        signature_commands_from,
        signature_spaces_from,
        signature_lowerings_from,
        signature_declaration_paths,
        skill_catalog_declaration_paths,
        skill_catalog,
        skill_help,
        reload_signature_commands,
        _signature_quote,
        _signature_one_line,
        _signature_consume_token,
        _signature_validated_metta,
        _signature_consume_metta,
        _signature_split_commands,
        _signature_split_top_level_forms,
        _signature_explicit_command_head,
        _signature_accepts_unquoted_continuation,
        _signature_merge_continuations,
        _signature_extract_block,
        _signature_syntax_error,
        _signature_parse_one,
        _signature_source_text,
        signature_raw_batch_complete,
        signature_balance_parentheses,
        balance_parentheses,
    )
    from .helper_recall import (
        context_input_recall,
        context_input_recall_text,
        dialogue_frame,
        dialogue_recall_basis_text,
    )
    from .helper_skill_recall import (
        input_skill_signals,
        input_skill_signals_expr,
    )
    from .helper_promotion import (
        promotion_open_map,
        promotion_key,
        promotion_set_value,
        promotion_get_value,
        promotion_get_all_keys,
        promotion_set_lasttime,
        promotion_get_lasttime,
        promotion_has_key,
        promotion_delete_key,
        promotion_commit,
        promotion_close_map,
    )
    from .helper_reboot import (
        current_swipl_pid,
        _reboot_note_path,
        _latest_reboot_line,
        prepare_reboot,
        complete_reboot_check,
        restart_omega,
        restart_self,
        reboot_self,
    )
except Exception:
    from helper_history import (
        extract_timestamp, coerce_recall_lines, around_time, normalize_episode_time, episodes_at,
    )
    from helper_metta import (
        CORE_ROOT,
        OMEGACLAW_ROOT,
        context_prompt,
        context_history_tail,
        context_recent_history_entries,
        context_last_results,
        context_current_frame,
        ensure_runtime_memory_files,
        memory_file,
        protected_atom,
        evict_receipt,
        save_begin,
        save_commit,
        _escape_metta_string,
        _metta_string,
        _has_unescaped_quote,
        _metta_expr_syntax_error,
        _take_balanced_metta_expr,
        _split_collapsed_space_transform_args,
        _split_with_confidence,
        _pipe_parts,
        _source_trace,
        _numeric_text,
        config_assignment_atom,
        persistent_fact_atom,
        persistent_note_atom,
        persistent_rule_atom,
        world_fact_atom,
        belief_claim_atom,
        agenda_goal_atom,
        agenda_goal_name,
        agenda_goal_name_atom,
        event_note_atom,
        cleanup_candidate_id,
        cleanup_proposal_id,
        cleanup_preview,
        assimilation_event_atom,
        assimilation_world_atom,
        assimilation_belief_atom,
        assimilation_persistent_atom,
        space_transform_spec_atom,
        test_metta_expression,
        persistent_expression_atom,
        run_metta_file,
        _safe_writable_path,
        write_file_base64,
        append_file_base64,
        normalize_string,
    )
    from helper_command_parser import (
        SignatureParseError,
        SIGNATURE_KNOWN_SPACES,
        SIGNATURE_MULTILINE_LOWERING,
        SIGNATURE_COMMANDS,
        SIGNATURE_DECLARATIONS_PATH,
        _strip_signature_comment,
        _load_signature_commands,
        signature_commands_from,
        signature_spaces_from,
        signature_lowerings_from,
        signature_declaration_paths,
        skill_catalog_declaration_paths,
        skill_catalog,
        skill_help,
        reload_signature_commands,
        _signature_quote,
        _signature_one_line,
        _signature_consume_token,
        _signature_validated_metta,
        _signature_consume_metta,
        _signature_split_commands,
        _signature_split_top_level_forms,
        _signature_explicit_command_head,
        _signature_accepts_unquoted_continuation,
        _signature_merge_continuations,
        _signature_extract_block,
        _signature_syntax_error,
        _signature_parse_one,
        _signature_source_text,
        signature_raw_batch_complete,
        signature_balance_parentheses,
        balance_parentheses,
    )
    from helper_recall import (
        context_input_recall,
        context_input_recall_text,
        dialogue_frame,
        dialogue_recall_basis_text,
    )
    from helper_skill_recall import (
        input_skill_signals,
        input_skill_signals_expr,
    )
    from helper_promotion import (
        promotion_open_map,
        promotion_key,
        promotion_set_value,
        promotion_get_value,
        promotion_get_all_keys,
        promotion_set_lasttime,
        promotion_get_lasttime,
        promotion_has_key,
        promotion_delete_key,
        promotion_commit,
        promotion_close_map,
    )
    from helper_reboot import (
        current_swipl_pid,
        _reboot_note_path,
        _latest_reboot_line,
        prepare_reboot,
        complete_reboot_check,
        restart_omega,
        restart_self,
        reboot_self,
    )


_WAIT_ITEM = r'\(\s*wait(?:\s+(?:"(?:[^"\\]|\\.)*"|[^\s()"]+))*\s*\)'
_WAIT_ONLY = None
_WAIT_SECONDS = None
_WAIT_PROVIDER = None
MAX_FORMAT_RETRIES = 3
FORMAT_RETRY_SECONDS = 2
PROVIDER_RETRY_SECONDS = 60   # a provider-error wait (lib_llm_ext: wait "LLM-PROVIDER-...") retries after this long


def chosen_wait_seconds(sexpr_repr, retry_kind="normal", format_attempts=0):
    """How a response that is nothing but `wait` sets the mind's next wake, read from the parsed commands' repr.

    -1: the response is not a pure wait (the mind acted, or wrote nothing), so its turns go on as before.
     0: the mind chose to wait with no length; it wakes on new input or at its own wake interval.
     n: the first wait's reason starts with a length ("wait 900", "wait 600 nothing owed", "wait 10 minutes",
        "wait 2h"; seconds unless it says minutes or hours), clamped to 30..86400 like sleep-for; it wakes on new
        input or after n seconds.
     2: only a trusted runtime format failure, for its first three attempts across wakes.
        Model-authored marker text is an ordinary wait; exhausted retries use the normal wake interval.
    60: the wait is the runtime's own provider error (lib_llm_ext.callProvider answers wait "LLM-PROVIDER-..." when
        the provider is unknown or unavailable): not the mind's choice, so a short fixed back-off, never the full wake
        interval (Kimi r1 K8), and a recovering provider is tried again within a minute.
    """
    import re
    global _WAIT_ONLY, _WAIT_SECONDS, _WAIT_PROVIDER
    if _WAIT_ONLY is None:
        _WAIT_PROVIDER = re.compile(r'^\(\s*\(\s*wait\s+"?\s*LLM-PROVIDER-')
        _WAIT_ONLY = re.compile(r'^\(\s*(?:' + _WAIT_ITEM + r'\s*)+\)$')
        _WAIT_SECONDS = re.compile(r'^\(\s*\(\s*wait\s+"?\s*(\d+(?:\.\d+)?)\s*'
                                   r'(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?(?:[\s,.;:")]|$)')
    text = str(sexpr_repr or "").strip()
    if not _WAIT_ONLY.match(text):
        return -1
    if retry_kind == "format":
        return FORMAT_RETRY_SECONDS if 1 <= int(format_attempts) <= MAX_FORMAT_RETRIES else 0
    if retry_kind == "provider":
        return PROVIDER_RETRY_SECONDS
    if _WAIT_PROVIDER.match(text):
        return PROVIDER_RETRY_SECONDS
    found = _WAIT_SECONDS.match(text)
    if not found:
        return 0
    unit = (found.group(2) or "s")[0]
    seconds = float(found.group(1)) * {"s": 1, "m": 60, "h": 3600}[unit]
    return int(min(86400, max(30, seconds)))


def next_format_retry_count(kind, previous):
    """The existing loop keeps this bounded count across wakes; a well-formed response starts a new stretch."""
    return min(MAX_FORMAT_RETRIES + 1, max(0, int(previous)) + 1) if kind == "format" else 0


def _model_response(response, provider_failure="normal"):
    import re
    # The host has already classified its own unavailable/exception result. Never reclassify an outage as malformed
    # model output, including when a later syntax guard is tightened. Model text cannot supply this argument.
    if provider_failure == "provider":
        return signature_balance_parentheses(response), "provider"
    failed = (provider_failure == "format" or not signature_raw_batch_complete(response)
              or not signature_raw_batch_complete(_signature_source_text(response)))
    parsed = "" if failed else signature_balance_parentheses(response)
    commands = _signature_split_top_level_forms(parsed[1:-1]) if parsed else []
    bad = [command for command in commands if re.match(r"^\(\s*syntax-error(?:\s|\))", command)]
    if failed or not parsed[1:-1].strip() or bad:
        # Keep the parser's own recovery text for the first malformed command (e.g. "missing team"), so the next turn
        # can correct it; quotes, backslashes and parentheses are dropped so the wait stays one plain string.
        hint = ""
        if bad and not failed:
            found = re.findall(r'"((?:[^"\\]|\\.)*)"', bad[0])[:2]
            hint = re.sub(r'[\\"()]', "", " ".join(found)).strip()[:300]
        reason = "LLM-FORMAT-ERROR retry with complete skill commands" + (f"; {hint}" if hint else "")
        return f'((wait "{reason}"))', "format"
    return parsed, "provider" if provider_failure == "provider" else "normal"


def model_response_commands(response):
    """Standalone command view. Provenance is carried separately by prepare_model_response in the actual loop."""
    return _model_response(response)[0]


def prepare_model_response(response, provider_failure="normal"):
    """Trusted runtime envelope. The loop extracts string fields without evaluating envelope data as MeTTa.

    provider_failure comes only from a runtime exception/incomplete-result object in callProviderCommands. The raw
    batch check runs before the canonical parser's repair/prose path. No malformed prefix or suffix is executed.
    """
    import json
    commands, kind = _model_response(response, provider_failure)
    return json.dumps({"commands": commands, "retry_kind": kind}, separators=(",", ":"))


def prepared_response_commands(envelope):
    import json
    value = json.loads(envelope)["commands"]
    if not isinstance(value, str):
        raise ValueError("prepared commands must be text")
    return value


def prepared_response_kind(envelope):
    import json
    kind = json.loads(envelope)["retry_kind"]
    if kind not in ("normal", "format", "provider"):
        raise ValueError("invalid runtime retry kind")
    return kind


def add_python_path(path):
    """Add a repo-relative or absolute Python import path for an enabled module."""
    candidate = pathlib.Path(str(path))
    if not candidate.is_absolute():
        candidate = CORE_ROOT / candidate
    value = str(candidate.resolve())
    if value not in sys.path:
        sys.path.insert(0, value)
    return f"PythonPathAdded {value}"


def test_balance_parenthesis():
	assert balance_parentheses('write-file test.txt hello world') == '((write-file-base64 "test.txt" "aGVsbG8gd29ybGQ="))'
	assert balance_parentheses('send test.xt hello world') == '((send "test.xt hello world"))'
	assert balance_parentheses('turn-off Living') == '((wait "ignored unknown command head turn-off; use only commands listed in SKILLS"))'
	assert balance_parentheses('episodes-at 2026-05-17 21:00') == '((episodes-at "2026-05-17 21:00"))'
	assert balance_parentheses('belief-revision-candidate TestPerson lunch-preference example-preference 0.7 0.6') == '((belief-revision-candidate "TestPerson" "lunch-preference" "example-preference" 0.7 0.6))'
	assert normalize_episode_time('2026-05-17 21:00', datetime(2026, 5, 17, 21, 42, 30)) == '2026-05-17 21:00:00'
	assert normalize_episode_time('21:00', datetime(2026, 5, 17, 21, 42, 30)) == '2026-05-17 21:00:00'
	assert coerce_recall_lines(['maxEpisodeRecallLines']) == 20
	assert coerce_recall_lines('3.0') == 3
	assert coerce_recall_lines(999) == 200
	assert persistent_fact_atom('the agent learned wait-skill 0.8') == '(PersistentFact "the agent" "learned" "wait-skill" "0.8")'
	assert persistent_fact_atom('the agent learned wait-skill high') == '(PersistentFactError "expected: subject relation object confidence; confidence must be numeric")'
	assert persistent_note_atom('syntax use episodes-at instead of episodes 0.8') == '(PersistentNote "syntax" "use episodes-at instead of episodes" "0.8")'
	assert persistent_note_atom('syntax use episodes-at instead of episodes high') == '(PersistentNoteError "expected: topic note confidence; confidence must be numeric")'
	assert persistent_rule_atom('no input | implies | use wait not prose | 0.8') == '(PersistentRule "no input" "implies" "use wait not prose" "0.8")'
	assert persistent_rule_atom('no input | implies | use wait not prose | high') == '(PersistentRuleError "expected: premise | relation | conclusion | confidence; confidence must be numeric")'
	assert space_transform_spec_atom('persistent | (A "x") | events | (B "y") | merge duplicate') == '(SpaceTransformSpec "persistent" "(A \\"x\\")" "events" "(B \\"y\\")" "merge duplicate")'
	assert persistent_expression_atom('Implication (Inheritance living-room comfortable) (Inheritance living-room happy) (stv 0.45 0.5)') == '(Implication (Inheritance living-room comfortable) (Inheritance living-room happy) (stv 0.45 0.5))'
	assert test_metta_expression('(match &persistent (Implication $X $Y) (Implication $X $Y))') == 'METTA-SYNTAX-OK'
	assert test_metta_expression('match &persistent (Implication $X $Y)').startswith('METTA-SYNTAX-ERROR')

if __name__ == "__main__":
    test_balance_parenthesis()
