#!/usr/bin/env python3
"""The both-modes sweep (plans/backlog/DEFAULT_ON_VERIFICATION.md, step S0).

Every fixture of a directory (default tests/spec/fixtures/valid) is verified
twice, once under `pragma(Pragma.Verify);` and once under
`pragma(Pragma.VerifyOrAssert);`, and both runs must prove the same set of
functions. `verify+` is the mode the plan makes the default, so a function it
fails to prove where `verify` proves it is a verifier bug, not a fixture bug.

How a fixture is put under a mode: the directory is copied twice into OUT
(default yo-out/verify-both-modes), the verify pragma of each copy is rewritten
to the mode's pragma on its own line (rows, and so function ids, do not move),
and each file is verified with `--verify-mode <mode>` as well, which is what a
file without a verify pragma (a runtime twin) runs under. Each file runs in its
own process. A fixture that diverges in that parallel pass is run again, one
process at a time, and only a divergence that persists counts. One that is
still only `unproven` against `ok`, with every UNPROVEN reason naming the
wall-clock backstop, is reported as inconclusive and does not fail: a loaded
machine can turn a proof into a wall-clock `unknown` in either mode.

A divergence fails the run unless the fixture is listed in KNOWN
(default tests/spec/verify-both-modes-known.tsv: fixture, open issue doc); a
listed fixture that no longer diverges fails too, so the list only shrinks.

  python3 -I scripts/verify-both-modes.py --bin yo-out/x86_64-unknown-linux-gnu/bin/yo --std-path ./std
"""
import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys

MODES = {
    "verify": "pragma(Pragma.Verify);",
    "verify+": "pragma(Pragma.VerifyOrAssert);",
}
PRAGMA_RE = re.compile(r"pragma\(Pragma\.(Verify|VerifyOrAssert)\);")
FN_KEY_RE = re.compile(r"/([^/]+\.yo:.*)$")
UNPROVEN_RE = re.compile(r": UNPROVEN +(.*)$", re.M)


def fn_key(fn_id):
    """`fn@<path>/<file>.yo:<row>[...]` → `<file>.yo:<row>[...]`."""
    m = FN_KEY_RE.search(fn_id)
    return m.group(1) if m else fn_id


def copy_for_mode(src_dir, dst_dir, mode):
    if os.path.exists(dst_dir):
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    for name in sorted(os.listdir(dst_dir)):
        if not name.endswith(".yo"):
            continue
        path = os.path.join(dst_dir, name)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(PRAGMA_RE.sub(MODES[mode], text))


def verify_one(binary, std_path, path, mode, timeout):
    cmd = [binary, "verify", path, "--format", "json", "--verify-mode", mode]
    if std_path:
        cmd += ["--std-path", std_path]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"rc": "timeout", "report": None, "stderr": ""}
    report = None
    for line in p.stdout.splitlines():
        if line.startswith('{"solver"'):
            report = json.loads(line)
    return {"rc": p.returncode, "report": report, "stderr": p.stderr}


def load_known(path):
    known = {}
    if not path or not os.path.exists(path):
        return known
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            cols = line.split("\t")
            known[cols[0]] = cols[1] if len(cols) > 1 else ""
    return known


def compare(name, results):
    """The divergences of one fixture between the modes, and each mode's `ok` count."""
    outcomes = {}
    problems = []
    for mode in MODES:
        r = results[(name, mode)]
        rep = r["report"]
        if rep is None:
            tail = "\n".join(r["stderr"].strip().splitlines()[-6:])
            problems.append(f"{mode}: no report (rc={r['rc']})\n      " + tail.replace("\n", "\n      "))
            outcomes[mode] = None
            continue
        by_fn = {}
        for fr in rep["functions"]:
            if fr["mode"] != mode:
                problems.append(f"{mode}: {fr['fn_id']} ran under {fr['mode']}")
            by_fn[fn_key(fr["fn_id"])] = fr["outcome"]
        outcomes[mode] = by_fn
    # The modes whose side of a divergence is `unproven` against the other
    # mode's `ok`: a load-dependent answer is possible there (see main).
    unproven_modes = set()
    if outcomes["verify"] is not None and outcomes["verify+"] is not None:
        a, b = outcomes["verify"], outcomes["verify+"]
        for k in sorted(set(a) | set(b)):
            oa, ob = a.get(k, "-"), b.get(k, "-")
            if (oa == "ok") != (ob == "ok"):
                problems.append(f"{k}: verify={oa} verify+={ob}")
                if {oa, ob} == {"ok", "unproven"}:
                    unproven_modes.add("verify" if oa == "unproven" else "verify+")
                else:
                    unproven_modes.add(None)
    n_ok = {m: (sum(1 for o in outcomes[m].values() if o == "ok") if outcomes[m] is not None else "-") for m in MODES}
    return problems, n_ok, unproven_modes


def unproven_reasons(binary, std_path, path, mode, timeout):
    """The UNPROVEN reasons of a text-format run (the JSON report omits them)."""
    cmd = [binary, "verify", path, "--verify-mode", mode]
    if std_path:
        cmd += ["--std-path", std_path]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return ["timeout of the whole run"]
    return [m.group(1) for m in UNPROVEN_RE.finditer(p.stdout)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", default=os.environ.get("YO", "yo"))
    ap.add_argument("--std-path", default=os.environ.get("YO_STD", ""))
    ap.add_argument("--dir", default="tests/spec/fixtures/valid")
    ap.add_argument("--out", default="yo-out/verify-both-modes")
    ap.add_argument("--known", default="tests/spec/verify-both-modes-known.tsv")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--timeout", type=int, default=900, help="seconds per file and mode")
    ap.add_argument("--only", action="append", default=[], help="verify only this fixture (repeatable)")
    args = ap.parse_args()

    src_dir = args.dir.rstrip("/")
    fixtures = sorted(n for n in os.listdir(src_dir) if n.endswith(".yo"))
    if args.only:
        fixtures = [n for n in fixtures if n in args.only]
    base = os.path.basename(src_dir)
    mode_dirs = {}
    for mode in MODES:
        d = os.path.join(args.out, mode.replace("+", "-plus"), base)
        copy_for_mode(src_dir, d, mode)
        mode_dirs[mode] = d

    def path_of(name, mode):
        path = os.path.join(mode_dirs[mode], name)
        return path if os.path.isabs(path) else "./" + path

    def run(name, mode):
        return verify_one(args.bin, args.std_path, path_of(name, mode), mode, args.timeout)

    jobs = [(name, mode) for name in fixtures for mode in MODES]
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futs = {pool.submit(run, name, mode): (name, mode) for name, mode in jobs}
        for fut in concurrent.futures.as_completed(futs):
            results[futs[fut]] = fut.result()

    # A solver query can answer `unknown` because the wall-clock backstop fired
    # on a loaded machine before the rlimit was spent
    # (issues/2026-10-25-spec-insertion-sort-flips-to-unproven-under-machine-load.md).
    # That says nothing about the mode. So a fixture that diverges in the
    # parallel pass is run again one process at a time, and a divergence that
    # is still only `unproven` against `ok` is inconclusive when every
    # UNPROVEN reason of a third, text-format run names the wall clock.
    retried = {}
    inconclusive = {}
    for name in fixtures:
        first = compare(name, results)[0]
        if not first:
            continue
        for mode in MODES:
            results[(name, mode)] = run(name, mode)
        retried[name] = first
        problems, _, unproven_modes = compare(name, results)
        if problems and None not in unproven_modes:
            reasons = []
            for mode in sorted(unproven_modes):
                reasons += unproven_reasons(args.bin, args.std_path, path_of(name, mode), mode, args.timeout)
            if all("wall-clock timeout" in r for r in reasons):
                inconclusive[name] = (problems, reasons)

    known = load_known(args.known)
    diverged = {}
    lines = []
    totals = {m: 0 for m in MODES}
    for name in fixtures:
        problems, n_ok, _ = compare(name, results)
        if name in inconclusive:
            problems = []
        for m in MODES:
            if n_ok[m] != "-":
                totals[m] += n_ok[m]
        status = "DIVERGES" if problems else "same"
        lines.append(f"{status:9} {name}  ok: verify={n_ok['verify']} verify+={n_ok['verify+']}")
        for p in problems:
            lines.append(f"    {p}")
        if name in inconclusive:
            lines.append("    inconclusive: the unproven side is a wall-clock timeout or proves on a third run (machine load, not the mode):")
            for p in inconclusive[name][0]:
                lines.append(f"      {p}")
            for r in inconclusive[name][1]:
                lines.append(f"      {r}")
        elif name in retried and not problems:
            lines.append("    settled on a sequential retry; the parallel pass had:")
            for p in retried[name]:
                lines.append(f"      {p}")
        if problems:
            diverged[name] = problems

    print("\n".join(lines))
    print(
        f"verify-both-modes: {len(fixtures)} fixtures x {len(MODES)} modes; "
        f"proved functions: verify={totals['verify']} verify+={totals['verify+']}; "
        f"{len(diverged)} diverging, {len(inconclusive)} inconclusive"
    )
    rc = 0
    for name in sorted(diverged):
        if name in known:
            print(f"verify-both-modes: known divergence {name} ({known[name]})")
        else:
            print(f"verify-both-modes: FAIL {name} proves a different set under verify and verify+")
            rc = 1
    for name in sorted(known):
        if name in fixtures and name not in diverged:
            print(f"verify-both-modes: FAIL {name} is listed in {args.known} but no longer diverges: delete its row")
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
