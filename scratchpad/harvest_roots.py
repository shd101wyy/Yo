#!/usr/bin/env python3
"""Pin each hollow file's ACTUAL hollowing error from an un-silenced-swallow run.

    BIN=/tmp/sh141 python3 scratchpad/harvest_roots.py [test.yo ...]

The probe binary prints `__DBG_F swallowed: <YoError.to_string()>` at every
`_trial_eval_fn_body` swallow (yo-self/evaluator/calls/function_type.yo). A
YoError renders as `Error: <msg>\\n\\n<module_path>:<row>:<col>\\n<line>\\n<caret>`,
so each record carries the SOURCE LOCATION of the throw.

Taking `| tail -1` is WRONG (lesson recorded 2026-08-01: it attributed a stale
root to imm_map). The hollowing error is the one thrown while evaluating the
BATCH MAIN, i.e. the record whose module_path is `.yo_selftest_batch_*.yo`.
This script splits the log into records and reports only those, last one first.
"""
import os
import re
import subprocess
import sys

ROOT = "/Users/yiyiwang/Workspace/Yo"
BIN = os.environ.get("BIN", "/tmp/sh141")
TIMEOUT = int(os.environ.get("TIMEOUT_S", "900"))
DEFAULT = [
    "tests/async_await.test.yo",
    "tests/basic.test.yo",
    "tests/fn.test.yo",
    "tests/higher_kinded_types.test.yo",
    "tests/imm_map.test.yo",
    "tests/iter_filter_closure.test.yo",
    "tests/iterator_combinators.test.yo",
    "tests/prelude.test.yo",
    "tests/where_clause_fn_inference.test.yo",
]
MARK = "__DBG_F swallowed:"


def records(text):
    """Split the log into (index, body) swallow records."""
    parts = text.split(MARK)
    return [(i, p) for i, p in enumerate(parts[1:], 1)]


def batch_records(text):
    return [(i, p) for i, p in records(text) if ".yo_selftest_batch_" in p]


def summarize(body, keep=14):
    lines = [ln for ln in body.splitlines() if ln.strip()]
    return "\n".join("    " + ln for ln in lines[:keep])


def main():
    targets = sys.argv[1:] or DEFAULT
    os.chdir(ROOT)
    for t in targets:
        tag = t.replace("/", "_")
        log = f"/tmp/harvest_{tag}.log"
        d = os.path.dirname(t)
        subprocess.run(f"rm -f {d}/.yo_selftest_batch_*", shell=True)
        with open(log, "w") as fh:
            rc = subprocess.run(
                ["timeout", str(TIMEOUT), BIN, "test", t, "--parallel", "1"],
                stdout=fh, stderr=subprocess.STDOUT,
                env={**os.environ, "YO_KEEP_BATCH": "1"},
            ).returncode
        text = open(log, errors="replace").read()
        allr = records(text)
        batch = batch_records(text)
        print(f"\n{'='*78}\n### {t}  rc={rc}  swallows={len(allr)}  in-batch={len(batch)}")
        print(f"    log: {log}")
        if not batch:
            print("    NO in-batch swallow — the hollowing error is NOT from "
                  "_trial_eval_fn_body; look elsewhere (last 3 swallows shown):")
            for i, b in allr[-3:]:
                print(f"  -- swallow #{i}")
                print(summarize(b, 8))
            continue
        for i, b in batch[-2:]:
            print(f"  -- in-batch swallow #{i} of {len(allr)}")
            print(summarize(b))


if __name__ == "__main__":
    main()
