#!/usr/bin/env python3
"""What the compiler needs from the verifier, counted from its signatures.

plans/SELF_VERIFICATION.md's census: which parameter kinds keep `src/` out of
the verifiable subset, and therefore which lever (L1..L6) unblocks how much.
The sweep says which functions are blocked; this says WHY, in terms the levers
are written against.

    python3 scripts/verify_src_census.py            # ./src
    python3 scripts/verify_src_census.py --path std

Signature-shaped regex over `(fn(...)` headers, not a parse: it is a planning
instrument, so a few percent either way changes nothing. A function counts once
per kind it needs.
"""

from __future__ import annotations

import argparse
import collections
import glob
import os
import re
import sys

SIG = re.compile(r"\(\s*fn\((.*?)\)\s*->", re.S)

# (label, pattern, lever) — ordered as the plan's census table.
KINDS = [
    ("str/String", r"\bString\b|\bstr\b", "L1 strings"),
    (
        "AstExpr/ExprInfo/TypeValue/EvalValue",
        r"\bAstExpr\b|\bExprInfo|\bTypeValue\b|\bEvalValue\b",
        "L3 immutable refs as datatypes",
    ),
    (
        "ArrayList/HashMap/HashSet",
        r"\bArrayList\(|\bHashMap\(|\bHashSet\(",
        "L4 collections via std contracts",
    ),
    ("EvalContext/Environment", r"\bEvalContext\b|\bEnvironment\b", "L6 mutable heap"),
    ("Exception", r"\bException\b", "L2 exceptions as exit paths"),
    ("Io", r"\bIo\b", "(not verified by design)"),
    ("own/inout", r"\bown\(|\binout\(", "(in the subset)"),
    ("closure", r"\bImpl\(Fn", "(stays out)"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default="src")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.path, "**", "*.yo"), recursive=True))
    if not files:
        print(f"census: no .yo files under {args.path}", file=sys.stderr)
        return 2

    total = 0
    counts: collections.Counter[str] = collections.Counter()
    clean = 0
    for path in files:
        text = open(path, encoding="utf-8").read()
        for match in SIG.finditer(text):
            params = match.group(1)
            total += 1
            hit = False
            for label, pattern, _lever in KINDS:
                if re.search(pattern, params):
                    counts[label] += 1
                    hit = True
            if not hit:
                clean += 1

    print(f"\n  {args.path}: {total} fn signatures in {len(files)} files\n")
    print(f"  {'share':>6}  {'count':>6}  parameter kind / lever")
    for label, _pattern, lever in KINDS:
        count = counts[label]
        print(f"  {100 * count / total:5.1f}%  {count:6d}  {label} — {lever}")
    print(f"  {100 * clean / total:5.1f}%  {clean:6d}  none of the above (subset-eligible today)")

    # The other sizes the plan quotes.
    joined = "".join(open(p, encoding="utf-8").read() for p in files)
    print()
    for label, pattern in [
        ("while loops (each needs an invariant)", r"while\("),
        ("exn.throw sites", r"exn\.throw\("),
        ("module-level mutable globals", r"(?m)^\(g_[A-Za-z_]+ : "),
        ("unsafe( sites (the assumed() boundary)", r"unsafe\("),
        ("in-place writes through a ref (x.*.f = )", r"\.\*\.[A-Za-z_]+ = "),
    ]:
        print(f"  {len(re.findall(pattern, joined)):6d}  {label}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
