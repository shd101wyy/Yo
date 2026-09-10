#!/usr/bin/env python3
"""subset_arms.py — rebuild a .test.yo file keeping only the given arm indices.

    python3 scratchpad/subset_arms.py tests/comptime.test.yo 0,3,7 /tmp/sub.test.yo

Used to bisect which `test(...)` arm makes a batch `__yo_user_main` hollow: the
arms are all inlined into ONE generated dispatch expression, so an arm can only
be blamed by rebuilding subsets of the real file.
"""
import re
import sys
import os
from pathlib import Path

_ALLOWED_WRITE_ROOTS = (os.path.abspath("."), os.path.abspath("/tmp"))


def _no_traversal(p):
    """Dev-tool write guard: normalize the path, refuse any `..` component,
    and confine the result to an allowed root (repo cwd or /tmp), so a
    mistyped argument cannot write outside the intended tree."""
    if ".." in p.replace("\\", "/").split("/"):
        sys.exit("refusing path with '..' component: %s" % p)
    abs_p = os.path.abspath(os.path.normpath(p))
    if not any(abs_p == r or abs_p.startswith(r + os.sep) for r in _ALLOWED_WRITE_ROOTS):
        sys.exit("refusing path outside allowed roots (cwd, /tmp): %s" % p)
    return abs_p


def arm_spans(src: str):
    spans = []
    for m in re.finditer(r'^test\(', src, re.M):
        i = src.index('(', m.start())
        depth = 0
        in_str = None
        while i < len(src):
            ch = src[i]
            if in_str:
                if ch == '\\':
                    i += 2
                    continue
                if ch == in_str:
                    in_str = None
            elif ch in '"`':
                in_str = ch
            elif ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    break
            i += 1
        end = i + 1
        if src[end:end + 1] == ';':
            end += 1
        spans.append((m.start(), end))
    return spans


def main():
    src_path, idx_spec, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    src = open(src_path).read()
    spans = arm_spans(src)
    keep = [int(x) for x in idx_spec.split(',') if x != '']
    preamble = src[:spans[0][0]] if spans else src
    parts = [preamble]
    for i in keep:
        s, e = spans[i]
        parts.append(src[s:e])
        parts.append('\n\n')
    Path(_no_traversal(out_path)).write_text(''.join(parts))
    print(f'{out_path}: {len(keep)} arms {keep}')


if __name__ == '__main__':
    main()
