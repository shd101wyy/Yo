#!/usr/bin/env python3
"""split_arms.py — extract every `test("name", { ... });` block of a .test.yo
file into a standalone runnable .yo file (`main` + `export(main)`).

    python3 scratchpad/split_arms.py tests/comptime.test.yo /tmp/cta

The preamble (everything before the first top-level `test(`) is copied verbatim
into each output file, so imports/`open(...)` lines are preserved. Arm indices
are 0-based and match the `YO_TEST_INDEX` dispatch order in the batch main.
"""
import os
import re
import sys


def find_arms(src: str):
    """Yield (index, name, body_text) for each top-level test(...) call."""
    arms = []
    for m in re.finditer(r'^test\(', src, re.M):
        start = m.start()
        # Walk from the opening paren, tracking depth and string/char state.
        i = src.index('(', start)
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
        call = src[start:i + 1]
        arms.append(call)
    out = []
    for idx, call in enumerate(arms):
        nm = re.match(r'test\(\s*("(?:[^"\\]|\\.)*")\s*,', call)
        name = nm.group(1) if nm else f'"arm{idx}"'
        # Body = everything after the first comma at depth 1, minus the final ')'.
        after = call[nm.end():] if nm else call
        body = after.rstrip()
        if body.endswith(')'):
            body = body[:-1].rstrip()
        out.append((idx, name, body))
    return out


def main():
    src_path, out_dir = sys.argv[1], sys.argv[2]
    src = open(src_path).read()
    first = re.search(r'^test\(', src, re.M)
    preamble = src[:first.start()] if first else src
    os.makedirs(out_dir, exist_ok=True)
    arms = find_arms(src)
    for idx, name, body in arms:
        path = os.path.join(out_dir, f'arm_{idx:02d}.yo')
        with open(path, 'w') as f:
            f.write(preamble)
            f.write(f'// arm {idx}: {name}\n')
            f.write('main :: (fn() -> unit)(\n')
            f.write(body)
            f.write('\n);\nexport(main);\n')
        print(f'{idx:02d} {name} -> {path}')


if __name__ == '__main__':
    main()
