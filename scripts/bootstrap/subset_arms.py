#!/usr/bin/env python3
"""subset_arms.py — rebuild a .test.yo file keeping only the given arm indices.

    python3 scratchpad/subset_arms.py tests/comptime.test.yo 0,3,7 /tmp/sub.test.yo

Used to bisect which `test(...)` arm makes a batch `__yo_user_main` hollow: the
arms are all inlined into ONE generated dispatch expression, so an arm can only
be blamed by rebuilding subsets of the real file.
"""
import re
import sys


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
    with open(out_path, 'w') as f:
        f.write(preamble)
        for i in keep:
            s, e = spans[i]
            f.write(src[s:e])
            f.write('\n\n')
    print(f'{out_path}: {len(keep)} arms {keep}')


if __name__ == '__main__':
    main()
