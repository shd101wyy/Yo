#!/usr/bin/env python3
"""Print a readable window around the caret of each in-batch swallow record.

    python3 scratchpad/caret_window.py /tmp/harvest_tests_basic.test.yo.log [WIDTH]

The batch test arms are ONE enormous line, so the raw error is unreadable. Each
YoError record renders as
    <msg>\\n\\n<module>:<row>:<col>:\\n<source line>\\n<spaces>^
and the caret column pins the exact failing sub-expression. This slices the
source line around it.
"""
import re
import sys

MARK = "__DBG_F swallowed:"
LOC = re.compile(r"^(.*\.yo_selftest_batch_\d+\.yo):(\d+):(\d+):$")


def main():
    path = sys.argv[1]
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 260
    text = open(path, errors="replace").read()
    for rec in text.split(MARK)[1:]:
        lines = rec.splitlines()
        for i, ln in enumerate(lines):
            m = LOC.match(ln.strip())
            if not m or i + 2 >= len(lines):
                continue
            src, caret = lines[i + 1], lines[i + 2]
            if "^" not in caret:
                continue
            pos = caret.index("^")
            msg = "\n".join(x for x in lines[:i] if x.strip())
            print("=" * 78)
            print(msg.strip())
            print(f"-- {m.group(1)}:{m.group(2)}:{m.group(3)}  (caret char {pos})")
            lo, hi = max(0, pos - width), min(len(src), pos + width)
            print("..." + src[lo:pos] + "  <<<HERE>>>  " + src[pos:hi] + "...")
            break


if __name__ == "__main__":
    main()
