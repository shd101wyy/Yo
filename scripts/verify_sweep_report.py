#!/usr/bin/env python3
"""Score a `yo verify --format json` report: outcomes.tsv, the tables, the ratchet.

Driven by scripts/verify-src-sweep.sh (plans/SELF_VERIFICATION.md, M0). Kept
separate so the scoring is testable without spending three minutes on a sweep:

    python3 scripts/verify_sweep_report.py --report fixture.json --tsv /dev/null \
        --baseline scripts/bootstrap/verify-src-baseline.tsv --ratchet 0

The number this campaign tracks is PROVED = functions whose outcome is `ok`
AND that discharged at least one obligation. A bare `ok` with an empty
obligation list proved nothing (the body generated no obligation), so counting
it would let the baseline rise without any verification happening.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

# A quoted name inside a blocker message ('"wasm32"', 'g_current_target') is
# per-function noise; the histogram wants the SHAPE of the blocker.
_QUOTED = re.compile(r"'[^']*'")


def load(path: str) -> dict:
    text = open(path, encoding="utf-8").read()
    start = text.index('{"solver"')
    return json.loads(text[start:])


def module_of(fn_id: str, root: str | None = None) -> str:
    """`fn@src/types/utils.yo:65` -> `src/types/utils.yo`.

    Handles every id shape (`fn@…:row`, `impl-variance@…:row:label`) by cutting
    at the module extension, and normalizes the path defensively: a report from
    a compiler without the canonical-id fix spells a demand-loaded module
    `file:///<abs>/src/x.yo`
    (issues/fixed/verify-report-fn-id-carries-file-scheme-absolute-path.md), and the
    ratchet baseline must key one module the same way on every machine.
    """
    body = fn_id.split("@", 1)[1] if "@" in fn_id else fn_id
    if body.startswith("file://"):
        body = body[len("file://") :]
    cut = body.rfind(".yo")
    if cut != -1:
        body = body[: cut + len(".yo")]
    root = root or os.getcwd()
    if body.startswith(root + os.sep):
        body = body[len(root) + 1 :]
    return body


def normalize_blocker(msg: str) -> str:
    return _QUOTED.sub("'…'", msg or "").strip()


def read_baseline(path: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                module, count = line.split("\t")
                counts[module] = int(count)
    except FileNotFoundError:
        pass
    return counts


def write_baseline(path: str, counts: dict[str, int]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(
            "# Self-verification ratchet (plans/SELF_VERIFICATION.md, M0).\n"
            "# <module>\t<functions with >=1 discharged obligation>\n"
            "# Re-record deliberately: scripts/verify-src-sweep.sh --record\n"
        )
        for module in sorted(counts):
            fh.write(f"{module}\t{counts[module]}\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--tsv", required=True)
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--elapsed", type=int, default=0)
    ap.add_argument("--record", type=int, default=0)
    ap.add_argument("--ratchet", type=int, default=1)
    args = ap.parse_args()

    report = load(args.report)
    fns = report.get("functions", [])

    rows = []
    for fn in fns:
        fn_id = fn.get("fn_id", "")
        obligations = fn.get("obligations") or []
        rows.append(
            {
                "fn_id": fn_id,
                "module": module_of(fn_id),
                "outcome": fn.get("outcome", ""),
                # `vacuous` is emitted by the compiler; derive it too so an
                # older report still scores.
                "proved": fn.get("outcome") == "ok" and len(obligations) > 0,
                "obligations": len(obligations),
                "blocker": normalize_blocker(fn.get("subset_construct", "")),
            }
        )
    rows.sort(key=lambda r: r["fn_id"])

    with open(args.tsv, "w", encoding="utf-8") as fh:
        fh.write("fn_id\tmodule\toutcome\tproved\tobligations\tblocker\n")
        for r in rows:
            fh.write(
                f"{r['fn_id']}\t{r['module']}\t{r['outcome']}\t"
                f"{int(r['proved'])}\t{r['obligations']}\t{r['blocker']}\n"
            )

    outcomes = collections.Counter(r["outcome"] for r in rows)
    proved = sum(1 for r in rows if r["proved"])
    vacuous = sum(1 for r in rows if r["outcome"] == "ok" and not r["proved"])
    obligations = sum(r["obligations"] for r in rows)

    print()
    print(f"  functions          {len(rows)}")
    print(f"  proved (>=1 obl)   {proved}")
    print(f"  vacuous ok         {vacuous}")
    print(f"  obligations        {obligations}")
    for outcome, count in sorted(outcomes.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {outcome:<18} {count}")
    if args.elapsed:
        print(f"  wall               {args.elapsed}s")

    blockers = collections.Counter(
        r["blocker"] for r in rows if r["blocker"] and not r["proved"]
    )
    if blockers:
        print("\n  blockers (first blocking construct per function):")
        for blocker, count in blockers.most_common(25):
            print(f"  {count:6d}  {blocker}")

    current = collections.Counter()
    for r in rows:
        if r["proved"]:
            current[r["module"]] += 1

    if args.record:
        # Merge: a partial sweep records what it measured and leaves every
        # module it did not sweep untouched.
        merged = read_baseline(args.baseline)
        swept_now = {r["module"] for r in rows}
        for module in swept_now:
            count = current.get(module, 0)
            if count:
                merged[module] = count
            else:
                merged.pop(module, None)
        write_baseline(args.baseline, merged)
        print(f"\n  recorded baseline -> {args.baseline} ({proved} proved)")
        return 0

    if not args.ratchet:
        return 0

    refuted = [r for r in rows if r["outcome"] == "refuted"]
    baseline = read_baseline(args.baseline)
    # A module absent from THIS report was not swept (the sweep may cover one
    # subtree — verifying the whole tree peaks at ~9.3 GB, see
    # plans/SELF_VERIFICATION.md). Comparing it against the baseline would
    # report a regression for work that simply was not measured.
    swept = {r["module"] for r in rows}
    regressions = []
    for module, was in sorted(baseline.items()):
        if module not in swept:
            continue
        now = current.get(module, 0)
        if now < was:
            regressions.append((module, was, now))
    gains = []
    for module in sorted(swept):
        was, now = baseline.get(module, 0), current.get(module, 0)
        if now > was:
            gains.append((module, was, now))

    failed = False
    if refuted:
        failed = True
        print(f"\n  FAIL: {len(refuted)} refuted function(s) — a refutation is a bug:")
        for r in refuted[:20]:
            print(f"    {r['fn_id']}")
    if regressions:
        failed = True
        print("\n  FAIL: fewer proved functions than the baseline:")
        for module, was, now in regressions:
            print(f"    {module}: {was} -> {now}")
    if gains:
        print("\n  Gains (re-record with --record to lock them in):")
        for module, was, now in gains:
            print(f"    {module}: {was} -> {now}")

    if failed:
        return 1
    covered = sum(v for m, v in baseline.items() if m in swept)
    print(f"\n  ratchet OK ({proved} proved; baseline {covered} over the {len(swept)} module(s) swept)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
