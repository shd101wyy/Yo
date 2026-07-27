#!/usr/bin/env python3
"""Rewrite `X == String.from(Y)` -> `X == Y` (and `!=`) across yo-self.

`String.from` heap-allocates a String purely to compare against a `str`; std
has a direct `String == str` impl with identical semantics (same
length-then-memcmp, same empty-string case) and no allocation, and TS compares
directly. Two such sites were already worth -61% on `check ./std`.

Uses a real scanner rather than a regex: argument text can contain parentheses
inside string literals (e.g. `String.from("(void)0")`), and Yo has both "..."
and `...` string forms.

Usage: rewrite_string_from_cmp.py <file>...   (prints per-file counts)
"""
import sys

NEEDLE = "String.from("


def find_arg_end(s: str, open_idx: int) -> int:
    """Index of the ')' matching the '(' at open_idx, skipping string literals."""
    depth = 0
    i = open_idx
    n = len(s)
    while i < n:
        c = s[i]
        if c in '"`':
            quote = c
            i += 1
            while i < n:
                if s[i] == "\\":
                    i += 2
                    continue
                if s[i] == quote:
                    break
                i += 1
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def rewrite(text: str) -> tuple[str, int]:
    out = []
    i = 0
    count = 0
    while True:
        j = text.find(NEEDLE, i)
        if j < 0:
            out.append(text[i:])
            break
        # Only rewrite when this call is the RHS of `==` / `!=`.
        before = text[:j].rstrip()
        if not (before.endswith("==") or before.endswith("!=")):
            out.append(text[i : j + len(NEEDLE)])
            i = j + len(NEEDLE)
            continue
        open_idx = j + len(NEEDLE) - 1
        close_idx = find_arg_end(text, open_idx)
        if close_idx < 0:
            out.append(text[i : j + len(NEEDLE)])
            i = j + len(NEEDLE)
            continue
        arg = text[open_idx + 1 : close_idx]
        out.append(text[i:j])
        out.append(arg)
        i = close_idx + 1
        count += 1
    return "".join(out), count


total = 0
for path in sys.argv[1:]:
    src = open(path).read()
    new, n = rewrite(src)
    if n:
        open(path, "w").write(new)
        total += n
        print(f"{n:3d}  {path}")
print(f"total rewritten: {total}")
