> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Internals — Skill Dispatch

This page traces what happens between an LLM response landing in the loop and a skill actually running.

## Expected LLM output shape

The prompt demands a tuple of up to 5 skill s-expressions:

```
((skillName1 "arg1") (skillName2 "arg2") ...)
```

With the hard rules that every argument is a quoted string and no MeTTa variables may appear.

## Step-by-step dispatch

From `src/loop.metta`:

1. **Raw LLM string** → `$respi`.
2. **Syntax command membrane** — `helper.signature_balance_parentheses $respi` → `$resp`. The membrane reads MeTTa-declared `SkillSignature` atoms, lowers friendly command text into typed skill calls, and fails closed with `wait` or `syntax-error` atoms.
3. **First-character check** — if `$resp` does not start with `(`, the agent receives a reminder prompt instead of a real dispatch; the LLM tries again next turn.
4. **Parse** — `catch (sread $response)` → `$sexpr`. On parse failure, `HandleError` records `MULTI_COMMAND_FAILURE_...`.
5. **Fan out** — `(superpose $sexpr)` produces one binding per skill call in the tuple.
6. **Evaluate each** — `(catch (eval $s))`. On success, the result is normalized via `helper.normalize_string`. On failure, `HandleError` records `SINGLE_COMMAND_FORMAT_ERROR_...`.
7. **Aggregate** — all results are collapsed into `RESULTS: ((COMMAND_RETURN: (cmd result)) ...)`.
8. **Feedback** — stored as `&lastresults`, fed back into the next prompt as `LAST_SKILL_USE_RESULTS`.

## How `eval $s` resolves to a skill

MeTTa evaluates the head of the expression against the AtomSpace. Skills are defined as plain equations:

```metta
(= (remember $str) ...)
(= (shell $cmd)    ...)
(= (metta $expr)   ...)
```

So `(shell "ls")` matches the equation for `shell` and runs its body.

Bridges enter via:

- `(py-call (module.function args))` for Python.
- `(translatePredicate (predicate ...))` and `!(import_prolog_function name)` for Prolog.

## Syntax and runtime errors propagate differently

Syntax membrane errors are returned as ordinary atoms such as `(syntax-error "sleep-for" "seconds must be number" ...)` before dispatch. They are visible to the next cycle as skill results, so the agent can correct the command shape.

`HandleError` appends to the `&error` state. When `addToHistory` runs, if `&error` is non-empty it is concatenated as `ERROR_FEEDBACK:`. On the next turn the agent sees the error and has the opportunity to correct course.

## See also

- [reference-internals-loop.md](./reference-internals-loop.md) — the full turn structure.
- [reference-syntax-membrane.md](./reference-syntax-membrane.md) — the typed syntax membrane and declaration contract.
- [reference-internals-extension-points.md](./reference-internals-extension-points.md) — where to hook in new skills.
- [tutorial-03-writing-a-custom-skill.md](./tutorial-03-writing-a-custom-skill.md) — end-to-end skill addition.
