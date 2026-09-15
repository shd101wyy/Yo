#!/usr/bin/env python3
"""Check the Yo code samples embedded in `///` / `//!` doc comments.

REPORTS, never rewrites. Two signals:

  PARSE   a ```yo block that does not parse — a genuinely broken sample.
          Fails the check (exit 1).
  PARENS  a block whose TOKEN STREAM `yo fmt` would change — in practice
          redundant parentheses, e.g. `(n) => ...` or `assert((x == y), "..")`.
          Reported, does not fail: it is a nit, and the fix is a human edit.

PARSE uses `yo check` and looks ONLY at E00xx error codes. The codes are banded —
E0001-E0008 lexer/parser, E04xx name resolution, E06xx types — and a doc sample
is legitimately a FRAGMENT (no imports, elided bodies, `…`), so it will normally
raise E0401 "Variable not found". That is expected and ignored; only a
parse-class error means the sample is actually malformed.

`yo fmt` is NOT usable as the parse oracle, which is worth stating because it is
the obvious choice: measured 2026-09-15, `yo fmt` accepts
`this is not ) valid ( yo at all ][` and cheerfully reformats it. It is a
formatter, not a syntax gate.

Why not just run `yo fmt --write` over the samples: measured, fmt rewrites 69 of
133 std doc blocks but only 13 differ in TOKENS. The other 56 collapse
hand-aligned trailing-comment columns and expand compact one-liners into
multi-line — strictly worse documentation. The formatter's authority is over
source it owns; a doc sample is prose. So this tool compares the
whitespace-stripped token stream and ignores layout entirely.

Usage:
  scripts/check-doc-blocks.py [--yo PATH] [ROOT ...]     # default roots: std src
"""
import argparse, pathlib, re, subprocess, sys, tempfile

FENCE = re.compile(r'^(?:///|//!)\s?(.*)$')


def extract(root: pathlib.Path):
    """Yield (file, line_no, fence_lang, source) for each fenced doc block."""
    for f in sorted(root.rglob('*.yo')):
        inb = False
        buf: list[str] = []
        start = 0
        lang = ''
        for i, raw in enumerate(f.read_text(errors='replace').splitlines()):
            m = FENCE.match(raw.strip())
            if not m:
                if inb:           # doc comment ended mid-block: abandon it
                    inb, buf = False, []
                continue
            body = m.group(1)
            if body.strip().startswith('```'):
                if inb:
                    if buf:
                        yield f, start + 1, lang, "\n".join(buf) + "\n"
                    inb, buf = False, []
                else:
                    inb, start, lang = True, i, body.strip()[3:].strip()
                    buf = []
                continue
            if inb:
                buf.append(body)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--yo', default='yo', help='yo binary (default: yo on PATH)')
    ap.add_argument('roots', nargs='*', default=['std', 'src'])
    args = ap.parse_args()

    bad_parse, bad_parens, checked = [], [], 0
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td) / 'block.yo'
        for root in args.roots:
            for f, line, lang, src in extract(pathlib.Path(root)):
                if lang not in ('yo', 'rust'):   # only Yo samples
                    continue
                checked += 1
                tmp.write_text(src)
                # PARSE: `yo check`, failing only on E00xx (lexer/parser).
                # E04xx (name not found) is expected for a fragment.
                chk = subprocess.run([args.yo, 'check', str(tmp)],
                                     capture_output=True, text=True)
                blob = (chk.stdout or '') + (chk.stderr or '')
                parse_errs = sorted(set(re.findall(r'error\[(E000\d)\]', blob)))
                if parse_errs:
                    bad_parse.append((f, line, ",".join(parse_errs)))
                    continue
                if subprocess.run([args.yo, 'fmt', str(tmp)],
                                  capture_output=True).returncode != 0:
                    bad_parse.append((f, line, "fmt-rejected"))
                    continue
                # fmt twice: it is NOT idempotent for every shape, so the
                # FIXED POINT is what we compare against.
                subprocess.run([args.yo, 'fmt', str(tmp)], capture_output=True)
                after = tmp.read_text()
                if re.sub(r'\s+', '', src) != re.sub(r'\s+', '', after):
                    bad_parens.append((f, line))

    print(f"doc blocks checked: {checked}")
    for f, line in bad_parens:
        print(f"  PARENS {f}:{line}  formatter would change the token stream "
              f"(redundant parentheses?)")
    for f, line, code in bad_parse:
        print(f"  PARSE  {f}:{line}  does not parse ({code})")
    print(f"parens nits: {len(bad_parens)}   parse failures: {len(bad_parse)}")
    return 1 if bad_parse else 0


if __name__ == '__main__':
    sys.exit(main())
