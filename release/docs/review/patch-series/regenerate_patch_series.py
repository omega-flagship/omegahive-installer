from pathlib import Path
import difflib
import subprocess

PATCH_DIR = Path("docs/review/patch-series/patches")
PATCH_DIR.mkdir(parents=True, exist_ok=True)
for stale_patch in PATCH_DIR.glob("*.patch"):
    stale_patch.unlink()

SAFE_RUNTIME_DELETIONS = {
    "memory/history.metta",
    "memory/prompt.txt",
}


def is_excluded(path: str) -> bool:
    p = path.replace("\\", "/")
    if p in SAFE_RUNTIME_DELETIONS:
        return False
    if p.startswith("memory/"):
        return True
    if p.startswith("channels/whatsapp_bridge/auth"):
        return True
    if "/node_modules/" in "/" + p:
        return True
    if p.endswith(".pyc") or "/__pycache__/" in "/" + p:
        return True
    return False


def is_tracked(path: str) -> bool:
    return (
        subprocess.run(
            ["git", "ls-files", "--error-unmatch", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    )


def tracked_diff(paths: list[str]) -> str:
    if not paths:
        return ""
    return subprocess.run(
        ["git", "diff", "--binary", "HEAD", "--", *paths],
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    ).stdout


def deletion_only_diff(paths: list[str]) -> str:
    if not paths:
        return ""
    return subprocess.run(
        ["git", "diff", "HEAD", "--", *paths],
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    ).stdout


def new_file_patch(path: str) -> str:
    data = Path(path).read_bytes()
    if b"\0" in data:
        return (
            f"diff --git a/{path} b/{path}\n"
            "new file mode 100644\n"
            "index 0000000..0000000\n"
            "--- /dev/null\n"
            f"+++ b/{path}\n"
            "@@ -0,0 +1 @@\n"
            "+<binary file omitted from review patch>\n"
        )
    text = data.decode("utf-8", errors="replace").splitlines()
    header = (
        f"diff --git a/{path} b/{path}\n"
        "new file mode 100644\n"
        "index 0000000..0000000\n"
    )
    diff = "\n".join(
        difflib.unified_diff(
            [],
            text,
            fromfile="/dev/null",
            tofile=f"b/{path}",
            lineterm="",
        )
    )
    return header + diff + "\n"


def collect(paths: list[str]) -> list[str]:
    out: list[str] = []
    for spec in paths:
        p = Path(spec)
        if p.is_dir():
            for f in sorted(x for x in p.rglob("*") if x.is_file()):
                s = str(f)
                if not is_excluded(s):
                    out.append(s)
        elif p.exists():
            s = str(p)
            if not is_excluded(s):
                out.append(s)
        else:
            out.append(spec)
    return sorted(dict.fromkeys(out))


def write_patch(filename: str, paths: list[str], title: str) -> None:
    selected = collect(paths)
    safe_deletions = [p for p in selected if p in SAFE_RUNTIME_DELETIONS]
    selected = [p for p in selected if p not in SAFE_RUNTIME_DELETIONS]
    tracked = [p for p in selected if is_tracked(p)]
    untracked = [p for p in selected if Path(p).exists() and not is_tracked(p)]
    body = [tracked_diff(tracked), deletion_only_diff(safe_deletions)]
    for path in untracked:
        body.append(new_file_patch(path))
        if not body[-1].endswith("\n"):
            body.append("\n")
    target = Path(filename)
    target.write_text("".join(body), encoding="utf-8")
    print(
        filename,
        "tracked",
        len(tracked),
        "untracked",
        len(untracked),
        "lines",
        target.read_text(encoding="utf-8").count("\n"),
    )


def git_show(path: str) -> str:
    return subprocess.run(
        ["git", "show", f"HEAD:{path}"],
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    ).stdout


def replace_once(text: str, old: str, new: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match for loop transform, got {count}: {old[:80]!r}")
    return text.replace(old, new, 1)


def file_diff(path: str, before: str, after: str) -> str:
    if before == after:
        return ""
    return "\n".join(
        difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            lineterm="",
        )
    ) + "\n"


def append_patch(filename: str, body: str) -> None:
    if not body:
        return
    target = Path(filename)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(body)
    print(
        filename,
        "appended",
        body.count("\n"),
        "lines",
        target.read_text(encoding="utf-8").count("\n"),
    )


def loop_syntax_variant(text: str) -> str:
    command_results = """

(= (command-results $items)
   (if (== $items ())
       ()
       (let* (($cmd (car-atom $items))
              ($rest (cdr-atom $items))
              ($result (HandleError SINGLE_COMMAND_FORMAT_ERROR_NOTHING_WAS_DONE_PLEASE_FIX_AND_RETRY
                                    $cmd
                                    (catch (let $R (car-atom (collapse (reduce $cmd)))
                                                (py-call (helper.normalize_string $R)))))))
             (cons (COMMAND_RETURN: ($cmd $result))
                   (command-results $rest)))))
"""
    text = replace_once(
        text,
        """(= (HandleError $msg $cmd $sexpr)
   (case $sexpr (((Error $a $b) (let $new (append (get-state &error) (($msg $cmd)))
                                          (change-state! &error $new)))
                 ($else $sexpr))))

(= (omegaclaw)
""",
        """(= (HandleError $msg $cmd $sexpr)
   (case $sexpr (((Error $a $b) (let $new (append (get-state &error) (($msg $cmd)))
                                          (change-state! &error $new)))
                 ($else $sexpr))))
""" + command_results + """
(= (omegaclaw)
""",
    )
    text = replace_once(
        text,
        """                                       ($resp (py-call (helper.balance_parentheses $respi)))
                                       ($response (if (== "(" (first_char $resp)) $resp (progn (println! $resp) (repr (REMEMBER:OUTPUT_NOTHING_ELSE_THAN: ((skill arg) ...))))))
""",
        """                                       ($resp (py-call (helper.signature_balance_parentheses $respi)))
                                       ($response $resp)
""",
    )
    return replace_once(
        text,
        """                                       ($results (RESULTS: (collapse (let $s (superpose $sexpr) (COMMAND_RETURN: ($s (HandleError SINGLE_COMMAND_FORMAT_ERROR_NOTHING_WAS_DONE_PLEASE_FIX_AND_RETRY $s (catch (let $R (eval $s) (py-call (helper.normalize_string $R)))))))))))
""",
        """                                       ($results (RESULTS: (command-results $sexpr)))
""",
    )


def loop_energy_variant(text: str) -> str:
    replacements = [
        ("(configure maxNewInputLoops 50) ;20", "(configure maxNewInputLoops 10) ;bounded restart posture; the agent can choose more with energy skills"),
        ("(configure maxWakeLoops 1)", "(configure maxWakeLoops 0)"),
        ("(configure sleepInterval 1) ;10", "(configure sleepInterval 3) ;slower continuous loop"),
        ("          (configure LLM gpt-5.4)\n", ""),
        ("          (configure provider Anthropic) ;Anthropic or OpenAI or ASICloud or ASIOne or Test\n", ""),
        ("(configure wakeupInterval 600) ;600=10 minutes", "(configure wakeupInterval 1800) ;autonomous wake interval; messages still wake immediately"),
    ]
    for old, new in replacements:
        text = replace_once(text, old, new)
    text = replace_once(
        text,
        """          (change-state! &lastresults "")
          (change-state! &maxPersistentAtomsChars (maxPersistentAtomsChars))
""",
        """          (change-state! &lastresults "")
          (change-state! &maxNewInputLoops (maxNewInputLoops))
          (change-state! &maxWakeLoops (maxWakeLoops))
          (change-state! &sleepInterval (sleepInterval))
          (change-state! &wakeupInterval (wakeupInterval))
          (change-state! &maxPersistentAtomsChars (maxPersistentAtomsChars))
""",
    )
    text = replace_once(
        text,
        """          (change-state! &cycle 1)
          (change-state! &loops (maxNewInputLoops))))
""",
        """          ; Neutral boot posture: enough attention to orient, then the agent can choose.
          (change-state! &energyMode "warm")
          (change-state! &practiceStartCycle 1)
          (change-state! &practiceLabel "none")
          (change-state! &nextWakeAt (+ (get_time) (get-state &wakeupInterval)))
          (change-state! &cycle 1)
          (change-state! &loops (get-state &maxNewInputLoops))))
""",
    )
    text = replace_once(
        text,
        """                                     (change-state! &loops (maxNewInputLoops)) _)))
""",
        """                                     (change-state! &loops (get-state &maxNewInputLoops)) _)))
""",
    )
    text = replace_once(
        text,
        """                                       ($_ (change-state! &nextWakeAt (+ (get_time) (wakeupInterval))))
""",
        """                                       ($_ (change-state! &nextWakeAt (+ (get_time) (get-state &wakeupInterval))))
""",
    )
    text = replace_once(
        text,
        """                                    (change-state! &loops (+ 1 (maxWakeLoops))) _)))
                      (bound-runtime-spaces-by-role memory)
                      (save-runtime-spaces-by-role memory)
                      (sleep (sleepInterval))
""",
        """                                    (change-state! &loops (+ 2 (get-state &maxWakeLoops))) _)))
                      (bound-runtime-spaces-by-role memory)
                      (save-runtime-spaces-by-role memory)
                      (sleep (get-state &sleepInterval))
""",
    )
    return text


def loop_memory_variant(text: str) -> str:
    text = replace_once(
        text,
        """(= (spamShield) (empty))
""",
        """(= (spamShield) (empty))
(= (maxPersistentAtomsChars) (empty))
(= (maxAgendaAtomsChars) (empty))
(= (maxBeliefAtomsChars) (empty))
(= (maxWorldAtomsChars) (empty))
(= (maxEventAtomsChars) (empty))
(= (maxActivityAtomsChars) (empty))
(= (maxScratchAtomsChars) (empty))
""",
    )
    text = replace_once(
        text,
        """          (configure wakeupInterval 600) ;600=10 minutes
          (change-state! &prevmsg "")
""",
        """          (configure wakeupInterval 600) ;600=10 minutes
          ; Temporary survival bounds from the current architecture.
          ; Keep these until full ECAN/attention-driven pruning can replace
          ; automatic char-pressure removal with reasoned graph maintenance.
          (configure maxPersistentAtomsChars 10000)
          (configure maxAgendaAtomsChars 20000)
          (configure maxBeliefAtomsChars 50000)
          (configure maxWorldAtomsChars 50000)
          (configure maxEventAtomsChars 50000)
          (configure maxActivityAtomsChars 60000)
          (configure maxScratchAtomsChars 20000)
          (change-state! &prevmsg "")
""",
    )
    text = replace_once(
        text,
        """          (change-state! &lastresults "")
          (change-state! &loops (maxNewInputLoops))))
""",
        """          (change-state! &lastresults "")
          (change-state! &maxPersistentAtomsChars (maxPersistentAtomsChars))
          (change-state! &maxAgendaAtomsChars (maxAgendaAtomsChars))
          (change-state! &maxBeliefAtomsChars (maxBeliefAtomsChars))
          (change-state! &maxWorldAtomsChars (maxWorldAtomsChars))
          (change-state! &maxEventAtomsChars (maxEventAtomsChars))
          (change-state! &maxActivityAtomsChars (maxActivityAtomsChars))
          (change-state! &maxScratchAtomsChars (maxScratchAtomsChars))
          (change-state! &cycle 1)
          (change-state! &loops (maxNewInputLoops))))
""",
    )
    text = replace_once(
        text,
        """   (progn (if (== $k 1) (progn (initLoop)
                               (initMemory)
                               (initChannels))
                        (change-state! &loops (- (get-state &loops) 1)))
          (let $prompt (getContext)
""",
        """   (progn (if (== $k 1) (progn (initLoop)
                               (initMemory)
                               (initChannels))
                        (change-state! &loops (- (get-state &loops) 1)))
          (change-state! &cycle $k)
          (let $prompt (getContext)
""",
    )
    text = replace_once(
        text,
        """" LAST_SKILL_USE_RESULTS: " (last_chars (get-state &lastresults) (maxFeedback)) " HISTORY: " (getHistory) " TIME: " (get_time_as_string)))))
""",
        """" LAST_SKILL_USE_RESULTS: " (last_chars (get-state &lastresults) (maxFeedback)) " HISTORY: " (getHistory)
                         " PROMOTED_MEMORY_HINTS: " (promoted-memory-hints) " TIME: " (get_time_as_string)))))
""",
    )
    text = replace_once(
        text,
        """                                      (progn (if (or $msgnew  (not (== $sexpr ()))) (addToHistory $msg $response $sexpr $msgnew) _)
""",
        """                                      (progn (if (or $msgnew  (not (== $sexpr ()))) (addToHistory $msg $response $sexpr $msgnew $results) _)
""",
    )
    return replace_once(
        text,
        """                      (sleep (sleepInterval))
""",
        """                      (bound-runtime-spaces-by-role memory)
                      (save-runtime-spaces-by-role memory)
                      (sleep (sleepInterval))
""",
    )


def loop_module_variant(text: str) -> str:
    runtime_organs = """

(= (initRuntimeOrgans)
   (let $started (collapse (match &self (RuntimeOrgan $name $call)
                                  (if (runtime-organ-trusted $name)
                                      (RuntimeOrganStarted $name (eval $call))
                                      (RuntimeOrganRejected $name untrusted))))
        (if (== $started ()) RuntimeOrgansNone $started)))
"""
    text = replace_once(
        text,
        """          (change-state! &loops (get-state &maxNewInputLoops))))

(= (getContext)
""",
        """          (change-state! &loops (get-state &maxNewInputLoops))))
""" + runtime_organs + """
(= (getContext)
""",
    )
    return replace_once(
        text,
        """   (progn (if (== $k 1) (progn (initLoop)
                               (initMemory)
                               (initChannels))
                        (change-state! &loops (- (get-state &loops) 1)))
""",
        """   (progn (if (== $k 1) (progn (initLoop)
                               (initMemory)
                               (initChannels)
                               (initRuntimeOrgans))
	                        (progn (change-state! &loops (- (get-state &loops) 1))
	                               (run-runtime-hooks cycle)))
""",
    )


LOOP_BASE = git_show("src/loop.metta")
LOOP_01A = loop_syntax_variant(LOOP_BASE)
LOOP_01B = loop_memory_variant(LOOP_01A)
LOOP_01C = loop_energy_variant(LOOP_01B)


def helper_syntax_variant(text: str) -> str:
    return text + """

# Signature-declared command membrane.
#
# The command surface is declared in src/skill_signatures*.metta.  Keep this
# as a thin compatibility export so the MeTTa loop can continue calling
# helper.signature_balance_parentheses without making helper.py own the parser.
try:
    from .helper_command_parser import (
        signature_balance_parentheses,
        balance_parentheses,
    )
except Exception:
    from helper_command_parser import (
        signature_balance_parentheses,
        balance_parentheses,
    )
"""


HELPER_BASE = git_show("src/helper.py")
HELPER_01A = helper_syntax_variant(HELPER_BASE)
HELPER_CURRENT = Path("src/helper.py").read_text(encoding="utf-8")


LOOP_01D = LOOP_01C
LOOP_04A = loop_module_variant(LOOP_01D)


def lib_core_variant(
    extra_imports: list[str],
    include_reasoning_catalog: bool = False,
    include_affordance_catalog: bool = False,
    include_energy: bool = True,
) -> str:
    lines = [
        "!(import! &self (library lib_patrick))",
        "!(import! &self (library lib_llm))",
        "!(import! &self (library lib_vector))",
        "!(import! &self (library lib_combinatorics))",
        "!(import! &self (library lib_spaces))",
        "!(import! &self (library OmegaClaw-Core lib_nal))",
        "!(import! &self (library OmegaClaw-Core lib_pln))",
    ]
    if include_reasoning_catalog:
        lines.append("!(import! &self (library lib_nars))")
    lines.extend(
        [
            "!(import! &self (library OmegaClaw-Core lib_llm_ext.py))",
            "!(import! &self (library OmegaClaw-Core ./src/helper.py))",
            "!(import! &self (library OmegaClaw-Core ./channels/irc.py))",
            "!(import! &self (library OmegaClaw-Core ./channels/mattermost.py))",
            "!(import! &self (library OmegaClaw-Core ./channels/telegram.py))",
            "!(import! &self (library OmegaClaw-Core ./channels/slack.py))",
            "!(import! &self (library OmegaClaw-Core ./channels/websearch.py))",
            "!(import! &self (library OmegaClaw-Core ./src/utils))",
            "!(import! &self (library OmegaClaw-Core ./src/channels))",
            "!(import! &self (library OmegaClaw-Core ./src/skill_catalog.metta))",
            "!(import! &self (library OmegaClaw-Core ./src/skill_catalog_core.metta))",
            "!(import! &self (library OmegaClaw-Core ./src/skill_catalog_memory.metta))",
        ]
    )
    if include_energy:
        lines.extend(
            [
                "!(import! &self (library OmegaClaw-Core ./src/energy.py))",
                "!(import! &self (library OmegaClaw-Core ./src/skill_catalog_energy.metta))",
            ]
        )
    if include_reasoning_catalog:
        lines.append("!(import! &self (library OmegaClaw-Core ./src/skill_catalog_reasoning.metta))")
    if include_affordance_catalog:
        lines.append("!(import! &self (library OmegaClaw-Core ./src/skill_catalog_affordance.metta))")
    lines.extend(f"!(import! &self (library OmegaClaw-Core ./{path}))" for path in extra_imports)
    lines.extend(
        [
            "!(import! &self (library OmegaClaw-Core ./src/memory))",
            "!(import! &self (library OmegaClaw-Core ./src/loop))",
            '!(git-import! "https://github.com/patham9/petta_lib_chromadb.git")',
            "!(import! &self (library petta_lib_chromadb lib_chromadb))",
            "!(bind! &persistent (new-space))",
            "!(bind! &agenda (new-space))",
            "!(bind! &beliefs (new-space))",
            "!(bind! &world (new-space))",
            "!(bind! &events (new-space))",
            "!(bind! &activity (new-space))",
        ]
    )
    return "\n".join(lines) + "\n"


LIB_BASE = git_show("lib_omegaclaw.metta")
LIB_01B = lib_core_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
    ],
    include_reasoning_catalog=False,
    include_energy=False,
)
LIB_01C = lib_core_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
    ],
    include_reasoning_catalog=False,
    include_energy=True,
)
LIB_01D = lib_core_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
    ],
    include_reasoning_catalog=True,
)
LIB_04A = lib_core_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
        "src/skills_affordance.metta",
    ],
    include_reasoning_catalog=True,
    include_affordance_catalog=True,
)
LIB_04E = lib_core_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
        "./modules/scratch_space/entry.metta",
        "src/skills_affordance.metta",
    ],
    include_reasoning_catalog=True,
    include_affordance_catalog=True,
)
LIB_04G = lib_core_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
        "./modules/scratch_space/entry.metta",
        "./modules/agentverse/entry.metta",
        "src/skills_affordance.metta",
    ],
    include_reasoning_catalog=True,
    include_affordance_catalog=True,
)


def skills_loader_variant(imports: list[str]) -> str:
    lines = [
        "; Skill implementation loader.",
        ";",
        "; The advertised command catalog lives in ./src/skill_catalog.metta.",
        "; This facade preserves the historical src/skills.metta import while keeping",
        "; organs reviewable by cognitive/body boundary.",
        "",
    ]
    for path in imports:
        lines.append(f"!(import! &self (library OmegaClaw-Core ./{path}))")
    return "\n".join(lines) + "\n"


SKILLS_BASE = git_show("src/skills.metta")
SKILLS_01B = skills_loader_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
    ]
)
SKILLS_01C = skills_loader_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
    ]
)
SKILLS_01D = skills_loader_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
    ]
)
SKILLS_02 = skills_loader_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
        "src/skills_assume.metta",
    ]
)
SKILLS_03 = skills_loader_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
        "src/skills_assume.metta",
        "src/skills_attention.metta",
    ]
)
SKILLS_04A = skills_loader_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
        "src/skills_affordance.metta",
        "src/skills_assume.metta",
        "src/skills_attention.metta",
    ]
)
SKILLS_04F = skills_loader_variant(
    [
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "src/skills_energy.metta",
        "src/skills_reasoning_spaces.metta",
        "src/skills_affordance.metta",
        "src/skills_assume.metta",
        "src/skills_attention.metta",
        "src/skills_body.metta",
    ]
)


write_patch(
    str(PATCH_DIR / "00-repo-boundary-runtime-state.patch"),
    [
        ".gitignore",
        "memory/history.metta",
        "memory/prompt.txt",
        "tests/test_repo_boundary.py",
    ],
    "00 Repository boundary: keep runtime state local",
)

write_patch(
    str(PATCH_DIR / "01a-syntax-command-membrane.patch"),
    [
        "src/helper_command_parser.py",
        "src/helper_metta_syntax.py",
        "src/skills.pl",
        "src/skill_catalog.metta",
        "src/skill_catalog_core.metta",
        "src/skill_catalog_memory.metta",
        "src/skill_catalog_reasoning.metta",
        "src/skill_signatures.metta",
        "src/skill_signatures_core.metta",
        "src/skill_signatures_energy.metta",
        "src/skill_signatures_memory.metta",
        "src/skill_signatures_reasoning.metta",
        "tests/test_syntax_smoke_corpus.py",
        "tests/test_syntax_history_fixture.py",
        "tests/fixtures/syntax_history_sample.metta",
        "tests/test_write_surface.py",
        "tests/replay_recent_syntax.py",
        "tests/bench_parser_latency.py",
        "docs/review/clean-patch-boundary.md",
        "docs/review/dependency-boundary-audit.md",
        "docs/reference-syntax-membrane.md",
        "docs/reference-internals-skill-dispatch.md",
        "docs/reference-failure-modes.md",
        "docs/reference-python-bridges.md",
    ],
    "01a Syntax command membrane and write surface",
)
append_patch(
    str(PATCH_DIR / "01a-syntax-command-membrane.patch"),
    file_diff("src/loop.metta", LOOP_BASE, LOOP_01A),
)
append_patch(
    str(PATCH_DIR / "01a-syntax-command-membrane.patch"),
    file_diff("src/helper.py", HELPER_BASE, HELPER_01A),
)

write_patch(
    str(PATCH_DIR / "01b-runtime-memory-context-boundary.patch"),
    [
        "src/helper_metta.py",
        "src/helper_history.py",
        "src/helper_promotion.py",
        "src/helper_reboot.py",
        "src/memory.metta",
        "src/skills_core.metta",
        "src/skills_runtime_spaces.metta",
        "src/skills_memory.metta",
        "src/skills_space_mutation.metta",
        "tests/test_memory_runtime.py",
        "tests/write_surface_loop_smoke.metta",
        "tests/event_note_shape_guard_smoke.metta",
        "tests/llm_portability_contract_guard_smoke.metta",
        "tests/structured_memory_contract_guard_smoke.metta",
        "tests/space_registry_smoke.metta",
        "tests/runtime_memory_boot_composition_smoke.metta",
        "tests/space_transform_exact_shapes_smoke.metta",
        "tests/space_transform_five_arg_overload_smoke.metta",
        "tests/space_transform_loop_wrapper_smoke.metta",
        "tests/space_transform_skill_smoke.metta",
        "tests/run_metta_smokes.py",
        "docs/reference-skills-memory.md",
    ],
    "01b Runtime memory spaces and context boundary",
)
append_patch(
    str(PATCH_DIR / "01b-runtime-memory-context-boundary.patch"),
    file_diff("src/loop.metta", LOOP_01A, LOOP_01B),
)
append_patch(
    str(PATCH_DIR / "01b-runtime-memory-context-boundary.patch"),
    file_diff("lib_omegaclaw.metta", LIB_BASE, LIB_01B),
)
append_patch(
    str(PATCH_DIR / "01b-runtime-memory-context-boundary.patch"),
    file_diff("src/skills.metta", SKILLS_BASE, SKILLS_01B),
)
append_patch(
    str(PATCH_DIR / "01b-runtime-memory-context-boundary.patch"),
    file_diff("src/helper.py", HELPER_01A, HELPER_CURRENT),
)

write_patch(
    str(PATCH_DIR / "01c-provider-runtime-energy.patch"),
    [
        "lib_llm_ext.py",
        "src/energy.py",
        "src/skill_affordance_energy.metta",
        "src/skills_energy.metta",
        "src/skill_catalog_energy.metta",
        "tests/test_energy.py",
        "tests/test_llm_provider.py",
        "tests/cycle_affordance_smoke.metta",
    ],
    "01c Provider/runtime and energy controls",
)
append_patch(
    str(PATCH_DIR / "01c-provider-runtime-energy.patch"),
    file_diff("src/loop.metta", LOOP_01B, LOOP_01C),
)
append_patch(
    str(PATCH_DIR / "01c-provider-runtime-energy.patch"),
    file_diff("lib_omegaclaw.metta", LIB_01B, LIB_01C),
)
append_patch(
    str(PATCH_DIR / "01c-provider-runtime-energy.patch"),
    file_diff("src/skills.metta", SKILLS_01B, SKILLS_01C),
)

write_patch(
    str(PATCH_DIR / "01d-symbolic-reasoning-space-skills.patch"),
    [
        "src/skills_reasoning_spaces.metta",
        "src/skill_affordance_reasoning.metta",
        "tests/nars_assimilation_smoke.metta",
        "tests/reasoning_space_smoke.metta",
        "tests/space_examples_smoke.metta",
        "tests/space_transform_bad_syntax_experiment.metta",
        "tests/space_transform_experiment.metta",
        "docs/reference-skills-reasoning.md",
        "docs/reference-lib-ona.md",
        "docs/reference-internals-extension-points.md",
    ],
    "01d Symbolic reasoning and space skill membranes",
)
append_patch(
    str(PATCH_DIR / "01d-symbolic-reasoning-space-skills.patch"),
    file_diff("lib_omegaclaw.metta", LIB_01C, LIB_01D),
)
append_patch(
    str(PATCH_DIR / "01d-symbolic-reasoning-space-skills.patch"),
    file_diff("src/skills.metta", SKILLS_01C, SKILLS_01D),
)
append_patch(
    str(PATCH_DIR / "01d-symbolic-reasoning-space-skills.patch"),
    file_diff("src/loop.metta", LOOP_01C, LOOP_01D),
)

write_patch(
    str(PATCH_DIR / "02a-assume-symbolic-graph-engine.patch"),
    [
        "src/assume.py",
        "tests/test_assume_engine.py",
        "tests/causal_cortex_atomspace_smoke.metta",
    ],
    "02a Assume symbolic graph engine",
)

write_patch(
    str(PATCH_DIR / "02b-assume-fabricpc-daemon-membrane.patch"),
    [
        "src/assume_client.py",
        "src/assume_fabricd.py",
        "tests/test_assume_fabricd.py",
        "tests/assume_fabric_bridge_smoke.metta",
        "tests/assume_fabricd_skill_smoke.metta",
        "tests/assume_feature_graph_fabric_smoke.metta",
    ],
    "02b Assume FabricPC daemon membrane",
)

write_patch(
    str(PATCH_DIR / "02c-assume-metta-skill-and-mutation-review.patch"),
    [
        "lib_omegaclaw_assume.metta",
        "src/skill_affordance_assume.metta",
        "src/skill_catalog_assume.metta",
        "src/skill_signatures_assume.metta",
        "src/skills_assume.metta",
        "tests/test_assume.py",
        "tests/test_syntax_assume_smoke.py",
        "tests/assume_atom_id_smoke.metta",
        "tests/assume_atomspace_fabric_writeback_smoke.metta",
        "tests/assume_boot_loaded_loop_smoke.metta",
        "tests/assume_loop_persistence_candidate_smoke.metta",
        "tests/assume_observe_error_atoms_smoke.metta",
        "tests/assume_observe_loop_wrapper_smoke.metta",
        "tests/assume_outcome_loop_smoke.metta",
        "tests/assume_persistence_isolated_smoke.metta",
        "tests/assume_situation_birth_review_smoke.metta",
    ],
    "02c Assume MeTTa skill and mutation review",
)
append_patch(
    str(PATCH_DIR / "02c-assume-metta-skill-and-mutation-review.patch"),
    file_diff("src/skills.metta", SKILLS_01D, SKILLS_02),
)

write_patch(
    str(PATCH_DIR / "02d-assume-demo-space-and-tests.patch"),
    [
        "demos/assume",
        "tests/test_assume_demo_space.py",
        "tests/assume_demo_benchmark.py",
        "tests/assume_demo_story.py",
        "docs/review/assume-fabric-demo-review.md",
    ],
    "02d Assume demo space and tests",
)

write_patch(
    str(PATCH_DIR / "03-attention-ecan-lite-immune-organ.patch"),
    [
        "lib_omegaclaw_attention.metta",
        "src/attention_ledger.py",
        "src/skill_affordance_attention.metta",
        "src/skills_attention.metta",
        "src/skill_catalog_attention.metta",
        "src/skill_signatures_attention.metta",
        "tests/test_attention_ledger.py",
        "tests/test_syntax_attention_smoke.py",
        "tests/attention_ledger_smoke.metta",
        "tests/attention_retire_candidate_smoke.metta",
        "tests/agenda_hygiene_smoke.metta",
    ],
    "03 Attention / ECAN-lite immune organ",
)
append_patch(
    str(PATCH_DIR / "03-attention-ecan-lite-immune-organ.patch"),
    file_diff("src/skills.metta", SKILLS_02, SKILLS_03),
)

write_patch(
    str(PATCH_DIR / "04a-module-contract.patch"),
    [
        "docs/reference-omegaclaw-module-contract.md",
        "src/skill_affordance_core.metta",
        "src/skill_catalog_affordance.metta",
        "src/skill_signatures_affordance.metta",
        "src/skills_affordance.metta",
        "tests/fixtures/modules",
        "tests/test_module_contract.py",
        "tests/skill_affordance_smoke.metta",
        "tests/module_contract_smoke.metta",
        "tests/module_membrane_smoke.metta",
        "tests/module_worlds_smoke.metta",
    ],
    "04a Module contract and generic membranes",
)
append_patch(
    str(PATCH_DIR / "04a-module-contract.patch"),
    file_diff("src/loop.metta", LOOP_01D, LOOP_04A),
)
append_patch(
    str(PATCH_DIR / "04a-module-contract.patch"),
    file_diff("lib_omegaclaw.metta", LIB_01D, LIB_04A),
)
append_patch(
    str(PATCH_DIR / "04a-module-contract.patch"),
    file_diff("src/skills.metta", SKILLS_03, SKILLS_04A),
)

write_patch(
    str(PATCH_DIR / "04b-body-skill-surface.patch"),
    [
        "src/skills_body.metta",
        "src/skill_affordance_body.metta",
        "src/skill_affordance_channels.metta",
        "src/skill_catalog_body.metta",
        "src/skill_catalog_channels.metta",
        "src/skill_signatures_body.metta",
        "src/skill_signatures_channels.metta",
        "tests/test_device_smoke.py",
        "tests/test_syntax_body_smoke.py",
        "tests/test_syntax_channels_smoke.py",
        "docs/reference-skills-io.md",
        "docs/tutorial-03-writing-a-custom-skill.md",
    ],
    "04b Optional body skill surface",
)

write_patch(
    str(PATCH_DIR / "04c-communication-channels.patch"),
    [
        "src/channels.metta",
        "channels/mattermost.py",
        "channels/telegram.py",
        "channels/router.py",
        "channels/web_control.py",
        "channels/whatsapp.py",
        "channels/whatsapp_bridge/bridge.mjs",
        "channels/whatsapp_bridge/package.json",
        "channels/whatsapp_bridge/package-lock.json",
    ],
    "04c Communication channels and WhatsApp bridge",
)

write_patch(
    str(PATCH_DIR / "04d-situated-senses-and-apps.patch"),
    [
        "src/audio.py",
        "src/glucose.py",
        "src/home.py",
        "src/imagegen.py",
        "src/observation.py",
        "src/terminal_mirror.py",
        "src/videogen.py",
        "src/vision.py",
        "src/webcam.py",
        "tests/test_glucose.py",
        "tests/test_terminal_mirror.py",
        "tests/test_observe_router.py",
    ],
    "04d Situated senses and app organs",
)

write_patch(
    str(PATCH_DIR / "04e-shareable-runtime-modules.patch"),
    [
        "modules/__init__.py",
        "modules/body_container",
        "modules/codex_code",
        "modules/gameboy",
        "modules/omega_vm",
        "modules/publishing",
        "modules/scratch_space",
        "modules/vm_policy",
        "docs/retired/scratch-space-legacy",
        "src/body_container.py",
        "src/codex_code.py",
        "src/gameboy.py",
        "src/omega_vm.py",
        "src/publishing.py",
        "src/vm_policy.py",
        "tests/test_body_container_module.py",
        "tests/test_codex_code_module.py",
        "tests/test_gameboy_module.py",
        "tests/test_module_organs.py",
        "tests/test_syntax_module_smoke.py",
        "tests/test_vm_policy_module.py",
        "tests/test_skill_surface_contract.py",
        "tests/module_body_container_smoke.metta",
        "tests/module_codex_code_smoke.metta",
        "tests/module_gameboy_smoke.metta",
        "tests/module_omega_vm_smoke.metta",
        "tests/module_publishing_smoke.metta",
        "tests/module_scratch_space_smoke.metta",
        "tests/module_vm_policy_smoke.metta",
    ],
    "04e Shareable runtime modules",
)
append_patch(
    str(PATCH_DIR / "04e-shareable-runtime-modules.patch"),
    file_diff("lib_omegaclaw.metta", LIB_04A, LIB_04E),
)

write_patch(
    str(PATCH_DIR / "04f-body-composition-loader.patch"),
    [
        "lib_omegaclaw_body.metta",
        "tests/body_status_smoke.metta",
        "tests/test_patch_contracts.py",
    ],
    "04f Body composition loader",
)
append_patch(
    str(PATCH_DIR / "04f-body-composition-loader.patch"),
    file_diff("src/skills.metta", SKILLS_04A, SKILLS_04F),
)

write_patch(
    str(PATCH_DIR / "04g-agentverse-remote-agent-organ.patch"),
    [
        "modules/agentverse",
        "src/agentverse.py",
        "tests/test_agentverse_module.py",
        "docs/README.md",
        "docs/reference-skills-communication.md",
        "docs/reference-skills-remote-agents.md",
        "docs/tutorial-06-remote-agentverse-skills.md",
        "docs/tutorial-07-grounded-reasoning.md",
        "docs/tutorial-08-reliable-reasoning.md",
    ],
    "04g Agentverse remote-agent organ",
)
append_patch(
    str(PATCH_DIR / "04g-agentverse-remote-agent-organ.patch"),
    file_diff("lib_omegaclaw.metta", LIB_04E, LIB_04G),
)

write_patch(
    str(PATCH_DIR / "05-review-benchmark-suite.patch"),
    [
        "docs/review/benchmark_suite.py",
        "tests/test_benchmark_suite.py",
    ],
    "05 Review benchmark suite",
)

write_patch(
    str(PATCH_DIR / "90-local-web-ui-not-for-upstream.patch"),
    [
        "src/webhost.py",
        "web/omega-os",
        "docs/reference-omega-organ-map.md",
        "docs/reference-spline-omega-os-brief.md",
        "docs/retired/omega-os-three-prototype",
        "tests/test_webhost_local.py",
        "tests/test_omega_surface.py",
    ],
    "90 Local web UI and spatial OS experiments - not for upstream",
)

write_patch(
    str(PATCH_DIR / "91-local-runtime-composition-not-for-upstream.patch"),
    [
        "run.metta",
        "lib_omegaclaw_no_agentverse.metta",
        "src/skills_core_no_agentverse.metta",
    ],
    "91 Local runtime composition - not for upstream",
)
