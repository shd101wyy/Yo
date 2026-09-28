#!/usr/bin/env python3
"""The 5b C-diff oracle (plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md §5.3).

It fails if a safe-mode runtime guard disappears without a proof. For each
fixture it emits C twice, once normally and once with `--no-guard-elision`,
and checks three things:

1. Soundness: every guard present in the reference C but missing from the
   elided C is a `proved` obligation site in `yo verify --format json` for
   the same file (same file, row, column and class).
2. Nothing else changes: every differing line of the reference C carries
   one of those removed guards, and the line counts match.
3. Firing: a fixture whose header says `// expect-elided: N` has exactly N
   guards removed, and the compiler reported the same N.
4. Twins, for a fixture that elides something: with `--target
   wasm32-wasip1` (rule 4: no elision off 64-bit) and with no solver on a
   cold cache (an empty `YO_CACHE_DIR`, no `YO_Z3_PATH`), both builds must
   agree on the exit status and, when they compile, emit identical C.

Usage: scripts/check-guard-elision.py [--bin yo] [FILE_OR_DIR ...]
Default inputs: tests/spec/fixtures/elision/ and tests/spec/fixtures/valid/.
Needs the pinned Z3: nothing elides without a solver, so without one every
fixture that expects elision fails. The FV CI job has the solver.
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile

GUARD = re.compile(r'(__yo_idx_chk|__yo_div_guard_u|__yo_sh_chk)\((.*?)"([^"]*)", (\d+), (\d+)\)')
CLASS = {
    "__yo_idx_chk": "index-in-bounds",
    "__yo_div_guard_u": "divisor-nonzero",
    "__yo_sh_chk": "shift-in-width",
}
ELIDED_LINE = re.compile(r"verify: (\d+) guard\(s\) elided")
EXPECT = re.compile(r"^//\s*expect-elided:\s*(\d+)\s*$", re.M)


def guards(c_text):
    """(class, file, row, col) of every guard helper call, 1-based."""
    out = set()
    for m in GUARD.finditer(c_text):
        out.add((CLASS[m.group(1)], m.group(3), int(m.group(4)), int(m.group(5))))
    return out


def compile_c(binary, src, out_base, extra, env=None):
    cmd = [binary, "compile", src, "--emit-c", "--skip-c-compiler", "-o", out_base] + extra
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    c_path = out_base + ".c"
    c_text = open(c_path).read() if (p.returncode == 0 and os.path.exists(c_path)) else None
    return p.returncode, c_text, p.stdout + p.stderr


def proved_sites(binary, src):
    p = subprocess.run([binary, "verify", src, "--format", "json"], capture_output=True, text=True)
    lines = p.stdout.split("\n")
    start = next((i for i, l in enumerate(lines) if l.startswith("{")), None)
    if start is None:
        return None
    report = json.loads("\n".join(lines[start:]))
    sites = set()
    for fn in report.get("functions", []):
        for obl in fn.get("obligations", []):
            s = obl.get("site")
            if s and obl.get("verdict") == "proved":
                sites.add((s["class"], os.path.basename(s["module"]), int(s["row"]), int(s["column"])))
    return sites


def check(binary, src, work):
    """Returns a list of failure strings (empty = pass) and a status note."""
    base_a = os.path.join(work, "elided")
    base_b = os.path.join(work, "reference")
    rc_a, c_a, log_a = compile_c(binary, src, base_a, [])
    rc_b, c_b, log_b = compile_c(binary, src, base_b, ["--no-guard-elision"])
    if (rc_a == 0) != (rc_b == 0):
        return [f"only one variant compiled (elided rc {rc_a}, reference rc {rc_b})"], ""
    header = EXPECT.search(open(src).read())
    if rc_a != 0:
        if header is not None:
            return [f"an elision fixture must compile (rc {rc_a}): {log_a.strip()[-300:]}"], ""
        return [], "skipped (does not compile standalone)"
    fails = []
    reported = ELIDED_LINE.search(log_a)
    n_reported = int(reported.group(1)) if reported else 0
    removed = guards(c_b) - guards(c_a)
    added = guards(c_a) - guards(c_b)
    if added:
        fails.append(f"elision ADDED guards: {sorted(added)}")
    if removed:
        proved = proved_sites(binary, src)
        if proved is None:
            fails.append("no JSON report from yo verify")
            proved = set()
        for cls, f, r, col in sorted(removed):
            if (cls, os.path.basename(f), r, col) not in proved:
                fails.append(f"guard removed WITHOUT a proof: {cls} at {f}:{r}:{col}")
    lines_a = c_a.split("\n")
    lines_b = c_b.split("\n")
    if len(lines_a) != len(lines_b):
        fails.append(f"line count changed ({len(lines_b)} -> {len(lines_a)})")
    for tag, i1, i2, _j1, _j2 in difflib.SequenceMatcher(None, lines_b, lines_a, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        for line in lines_b[i1:i2]:
            if not (guards(line) & removed):
                fails.append(f"a line without a removed guard changed: {line.strip()[:160]}")
    if n_reported != len(removed):
        fails.append(f"compiler reported {n_reported} elided, C lost {len(removed)} guard(s)")
    if header is not None and int(header.group(1)) != len(removed):
        fails.append(f"expected {header.group(1)} elided, got {len(removed)}")
    if removed:
        fails += twins(binary, src, work)
    return fails, f"{len(removed)} elided"


def twins(binary, src, work):
    """Rule 4 and the no-solver rule: these builds must elide nothing."""
    fails = []
    cold = os.path.join(work, "cold-cache")
    os.mkdir(cold)
    no_solver = {k: v for k, v in os.environ.items() if k != "YO_Z3_PATH"}
    no_solver["YO_CACHE_DIR"] = cold
    for name, extra, env in [
        ("wasm32", ["--target", "wasm32-wasip1"], None),
        ("no-solver", [], no_solver),
    ]:
        rc_a, c_a, log_a = compile_c(binary, src, os.path.join(work, name + "-elided"), extra, env)
        rc_b, c_b, _ = compile_c(binary, src, os.path.join(work, name + "-reference"), extra + ["--no-guard-elision"], env)
        if (rc_a == 0) != (rc_b == 0):
            fails.append(f"{name}: only one variant compiled (elided rc {rc_a}, reference rc {rc_b})")
        elif rc_a == 0 and c_a != c_b:
            fails.append(f"{name}: the C differs from --no-guard-elision")
        elif ELIDED_LINE.search(log_a):
            fails.append(f"{name}: the compiler reported an elision")
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.environ.get("YO", "yo"))
    ap.add_argument("inputs", nargs="*", default=["tests/spec/fixtures/elision", "tests/spec/fixtures/valid"])
    args = ap.parse_args()
    files = []
    for inp in args.inputs:
        if os.path.isdir(inp):
            files += sorted(os.path.join(inp, n) for n in os.listdir(inp) if n.endswith(".yo"))
        else:
            files.append(inp)
    bad = 0
    for src in files:
        with tempfile.TemporaryDirectory() as work:
            fails, note = check(args.bin, src, work)
        if fails:
            bad += 1
            print(f"FAIL {src}")
            for f in fails:
                print(f"     {f}")
        else:
            print(f"ok   {src} ({note})")
    print(f"guard-elision oracle: {len(files) - bad}/{len(files)} passed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
