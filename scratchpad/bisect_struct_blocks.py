#!/usr/bin/env python3
"""Rebuild a single-test `.test.yo` keeping only chosen `  { … };` sub-blocks.

    python3 scratchpad/subset_arms.py tests/basic.test.yo 12 /tmp/bt2/s.test.yo
    python3 scratchpad/bisect_struct_blocks.py /tmp/bt2/s.test.yo 0,12 /tmp/bt2/b.test.yo

Blocks are delimited by lines that are exactly `  {` and `  };` (2-space indent),
which is how the `test(...)` bodies in tests/basic.test.yo are written. Used to
blame a sub-block for a batch-only failure: the whole test body becomes ONE
generated expression, so a block can only be blamed by rebuilding the file.
"""
import sys


def main():
    src, spec, out = sys.argv[1], sys.argv[2], sys.argv[3]
    keep = [int(x) for x in spec.split(',') if x != '']
    lines = open(src).read().split('\n')
    spans = []
    start = None
    for i, l in enumerate(lines):
        if l == '  {':
            start = i
        elif l == '  };' and start is not None:
            spans.append((start, i))
            start = None
    head_end = spans[0][0]
    tail_start = spans[-1][1] + 1
    body = []
    for k in keep:
        s, e = spans[k]
        body.extend(lines[s:e + 1])
    with open(out, 'w') as f:
        f.write('\n'.join(lines[:head_end]) + '\n')
        f.write('\n'.join(body) + '\n')
        f.write('\n'.join(lines[tail_start:]))
    print(f'{out}: {len(keep)} of {len(spans)} blocks {keep}')


if __name__ == '__main__':
    main()
