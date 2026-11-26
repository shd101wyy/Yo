#!/usr/bin/env python3
"""VERDICTS-78 Q3 PR 1 sweep: `ToString` -> `Display`, `debug_string` impls -> `debug_fmt`.

Usage: python3 tmp/display-sweep/sweep.py <file-or-dir>...  (rewrites .yo files in place)

Rewrites, per .yo file:
  1. every trait-impl argument `ToString(to_string : V)` whose only entry is
     `to_string`, with V one of `(self -> E)` or `(fn(self : &Self) -> String)(E)`,
     to `Display(fmt : ((self, f) -> f.write(&E)))`;
  2. every `Debug(debug_string : V)` of the same two shapes to
     `Debug(debug_fmt : ((self, f) -> f.write(&E)))`;
  3. every remaining `ToString` word (imports, bounds, `Dyn(...)`, comments) to
     `Display`; `ComptimeToString` and longer identifiers are untouched.
Sites it cannot rewrite (an `append_to` entry, a body with `return(`, another
receiver shape, `derive(..., ToString)`) are listed on stderr for a hand edit.
"""
import os
import re
import sys

def scan_close(s, i):
    """s[i] == '('; return the index of its matching ')' (skips strings, templates, comments)."""
    depth = 0
    n = len(s)
    j = i
    while j < n:
        c = s[j]
        if c == '/' and s.startswith('//', j):
            k = s.find('\n', j)
            j = n if k < 0 else k
            continue
        if c == '"':
            j += 1
            while j < n and s[j] != '"':
                j += 2 if s[j] == '\\' else 1
            j += 1
            continue
        if c == '`':
            j = scan_template(s, j)
            continue
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0:
                return j
        j += 1
    raise ValueError('unbalanced at %d' % i)

def scan_template(s, j):
    """s[j] == '`'; return the index after the closing backtick."""
    n = len(s)
    j += 1
    while j < n:
        c = s[j]
        if c == '\\':
            j += 2
            continue
        if c == '`':
            return j + 1
        if c == '$' and j + 1 < n and s[j + 1] == '{':
            # find the matching '}' of the interpolation
            depth = 0
            k = j + 1
            while k < n:
                ch = s[k]
                if ch == '"':
                    k += 1
                    while k < n and s[k] != '"':
                        k += 2 if s[k] == '\\' else 1
                elif ch == '`':
                    k = scan_template(s, k) - 1
                elif ch in '([{':
                    depth += 1
                elif ch in ')]}':
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            j = k + 1
            continue
        j += 1
    return n

def split_top(s):
    """Split s at depth-0 commas."""
    parts, depth, start, j, n = [], 0, 0, 0, len(s)
    while j < n:
        c = s[j]
        if c == '/' and s.startswith('//', j):
            k = s.find('\n', j)
            j = n if k < 0 else k
            continue
        if c == '"':
            j += 1
            while j < n and s[j] != '"':
                j += 2 if s[j] == '\\' else 1
            j += 1
            continue
        if c == '`':
            j = scan_template(s, j)
            continue
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ',' and depth == 0:
            parts.append(s[start:j])
            start = j + 1
        j += 1
    parts.append(s[start:])
    return [p for p in parts if p.strip()]

def body_of(v):
    """The body E of `(self -> E)` or `(fn(self : &Self) -> String)(E)`, else None."""
    v = v.strip()
    if not v.startswith('('):
        return None
    c = scan_close(v, 0)
    inner = v[1:c]
    rest = v[c + 1:].strip()
    m = re.match(r'\s*self\s*->\s*', inner)
    if m and rest == '':
        return inner[m.end():].strip()
    if re.fullmatch(r'\s*fn\(\s*self\s*:\s*&Self\s*\)\s*->\s*String\s*', inner) and rest.startswith('('):
        c2 = scan_close(rest, 0)
        if rest[c2 + 1:].strip() == '':
            return rest[1:c2].strip()
    return None

def rewrite_impls(s, trait, method, new_trait, new_method, path, report):
    out, i = [], 0
    pat = re.compile(r'(?<![A-Za-z0-9_])' + trait + r'\(')
    while True:
        m = pat.search(s, i)
        if not m:
            out.append(s[i:])
            break
        open_i = m.end() - 1
        close_i = scan_close(s, open_i)
        args = s[open_i + 1:close_i]
        entries = split_top(args)
        line = s.count('\n', 0, m.start()) + 1
        ok = None
        if len(entries) == 1:
            em = re.match(r'\s*((?://[^\n]*\n\s*)*)' + method + r'\s*:\s*', entries[0], re.S)
            if em:
                body = body_of(entries[0][em.end():])
                if body is not None and 'return(' not in body:
                    lead = em.group(1)
                    # A comment that opens the body moves in front of the write.
                    bm = re.match(r'((?://[^\n]*\n\s*)+)', body)
                    note = ''
                    if bm:
                        note = '\n' + bm.group(1)
                        body = body[bm.end():]
                    ok = '%s(%s%s : ((self, f) -> %sf.write(&%s)))' % (new_trait, lead, new_method, note, body)
        if ok is None:
            if entries and any(re.match(r'\s*(?://[^\n]*\n\s*)*' + method + r'\b', e, re.S) for e in entries):
                report.append('%s:%d: %s(...) left for a hand edit' % (path, line, trait))
            out.append(s[i:close_i + 1])
        else:
            out.append(s[i:m.start()])
            out.append(ok)
        i = close_i + 1
    return ''.join(out)

def sweep_file(path, report):
    s = open(path, encoding='utf-8').read()
    orig = s
    s = rewrite_impls(s, 'ToString', 'to_string', 'Display', 'fmt', path, report)
    s = rewrite_impls(s, 'Debug', 'debug_string', 'Debug', 'debug_fmt', path, report)
    for m in re.finditer(r'derive\([^;]*?(?<![A-Za-z0-9_])ToString(?![A-Za-z0-9_])', s):
        report.append('%s:%d: derive(..., ToString) left for a hand edit' % (path, s.count('\n', 0, m.start()) + 1))
    s = re.sub(r'(?<![A-Za-z0-9_])ToString(?![A-Za-z0-9_])', 'Display', s)
    if s != orig:
        open(path, 'w', encoding='utf-8').write(s)
        return True
    return False

# Comments that record history (a removed name, an old error text) keep the
# old name: (path, text after the rename, text restored).
HISTORY = [
    ('src/parser.yo', '/// `Display` — the only rustc-shaped renderer in the tree', '/// `ToString` — the only rustc-shaped renderer in the tree'),
    ('src/parser.yo', 'value ("no C type name for Display")', 'value ("no C type name for ToString")'),
    ('tests/derive.test.yo', 'before it, `derive(Display)` emitted the', 'before it, `derive(ToString)` emitted the'),
]
HISTORY_RE = [(r'`derive\(Display\)` were kept in v0\.2\.28', '`derive(ToString)` were kept in v0.2.28')]

def restore_history(path):
    s = open(path, encoding='utf-8').read()
    o = s
    for p, a, b in HISTORY:
        if path.endswith(p):
            s = s.replace(a, b)
    for a, b in HISTORY_RE:
        s = re.sub(a, b, s)
    if s != o:
        open(path, 'w', encoding='utf-8').write(s)

def main():
    report, changed = [], []
    for root in sys.argv[1:]:
        paths = [root] if os.path.isfile(root) else [
            os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs if f.endswith('.yo')]
        for p in sorted(paths):
            if sweep_file(p, report):
                changed.append(p)
                restore_history(p)
    for r in report:
        print(r, file=sys.stderr)
    print('%d files changed, %d sites for a hand edit' % (len(changed), len(report)))

if __name__ == '__main__':
    main()
