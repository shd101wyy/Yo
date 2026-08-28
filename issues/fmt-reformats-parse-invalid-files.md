# `yo fmt` reformats (and reports success on) files the parser rejects

**Open (2026-08-29).** Found while fixing
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
