#!/usr/bin/env python3
"""Rewrite the `&`-prefixed pointer operators to traits/methods.

plans/POINTER_OPERATORS_TO_TRAITS_AND_METHODS.md:
  X &== Y  ->  X == Y          (Eq impl on *(T))
  X &!= Y  ->  X != Y
  X &<  Y  ->  X <  Y          (Ord impl)
  X &<= Y  ->  X <= Y
  X &>  Y  ->  X >  Y
  X &>= Y  ->  X >= Y
  X &+  Y  ->  X.add(Y)        (unsafe method)
  X &-  Y  ->  X.sub(Y)        (hand-audit: run with --list first)
  X &/  Y  ->  X.offset_from(Y)

Scanner-based (not regex): skips "..."/`...` string literals and //, /* */
comments; for the method rewrites it captures the LHS operand (a balanced
primary chain: identifier/call/paren group with trailing .field/.* chains)
and the RHS operand (up to the next lower-precedence boundary at depth 0).

Usage:
  rewrite_ptr_ops.py <file>...          rewrite in place, print counts
  rewrite_ptr_ops.py --list <file>...   only print matches (audit mode)
  rewrite_ptr_ops.py --test             run unit tests
"""

import sys

# (operator, kind, replacement) — longest-first so &<= wins over &<.
OPS = [
    ("&==", "infix", "=="),
    ("&!=", "infix", "!="),
    ("&<=", "infix", "<="),
    ("&>=", "infix", ">="),
    ("&<", "infix", "<"),
    ("&>", "infix", ">"),
    ("&+", "method", "add"),
    ("&-", "method", "sub"),
    ("&/", "method", "offset_from"),
]


def skip_noncode(s, i):
    """If s[i] starts a string/comment, return the index just past it, else i."""
    n = len(s)
    c = s[i]
    if c in '"`':
        q = c
        i += 1
        while i < n:
            if s[i] == "\\" and q == '"':
                i += 2
                continue
            if s[i] == q:
                return i + 1
            i += 1
        return n
    if s.startswith("//", i):
        j = s.find("\n", i)
        return n if j < 0 else j
    if s.startswith("/*", i):
        j = s.find("*/", i)
        return n if j < 0 else j + 2
    return i


def lhs_start(s, op_idx):
    """Index where the LHS operand of the operator at op_idx begins.

    Walks left over: trailing whitespace, then a primary chain — balanced
    ()/[] groups, identifiers, and `.`-joined pieces (incl. `.*`).
    """
    i = op_idx
    while i > 0 and s[i - 1] in " \t":
        i -= 1
    end = i
    while i > 0:
        c = s[i - 1]
        if c in ")]":
            depth = 0
            j = i - 1
            while j >= 0:
                if s[j] in ")]":
                    depth += 1
                elif s[j] in "([":
                    depth -= 1
                    if depth == 0:
                        break
                j -= 1
            i = j
            continue
        if c.isalnum() or c == "_":
            while i > 0 and (s[i - 1].isalnum() or s[i - 1] == "_"):
                i -= 1
            continue
        if c == "*" and i >= 2 and s[i - 2] == ".":
            i -= 2
            continue
        if c == ".":
            i -= 1
            continue
        break
    # strip leading whitespace we may have consumed via '.' handling
    while i < end and s[i] in " \t":
        i += 1
    return i


def rhs_end(s, start):
    """Index just past the RHS operand starting at `start` (skipping ws)."""
    n = len(s)
    i = start
    while i < n and s[i] in " \t":
        i += 1
    rhs_begin = i
    depth = 0
    while i < n:
        c = s[i]
        j = skip_noncode(s, i)
        if j != i:
            i = j
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0:
            if c in ",;\n":
                break
            # binary operator at depth 0 ends the operand (except leading
            # unary minus and the tight `.`/`.*` chain)
            if c in "+*/%<>=!&|" and i > rhs_begin:
                # `.*` deref and `.` chains are part of the operand
                if c == "*" and s[i - 1] == ".":
                    i += 1
                    continue
                break
        i += 1
    # trim trailing ws
    while i > rhs_begin and s[i - 1] in " \t":
        i -= 1
    return rhs_begin, i


def rewrite(text):
    counts = {}
    i = 0
    out = text
    # repeatedly scan; indices shift after each replacement
    while True:
        n = len(out)
        best = None
        i = 0
        while i < n:
            j = skip_noncode(out, i)
            if j != i:
                i = j
                continue
            if out[i] == "&":
                # not && ; find matching op
                for op, kind, repl in OPS:
                    if out.startswith(op, i) and not out.startswith("&&", i):
                        # exclude `&&` prefix collision for &< etc: char before
                        if i > 0 and out[i - 1] == "&":
                            break
                        best = (i, op, kind, repl)
                        break
                if best:
                    break
            i += 1
        if not best:
            break
        idx, op, kind, repl = best
        counts[op] = counts.get(op, 0) + 1
        if kind == "infix":
            out = out[:idx] + repl + out[idx + len(op):]
        else:
            ls = lhs_start(out, idx)
            rb, re_ = rhs_end(out, idx + len(op))
            lhs = out[ls:idx].rstrip()
            rhs = out[rb:re_]
            out = out[:ls] + f"{lhs}.{repl}({rhs})" + out[re_:]
    return out, counts


def list_matches(text, path):
    found = []
    i = 0
    n = len(text)
    while i < n:
        j = skip_noncode(text, i)
        if j != i:
            i = j
            continue
        if text[i] == "&" and not text.startswith("&&", i) and (i == 0 or text[i - 1] != "&"):
            for op, _, _ in OPS:
                if text.startswith(op, i):
                    line_no = text[:i].count("\n") + 1
                    line = text.split("\n")[line_no - 1].strip()
                    found.append((path, line_no, op, line))
                    break
        i += 1
    return found


TESTS = [
    ("x := p &+ usize(1);", "x := p.add(usize(1));"),
    ("(ptr &+ 1).*", "(ptr.add(1)).*"),
    ("p &+ (n * k)", "p.add((n * k))"),
    ("buf(0) &+ off &+ i", "buf(0).add(off).add(i)"),
    ("a &== b", "a == b"),
    ("a &<= b", "a <= b"),
    ("q &/ p", "q.offset_from(p)"),
    ('s := "keep &+ inside";', 's := "keep &+ inside";'),
    ("// p &+ 1 comment", "// p &+ 1 comment"),
    ("x && y", "x && y"),
    ("self._ptr.unwrap() &+ self._len", "self._ptr.unwrap().add(self._len)"),
    ("memcpy(dst &+ i, src &+ j, n)", "memcpy(dst.add(i), src.add(j), n)"),
    ("p &- usize(2)", "p.sub(usize(2))"),
    ("(base &+ (i * stride)).* = v;", "(base.add((i * stride))).* = v;"),
]


def run_tests():
    ok = True
    for src, want in TESTS:
        got, _ = rewrite(src)
        if got != want:
            ok = False
            print(f"FAIL: {src!r}\n  want {want!r}\n  got  {got!r}")
    print("tests OK" if ok else "TESTS FAILED")
    return ok


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--test":
        sys.exit(0 if run_tests() else 1)
    audit = False
    if args and args[0] == "--list":
        audit = True
        args = args[1:]
    total = {}
    for path in args:
        src = open(path).read()
        if audit:
            for p, ln, op, line in list_matches(src, path):
                print(f"{p}:{ln}: {op}  {line[:90]}")
            continue
        new, counts = rewrite(src)
        if counts:
            open(path, "w").write(new)
            for k, v in counts.items():
                total[k] = total.get(k, 0) + v
            print(f"{sum(counts.values()):4d}  {path}")
    if not audit:
        print("total:", dict(sorted(total.items())))
