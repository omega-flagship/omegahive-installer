"""Check that the shards of a full run (hive-petta, scripts/ci/hive_shard.py) ran the whole of hive/tests once.

usage: hive_shard_check.py SHARDS DIR --target-minutes T --overhead-minutes O --max-imbalance R [--weights-out FILE]

DIR holds one folder per shard (the jobs' artifacts), each with report.json (from hive_shard.py) and junit.xml (from
pytest --junitxml with junit_family=xunit1). The check fails unless:
  1. there are SHARDS reports, one for each shard 0..SHARDS-1, each split into SHARDS;
  2. every shard collected the same suite: the same files with the same test counts;
  3. the shards' files are disjoint and together are every collected file, so their selected counts sum to the
     collected count;
  4. each shard's junit.xml holds as many distinct testcases in the shard's files as the shard selected, so no shard
     stopped part way.
It prints the counts and each shard's time, and with --weights-out writes the seconds per test file the junit files
measured, which is what scripts/ci/hive-shard-weights.json is refreshed from (scripts/ci/hive_shard.py balances by
it; a file missing from it weighs its test count times the median seconds per test).
It prints the plain shards' imbalance, the longest plain shard's test time over their mean, and warns above
--max-imbalance: the shards are no longer balanced, so the weights file is due a refresh from this run's
hive-shard-weights artifact. Last it prints the shard count to use next: one plain shard per T - O minutes of the plain
shards' serial test time, T the full run's wall target and O a shard job's time outside its tests (setup, toolchain,
collection), so the full run stays near its target as the suite grows (also into $GITHUB_STEP_SUMMARY when set). A file
longer than T - O on its own sets a floor no shard count lowers (the split is by file), and it warns so. The three
numbers have no default here: .github/workflows/ci.yml passes them from its env (HIVE_TARGET_MINUTES,
HIVE_SHARD_OVERHEAD_MINUTES, HIVE_MAX_IMBALANCE). Changing the count is one number: the HIVE_SHARDS variable ci.yml
reads (the shards input overrides it for one run).
"""
import argparse
import json
import math
import os
import sys
import xml.etree.ElementTree as ET


def read_junit(path, files=None):
    """(tests, seconds per file) from a pytest junit file (xunit1, whose testcases carry file=), over the testcases
    of `files` (all files when None). tests is the number of distinct testcases (file, classname, name), never the
    suite's tests= attribute nor the row count: tests= also counts each subtest, and both count a module skipped at
    collection, which every shard reports because every shard collects the whole suite; a test that errors in
    teardown has two rows. (Run 44793192701, shard 6: tests=1244 and 1195 rows for 1194 selected: 49 subtests and
    hive/tests/test_tools.py's module-level skip.)"""
    root = ET.parse(path).getroot()
    cases, seconds = set(), {}
    for case in root.iter("testcase"):
        f = case.get("file")
        if not f or (files is not None and f not in files):
            continue
        cases.add((f, case.get("classname"), case.get("name")))
        seconds[f] = seconds.get(f, 0.0) + float(case.get("time", 0) or 0)
    return len(cases), seconds


def check(count, reports, junits):
    """Problems (empty when the shards covered the suite once) and the facts to print. reports: shard -> report;
    junits: shard -> (tests, seconds per file) or None when the shard left no junit file."""
    problems = []
    if sorted(reports) != list(range(count)):
        problems.append(f"reports for shards {sorted(reports)}, want 0..{count - 1}")
    for i, r in sorted(reports.items()):
        if r["count"] != count:
            problems.append(f"shard {i} split into {r['count']}, want {count}")
        if r["selected"] != sum(r["files"].get(f, 0) for f in r["selected_files"]):
            problems.append(f"shard {i} selected {r['selected']}, but its files hold a different count")
    suites = {json.dumps(r["files"], sort_keys=True) for r in reports.values()}
    if len(suites) > 1:
        problems.append(f"the shards collected {len(suites)} different suites")
    files = next(iter(reports.values()))["files"] if reports else {}
    collected = sum(files.values())
    seen = {}
    for i, r in sorted(reports.items()):
        for f in r["selected_files"]:
            if f in seen:
                problems.append(f"{f} is in shards {seen[f]} and {i}")
            seen[f] = i
    missing = sorted(set(files) - set(seen))
    if missing:
        problems.append(f"{len(missing)} collected files in no shard: {', '.join(missing[:10])}")
    selected = sum(r["selected"] for r in reports.values())
    if selected != collected:
        problems.append(f"the shards selected {selected} tests, but the suite collected {collected}")
    for i, r in sorted(reports.items()):
        j = junits.get(i)
        if j is None:
            problems.append(f"shard {i} left no junit.xml")
        elif j[0] != r["selected"]:
            problems.append(f"shard {i} reported {j[0]} tests in junit.xml, but selected {r['selected']}")
    return problems, {"collected": collected, "files": len(files), "selected": selected}


def suggested_shards(serial_seconds, minutes_per_shard):
    """One shard per minutes_per_shard of serial test time, at least one."""
    if minutes_per_shard <= 0:
        raise ValueError(f"no test time is left per shard ({minutes_per_shard:g} min): the target is below the overhead")
    return max(1, math.ceil(serial_seconds / (60 * minutes_per_shard)))


def imbalance(seconds):
    """The longest of the plain shards' test times over their mean: 1.0 when balanced, 1.0 with no time measured."""
    mean = sum(seconds) / len(seconds) if seconds else 0.0
    return max(seconds) / mean if mean > 0 else 1.0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("shards", type=int)
    ap.add_argument("dir")
    ap.add_argument("--weights-out")
    ap.add_argument("--target-minutes", type=float, required=True)
    ap.add_argument("--overhead-minutes", type=float, required=True)
    ap.add_argument("--max-imbalance", type=float, required=True)
    args = ap.parse_args(argv)
    reports, junits = {}, {}
    for name in sorted(os.listdir(args.dir)):
        folder = os.path.join(args.dir, name)
        report = os.path.join(folder, "report.json")
        if not os.path.isfile(report):
            continue
        with open(report) as fh:
            r = json.load(fh)
        if r["shard"] in reports:
            print(f"::error::two reports for shard {r['shard']}")
            return 1
        reports[r["shard"]] = r
        junit = os.path.join(folder, "junit.xml")
        junits[r["shard"]] = read_junit(junit, set(r["selected_files"])) if os.path.isfile(junit) else None
    problems, facts = check(args.shards, reports, junits)
    print(f"suite: {facts['collected']} tests in {facts['files']} files; the shards selected {facts['selected']}")
    # HIVE_SHARDS counts the plain shards; the switch shard (scripts/ci/switch-shard.sh) is one more and its files are
    # fixed, so the suggestion comes from the plain shards' time alone.
    weights, plain_files, longest, plain, plain_shards = {}, {}, 0.0, 0.0, []
    for i in sorted(reports):
        j = junits.get(i)
        secs = sum(j[1].values()) if j else 0.0
        longest = max(longest, secs)
        weights.update(j[1] if j else {})
        switch = reports[i].get("switch", False)
        plain += 0.0 if switch else secs
        if not switch:
            plain_shards.append(secs)
            plain_files.update(j[1] if j else {})
        print(f"  shard {i}{' (switch)' if switch else ''}: {reports[i]['selected']} tests in "
              f"{len(reports[i]['selected_files'])} files, {secs / 60:.1f} min of test time")
    serial = sum(weights.values())
    budget = args.target_minutes - args.overhead_minutes
    n = suggested_shards(plain, budget)
    ratio = imbalance(plain_shards)
    line = (f"serial test time {serial / 60:.1f} min, longest shard {longest / 60:.1f} min over {args.shards} shards; "
            f"suggested HIVE_SHARDS: {n} (one plain shard per {budget:g} min of the plain shards' serial test time, "
            f"{plain / 60:.1f} min: a {args.target_minutes:g} min target less {args.overhead_minutes:g} min outside "
            f"the tests); plain-shard imbalance {ratio:.2f} (longest over mean)")
    print(line)
    if ratio > args.max_imbalance:
        print(f"::warning::the plain shards' imbalance is {ratio:.2f}, over {args.max_imbalance:g}: refresh "
              f"scripts/ci/hive-shard-weights.json from this run's hive-shard-weights artifact")
    if plain_files:   # the switch shard's files are fixed, so no plain count moves them
        top, top_secs = max(plain_files.items(), key=lambda kv: kv[1])
        if top_secs > 60 * budget:
            print(f"::warning::{top} alone takes {top_secs / 60:.1f} min, over the {budget:g} min per shard: no "
                  f"shard count brings the run under its target while the split is by file")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write(f"hive/tests: {facts['collected']} tests in {facts['files']} files; {line}\n")
    if args.weights_out:
        with open(args.weights_out, "w") as fh:
            json.dump({f: round(s, 1) for f, s in sorted(weights.items())}, fh, indent=1)
            fh.write("\n")
    for p in problems:
        print(f"::error::{p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
