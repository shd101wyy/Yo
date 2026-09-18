#!/usr/bin/env python3
"""Merge several `yo verify --format json` reports into one.

The sweep runs one `yo verify` process per path (verifying the whole tree at
once peaks at ~9.3 GB), so the parts have to be stitched back together before
scoring. Each part's stdout carries check progress before the JSON object, so
the report is taken from the first `{"solver"` onward. Functions are
de-duplicated by `fn_id`: overlapping paths must not double-count.
"""

from __future__ import annotations

import argparse
import json
import sys


def load(path: str) -> dict:
    text = open(path, encoding="utf-8").read()
    return json.loads(text[text.index('{"solver"') :])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("parts", nargs="+")
    args = ap.parse_args()

    merged: dict | None = None
    seen: set[str] = set()
    functions: list[dict] = []
    for part in args.parts:
        report = load(part)
        if merged is None:
            merged = {k: v for k, v in report.items() if k != "functions"}
        for fn in report.get("functions", []):
            fn_id = fn.get("fn_id", "")
            if fn_id in seen:
                continue
            seen.add(fn_id)
            functions.append(fn)
    if merged is None:
        print("merge: no parts", file=sys.stderr)
        return 2
    merged["functions"] = functions
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(merged, fh)
    print(f"  merged {len(args.parts)} report(s), {len(functions)} function(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
