# Purpose: the mind runtime's helper functions for MeTTa: core syntax, response parsing and the waits it chooses,
# history lookup, promotion storage and reboot control, behind one facade.
# Compatibility facade for OmegaClaw Python helper functions.
#
# The implementation is split into smaller membranes so core syntax, MeTTa
# atom construction, history lookup, promotion storage, and reboot control can
# be reviewed independently. Existing MeTTa calls keep using helper.* names.

from datetime import datetime
import pathlib
import sys

try:
    from src.python_runtime import configure_embedded_python_runtime
except Exception:  # pragma: no cover - direct script import fallback
    from src.python_runtime import configure_embedded_python_runtime

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
        save_atoms,
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
        save_atoms,
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
PROVIDER_RETRY_SECONDS = 60   # a provider-error wait (hive_services.chat: wait "LLM-PROVIDER-...") retries after this long


def chosen_wait_seconds(sexpr_repr, retry_kind="normal", format_attempts=0, hive_wait=0):
    """How a response that is nothing but `wait` sets the mind's next wake, read from the parsed commands' repr.

    -1: the response is not a pure wait (the mind acted, or wrote nothing), so its turns go on as before.
     0: the mind chose to wait with no length; it wakes on new input or at its own wake interval.
     n: the first wait's reason starts with a length ("wait 900", "wait 600 nothing owed", "wait 10 minutes",
        "wait 2h"; seconds unless it says minutes or hours), clamped to 30..86400 like sleep-for; it wakes on new
        input or after n seconds.
     2: only a trusted runtime format failure, for its first three attempts across wakes.
        Model-authored marker text is an ordinary wait; exhausted retries use the normal wake interval.
    60: the wait is the runtime's own provider error (hive_services.chat answers wait "LLM-PROVIDER-..." when
        the provider is unknown or unavailable): not the mind's choice, so a short fixed back-off, never the full wake
        interval (Kimi r1 K8), and a recovering provider is tried again within a minute.
     r: the hive itself refused the call for spending or pace (retry kind hive, hive_services.chat): the wait says the
        hive's sentence and lasts its retry_after, hive_wait, clamped like any chosen length; 60 when it gave none (0),
        as a provider error, since waiting longer helps only once someone raises the limit. The loop passes hive_wait
        from hive_services.last_wait_seconds beside the retry kind: the loop loads that module as hive_services, so an
        import of hive.runtime.hive_services here would be a second copy whose wait is never set.
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
        return FORMAT_RETRY_SECONDS if runtime_retry_due("format", format_attempts) else 0
    if retry_kind == "provider":
        return PROVIDER_RETRY_SECONDS
    if retry_kind == "hive":
        seconds = float(hive_wait) if isinstance(hive_wait, (int, float)) and not isinstance(hive_wait, bool) else 0.0
        return PROVIDER_RETRY_SECONDS if seconds <= 0 else int(min(86400, max(30, seconds)))
    if _WAIT_PROVIDER.match(text):
        return PROVIDER_RETRY_SECONDS
    if held_goal():
        return -1   # the mind holds a claimed goal with its own budget: its wait was refused (wait_result), so its turns go on
    found = _WAIT_SECONDS.match(text)
    if not found:
        return 0
    unit = (found.group(2) or "s")[0]
    seconds = float(found.group(1)) * {"s": 1, "m": 60, "h": 3600}[unit]
    return int(min(86400, max(30, seconds)))


def next_format_retry_count(kind, previous):
    """The existing loop keeps this bounded count across wakes; a well-formed response starts a new stretch."""
    return min(MAX_FORMAT_RETRIES + 1, max(0, int(previous)) + 1) if kind == "format" else 0


def runtime_retry_due(kind, format_attempts):
    """Whether the runtime's own retry brings the mind's next turn by itself, so the mind isn't resting.

    A provider failure always backs off PROVIDER_RETRY_SECONDS and tries again. A format failure retries after
    FORMAT_RETRY_SECONDS for its first MAX_FORMAT_RETRIES attempts in a row (format_attempts counts them, as
    next_format_retry_count leaves it). Past those it rests the mind until new input or its wake, as a wait it chose
    would, so the loop reports that rest to the hive (loop_hooks.metta hive-complete): on the v0.30 candidate a mind
    asked for a code mind sent four malformed batches in a row and then made no call for twelve minutes, and the person
    got neither the reminder nor the note."""
    if str(kind) == "provider":
        return True
    return str(kind) == "format" and 1 <= int(format_attempts) <= MAX_FORMAT_RETRIES


# A loop cycle asks while a mind's turns are spent, every sleepInterval (3 s), so one request per this many seconds.
HELD_GOAL_TTL = 5
_HELD = {"at": None, "goal": ""}


def held_goal(now=None):
    """'<id> <title>' of a goal this mind has claimed, still holds and that carries its own budget, or '' (none, or the
    hive cannot say): the hive-goals reading (hive_commons.held_goals), counting only goals it claimed itself whose
    step_budget_usd the hive's list gives (a Create step's, started at this mind's claim: Goals.list), reused for
    HELD_GOAL_TTL s. Any other goal it holds (a person's task, a swarm goal, a sub-goal it claimed) has no budget to
    bound renewed turns, so it keeps the turns a message or a wake buys and its waits, as before; a goal waiting on a
    person (status waiting) is not read, since the mind waits on it by design."""
    import time
    t = time.monotonic() if now is None else now
    if _HELD["at"] is not None and t - _HELD["at"] < HELD_GOAL_TTL:
        return _HELD["goal"]
    try:
        import hive_commons
        goals, error = hive_commons.held_goals(("claimed",), holder_only=True)
    except Exception:   # the mind keeps its normal turns when the hive cannot answer
        goals, error = None, "unavailable"
    budgeted = [g for g in goals or [] if g.get("step_budget_usd") is not None]
    goal = "" if error or not budgeted else f"{budgeted[0]['id']} {budgeted[0].get('title') or ''}".strip()
    _HELD.update(at=t, goal=goal)
    return goal


def renews_turns(loops, reply_kind):
    """'renew' when this cycle gives a mind back its spent turns: they are spent (loops 0 or less), its own reply
    spent them (reply_kind normal, honor-chosen-wait's &lastReplyKind), and it holds a claimed goal with its own
    budget (held_goal), which bounds what the renewed turns spend; else 'keep'.
    Without this, a builder that claimed its goal got 12 model calls per message, 7 after a format retry, then no call
    until the 900 s wake, and sat silent holding the goal. A reply the runtime failed keeps its own schedule: a
    provider failure's PROVIDER_RETRY_SECONDS back-off (a 402 at the mind's spending cap, an outage) and a format
    failure's FORMAT_RETRY_SECONDS, whose wake the loop grants when due, and past MAX_FORMAT_RETRIES the rest #491
    reports, after which Goals.stop_held ends what the mind holds."""
    if int(loops) > 0:
        _HELD["at"] = None      # a turn ran (it may have claimed or finished a goal): read the hive afresh once spent
        return "keep"
    if str(reply_kind) != "normal":
        return "keep"
    if _HELD["at"] is not None and not _HELD["goal"]:
        return "keep"           # it held nothing when its turns ran out, and only its own turns can claim a goal
    return "renew" if held_goal() else "keep"


def wait_result(reason, reply_kind="normal"):
    """What a wait answers: WAITING, or, for a wait the mind chose itself (reply_kind normal) while it holds a claimed
    goal with its own budget (held_goal), WAIT-REFUSED naming it, since a wait finishes nothing it holds and its turns
    go on (chosen_wait_seconds then lets the turns run). The runtime's own wait after a format or provider failure is
    never refused: the mind chose no wait, and the reason it carries is the retry's hint."""
    if str(reply_kind) != "normal":
        return f"WAITING:{reason}"
    goal = held_goal()
    if not goal:
        return f"WAITING:{reason}"
    gid = goal.split()[0]
    return (f"WAIT-REFUSED you hold {goal}; a wait finishes nothing you hold. Go on with it, finish it with "
            f"hive-goal-propose {gid} <result>, or give it back with hive-goal-fail {gid} <reason>.")


def rests_after(kind, previous, message_new=False):
    """Whether this reply leaves the mind resting with nothing due to wake it: a runtime format failure past the
    three retries, counted as honor-chosen-wait counts it (new input starts a fresh stretch first). The trace reports
    it (hive_commons.trace), so the hive can say which mind stopped and why rather than show it still at work."""
    if str(kind) != "format":
        return False
    previous = 0 if str(message_new).lower() in ("true", "1") else previous
    return next_format_retry_count("format", previous) > MAX_FORMAT_RETRIES


def _model_response(response, provider_failure="normal", last_reply="clear"):
    import re
    # The host has already classified its own unavailable/exception result. Never reclassify an outage as malformed
    # model output, including when a later syntax guard is tightened. Model text cannot supply this argument.
    if provider_failure in ("provider", "hive"):
        return signature_balance_parentheses(response), provider_failure
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
        kept = _kept_file_forms() if provider_failure == "format" else []
        if kept:
            # the cut-off reply's finished hive-goal-file commands run beside the refusal (provider_features), so the
            # files a builder finished are staged and its retry sends only the rest
            reason += "; your reply was cut off at its length limit and its finished files were staged, so send only the rest"
            return "(" + " ".join(kept + [f'(wait "{reason}")']) + ")", "format"
        return f'((wait "{reason}"))', "format"
    held = hold_messages_after_commands(commands, last_reply)
    return parsed if held == commands else "(" + " ".join(held) + ")", "normal"


def _kept_file_forms():
    """The top-level forms of the finished hive-goal-file commands a cut-off reply kept, and of the hive-goal-claim
    commands kept before them (provider_features.kept_file_commands), each read by the canonical parser and nothing
    else run; [] when it kept none or the provider isn't loaded."""
    try:
        from hive.runtime.provider_features import kept_file_commands
    except ImportError:
        return []
    kept = kept_file_commands()
    if not kept:
        return []
    forms = _signature_split_top_level_forms(signature_balance_parentheses(kept)[1:-1])
    return [form for form in forms if form.startswith(("(hive-goal-claim ", "(hive-goal-file "))]


# Jon on omega-flagship/omegahive#334: "a mind should report a result only after it comes back. The extra turn is
# fine." A reply's commands run one after another, and their results reach the mind only on its next turn, so a message
# written after another command in the same reply speaks of a result the mind hasn't seen: on v0.30 a mind told its
# person "Shared" while its share was being refused. Such a message is held. It runs as held-message, which sends
# nothing and says why, and the mind sees its own words beside the results on its next turn and sends what happened,
# as an agent's step that both acts and answers is refused until it has seen the action's result (LangChain's
# "Parsing LLM output produced both a final answer and a parse-able action").
# A hold comes at most once in a row: the reply right after one that held a message sends every message where it
# stands, so a mind that pairs a command with a message on every turn keeps its person waiting one extra turn at most,
# where before each such reply was held and each extra turn charged to the person who asked. Jon on #334: "Could a
# message that was held once go out the next time it's written?" The loop keeps the last reply's hold in &lastReplyHold
# (loop_hooks.metta), as it keeps its format retries.
MESSAGE_SKILLS = frozenset({"send", "send-hive-to", "hive-room-post"})
NO_RESULT_SKILLS = frozenset({"wait"})   # a wait has no result a message could speak of


def hold_messages_after_commands(commands, last_reply="clear"):
    """The reply's top-level command forms, each message that follows another command rewritten to
    (held-message <skill> <its arguments>), the rest unchanged and in order; all of them unchanged when the mind's last
    reply held a message (last_reply "held"). Time: one pass, O(total length)."""
    if str(last_reply) == "held":
        return list(commands)
    out, acted = [], False
    for form in commands:
        head = form[1:].split(None, 1)[0].rstrip(")") if form.startswith("(") and len(form) > 1 else ""
        if head in MESSAGE_SKILLS:
            out.append("(held-message " + form[1:] if acted else form)
        else:
            out.append(form)
            acted = acted or head not in NO_RESULT_SKILLS
    return out


def held_message_note(skill):
    """What a held message answers, read by the mind in its next LAST_SKILL_USE_RESULTS. It says nobody saw the held
    words, and that what the mind sends next is the first the person hears of it. Told only NOT SENT, a mind on a v0.32
    test build sent its person "Correction: ..." about a message the person never got; told that nobody had seen it, a
    team mind on the next build still began "One correction to my earlier note", since its own history shows the held
    words as something it wrote."""
    return ("NOT SENT, so nobody has seen it: this " + str(skill) + " came after another command in the same reply, so "
            "it waited for that command's result. Read the results, then send what actually happened as the first the "
            "person hears of it, not as a correction of a message they never got.")


def model_response_commands(response):
    """Standalone command view. Provenance is carried separately by prepare_model_response in the actual loop."""
    return _model_response(response)[0]


def prepare_model_response(response, provider_failure="normal", last_reply="clear"):
    """Trusted runtime envelope. The loop extracts string fields without evaluating envelope data as MeTTa.

    provider_failure comes only from hive_services.last_response_kind (runtime result objects, never model text). The raw
    batch check runs before the canonical parser's repair/prose path. No malformed prefix or suffix is executed.
    last_reply is the loop's &lastReplyHold, "held" when the mind's last reply held a message; "held" in the envelope
    says whether this reply held one, read back by prepared_response_hold.
    """
    import json
    commands, kind = _model_response(response, provider_failure, last_reply)
    # a message was held when holding changed the reply: read with holding off (as after a hold), it differs
    held = (kind == "normal" and str(last_reply) != "held"
            and commands != _model_response(response, provider_failure, "held")[0])
    return json.dumps({"commands": commands, "retry_kind": kind, "held": held}, separators=(",", ":"))


def prepared_response_commands(envelope):
    import json
    value = json.loads(envelope)["commands"]
    if not isinstance(value, str):
        raise ValueError("prepared commands must be text")
    return value


def prepared_response_kind(envelope):
    import json
    kind = json.loads(envelope)["retry_kind"]
    if kind not in ("normal", "format", "provider", "hive"):
        raise ValueError("invalid runtime retry kind")
    return kind


def prepared_response_hold(envelope, previous):
    """The loop's &lastReplyHold after a reply: "held" when it held a message, "clear" when it ran without holding one,
    and `previous` when the runtime ran none of it (a format or provider failure), so a failed turn between two replies
    lets no second hold in a row through."""
    import json
    data = json.loads(envelope)
    if data["retry_kind"] != "normal":
        return str(previous)
    return "held" if data["held"] is True else "clear"


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
