#!/usr/bin/env python3
"""Flatten same-operator && / || groups (the #1163 sweep, regenerated).

A paren group whose depth-0 binary operators are all one X in {&&, ||} loses
its parens when it is an operand of a chain whose depth-0 operators are all
that same X. Both operators are associative and regrouping keeps the
short-circuit order. Strings, backtick literals and comments are skipped.
Conservative: any other operator at depth 0 (inside the group or in the
enclosing chain) disqualifies the group.

usage: scripts/flatten-andor-chains.py FILE...   (rewrites in place, prints per-file counts)

Then run `yo fmt` on the changed files with the TREE stage-1 (not the seed), and
check the token guard: with every `(`, `)` and whitespace stripped, each file
equals its parent commit byte for byte.
"""
import re, sys

OPCH = set("+-*/%<>=!&|^~?:.#@$\\")
DELIM_OPEN = "([{"
DELIM_CLOSE = ")]}"


def tokenize(s):
    """Tokens: (kind, start, end). kinds: str, ws, com, id, num, op, open, close, sep"""
    toks = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in " \t\r\n":
            j = i
            while j < n and s[j] in " \t\r\n":
                j += 1
            toks.append(("ws", i, j)); i = j; continue
        if s.startswith("//", i):
            j = s.find("\n", i)
            j = n if j < 0 else j
            toks.append(("com", i, j)); i = j; continue
        if s.startswith("/*", i):
            j = s.find("*/", i + 2)
            j = n if j < 0 else j + 2
            toks.append(("com", i, j)); i = j; continue
        if c == '"':
            j = i + 1
            while j < n and s[j] != '"':
                j += 2 if s[j] == "\\" else 1
            toks.append(("str", i, j + 1)); i = j + 1; continue
        if c == "`":
            # backtick literal with ${...} interpolation (nested braces/backticks)
            j = i + 1
            depth = 0
            while j < n:
                if s[j] == "\\":
                    j += 2; continue
                if depth == 0 and s[j] == "`":
                    break
                if s.startswith("${", j):
                    depth += 1; j += 2; continue
                if depth > 0 and s[j] == "}":
                    depth -= 1
                j += 1
            toks.append(("str", i, j + 1)); i = j + 1; continue
        if c.isalnum() or c == "_":
            j = i
            while j < n and (s[j].isalnum() or s[j] == "_"):
                j += 1
            toks.append(("id", i, j)); i = j; continue
        if c in DELIM_OPEN:
            toks.append(("open", i, i + 1)); i += 1; continue
        if c in DELIM_CLOSE:
            toks.append(("close", i, i + 1)); i += 1; continue
        if c in ",;":
            toks.append(("sep", i, i + 1)); i += 1; continue
        if c in OPCH:
            j = i
            while j < n and s[j] in OPCH:
                j += 1
            toks.append(("op", i, j)); i = j; continue
        if c == "'":
            j = i + 1
            while j < n and s[j] != "'":
                j += 2 if s[j] == "\\" else 1
            toks.append(("str", i, j + 1)); i = j + 1; continue
        toks.append(("other", i, i + 1)); i += 1
    return toks


def flatten_once(s):
    toks = [t for t in tokenize(s)]
    sig = [k for k, t in enumerate(toks) if t[0] not in ("ws", "com")]
    text = lambda t: s[t[1]:t[2]]
    # match parens
    match = {}
    stack = []
    for k in sig:
        t = toks[k]
        if t[0] == "open":
            stack.append(k)
        elif t[0] == "close":
            if stack:
                match[stack.pop()] = k
    pos = {k: idx for idx, k in enumerate(sig)}

    def prev_sig(k):
        p = pos[k] - 1
        return toks[sig[p]] if p >= 0 else None

    def is_group(k):
        t = toks[k]
        if text(t) != "(":
            return False
        p = prev_sig(k)
        if p is None:
            return True
        # a call or a `)(`/`](` application is not a group
        if p[0] in ("id", "close", "str"):
            return False
        return True

    def depth0(lo, hi):
        """significant tokens strictly between sig positions lo..hi at depth 0"""
        out = []
        p = pos[lo] + 1
        end = pos[hi]
        while p < end:
            k = sig[p]
            out.append(k)
            if toks[k][0] == "open" and k in match:
                p = pos[match[k]] + 1
            else:
                p += 1
        return out

    def chain_op(ks):
        """the single && / || of a depth-0 token run, or None if mixed / other ops"""
        ops = set()
        for k in ks:
            t = toks[k]
            if t[0] == "op":
                o = text(t)
                if o in ("&&", "||"):
                    ops.add(o)
                elif o == ".":
                    continue
                else:
                    return None
            elif t[0] in ("sep", "other"):
                return None
        return ops.pop() if len(ops) == 1 else None

    removals = []
    for k in list(match.keys()):
        if not is_group(k):
            continue
        inner = depth0(k, match[k])
        x = chain_op(inner)
        if x is None:
            continue
        # enclosing context: the innermost enclosing open delimiter
        enc = None
        for o, c in match.items():
            if o < k and match[k] < c:
                if enc is None or o > enc:
                    enc = o
        if enc is None:
            continue
        ctx = depth0(enc, match[enc])
        # the group must sit in a run bounded by separators; split ctx on seps
        run, cur = None, []
        for kk in ctx + [None]:
            if kk is None or toks[kk][0] == "sep":
                if k in cur:
                    run = cur
                cur = []
            else:
                cur.append(kk)
        if run is None or chain_op(run) != x:
            continue
        # a direct operand: X or the enclosing open/sep before, X or the
        # enclosing close/sep after (never `.`/an application around it)
        p = prev_sig(k)
        nx = pos[match[k]] + 1
        nt = toks[sig[nx]] if nx < len(sig) else None
        ok_prev = p is not None and (p[0] in ("open", "sep") or (p[0] == "op" and text(p) == x))
        ok_next = nt is not None and (nt[0] in ("close", "sep") or (nt[0] == "op" and text(nt) == x))
        if not (ok_prev and ok_next):
            continue
        removals.append((k, match[k]))
    if not removals:
        return s, 0
    # remove only non-overlapping outermost-first groups this round (nested
    # candidates are re-evaluated next round)
    removals.sort()
    chosen = []
    last_end = -1
    for o, c in removals:
        if o > last_end:
            chosen.append((o, c)); last_end = c
        # a candidate nested in a chosen one waits for the next round
    cut = set()
    for o, c in chosen:
        cut.add(toks[o][1]); cut.add(toks[c][1])
    out = "".join(ch for i, ch in enumerate(s) if i not in cut)
    return out, len(chosen)


def main():
    total = 0
    for f in sys.argv[1:]:
        s = open(f).read()
        n = 0
        while True:
            s2, m = flatten_once(s)
            if m == 0:
                break
            s, n = s2, n + m
        if n:
            open(f, "w").write(s)
            print(f"{n}\t{f}")
            total += n
    print(f"total\t{total}")


if __name__ == "__main__":
    main()
