# `yo fmt` reformats (and reports success on) files the parser rejects

**Severity:** S3 — `yo fmt` rewrites parser-invalid files and reports success — `fmt --check` stays green on an uncompilable tree

**Fixed 2026-10-03 (open 2026-08-29; see `## Fixed`).** Found while fixing
`issues/fixed/yo-test-failing-child-windows-unknown-io-error.md`: a comment
edit inside `src/codegen/async/runtime_io_windows.yo`'s embedded-C template
string used backticks, which closed the template string mid-line; `yo fmt`
then "Formatted 1 Yo file(s)" (rc=0) and even inserted spaces around the
resulting token sandwich — while `yo check`/compile rejected the same file
with `paren-less function and operator calls are not supported`.

## Minimal reproducer

```bash
printf 'x := `abc`yo test`def`;\nmain :: (fn() -> unit)({\n  println(x);\n});\nexport(main);\n' > probe.yo
yo fmt probe.yo     # → "Formatted 1 Yo file(s).", rc=0, file REWRITTEN as: x := `abc` yo test `def`;
yo check probe.yo   # → error: paren-less function and operator calls are not supported
```

Lex-level breakage IS caught (`yo fmt` fails on an unterminated template
string), so the formatter runs the lexer but not the parser gate.

## Why it matters

A formatting pass that "succeeds" on an unparseable file launders the break
into an idempotent-looking state: `yo fmt --check` then also passes, so the
"format everything you touched" habit reports green on a tree that cannot
compile. The space insertion additionally mutates the file, so the offending
line drifts from what was authored.

## Suggested direction

`yo fmt` should refuse to rewrite (and exit nonzero) when the parse fails,
the way it already does for lexer errors — or at minimum warn. The formatter
is presumably token-based for robustness; a parse gate before writing the
result would close the gap without changing the formatting engine.

## Fixed

**2026-10-03, branch `s3/batch-3-fixes`.** Root cause: `format_yo_source`
(`src/formatter.yo`) renders the token stream and never ran the parser — the
lexer gate threw, but `_formatted_parses_identically` deliberately swallowed
parse failures as `false` (degrading to a conservative reformat), so
`format_yo_files` wrote back whatever the renderer produced for source the
parser rejects. Fix: `_fmt_parse_gate` at every exit of `format_yo_source` —
when the formatted text differs from the input, the original must parse; a
failure throws through the caller's `exn`, so `yo fmt` (and `--check`) print
the bare diagnostic and exit 1 with the file untouched (the same shape a
lexer error already had), and the LSP's `_format_document` unwinds Null and
keeps the buffer — making its documented contract true. Already-canonical
source is deliberately NOT parsed: `yo check` owns the parseability verdict,
and a deliberately-unparseable but canonical fixture
(`tests/cli-cases/fix-says-what-it-cannot-repair`, E0003) stays fmt-clean,
so CI's tree-wide `fmt --check ./std ./tests ./src` is unchanged on a
canonical tree (verified rc=0 after the fix). The stale TS-era corpus pair
`tests/internal/formatter_fixtures/93_prefix_chain_tight_but_infix_space_kept`
(its bare binary `:=` RHS predates the E0003 rule) was repaired to the
parenthesized spelling. Test: `tests/internal/formatter.test.yo` — "refuses
a changed rendering of source the parser rejects" failed before the fix and
passes after; "parse-invalid but already-canonical source passes through"
pins the boundary. Docs: DESIGN.md's formatting section (en-US + zh-CN);
testing.instructions.md's cli-case-fixture section gained the parse-error
rule.
