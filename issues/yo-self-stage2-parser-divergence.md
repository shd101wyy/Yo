# yo-self stage-2 binary: parser mis-resumes after `:=` inside call args (blocks fixpoint)

## Status

OPEN — bisected to a minimal repro (2026-07-10). This is the current
fixpoint blocker: the stage-2 binary now parses argv and runs its
lexer/parser (parse-0 long surpassed), but `check` rejects the real
std/prelude.yo at line 20 with "paren-less function and operator calls are
not supported".

## Minimal repro (sandbox recipe — no rebuild needed per probe)

The stage-2 binary resolves `./std/prelude.yo` relative to CWD, so a
sandbox gives full control over what its parser sees:

```bash
# one-time: build the stage-2 binary
./yo-cli compile yo-self/main.yo -o /tmp/s1
YO_MAIN_STACK_MB=16384 /tmp/s1 compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -w -O0 /tmp/stage2.c -o /tmp/s2

mkdir -p /tmp/s2box/std && cd /tmp/s2box
printf 'x :: i32(1);\nexport(x);\n' > t.yo
python3 -c "open('std/prelude.yo','w').write('// x\n'*6 + 'T :: foo(id := \"X\");\nexport(T);\n')"
YO_MAIN_STACK_MB=16384 /tmp/s2 check t.yo
# → paren-less function and operator calls are not supported  --> :8:0
```

## Trigger conditions (all three required)

1. **≥ 6 comment lines** before the construct (exactly 6 is the threshold;
   5 is clean; `//`, `//!`, `///` all count; multibyte content is
   IRRELEVANT — pure-ASCII `// x` lines trigger).
2. **A `:=` inside call parentheses**: `T :: foo(id := "X");`
   (trait(id := ...) and struct(...) forms trigger; `foo(id : i32(1))`
   labeled args do NOT; `i32(1)` plain args do NOT; empty `trait()` does
   NOT).
3. **A following parenthesized statement** (`export(T);`) — the error
   fires AT that statement's line: the parser resumed at a wrong token
   index after the `:=` construct, so the following `(` is no longer seen
   as `LParen` after `export`.

Also observed: the error message prints an EMPTY module path
(` --> :20:0`) — possibly a separate small string bug in
make_parse_error's path plumbing under stage-2.

## Analysis so far

- Pure code tokens past any count are fine (3× `a :: i32(1);` = 21 tokens,
  clean) — NOT a token-list realloc issue.
- 6 comments + plain binding + export: clean. The `:=`-inside-parens parse
  path is what returns a comment-count-dependent resume index.
- Suspect code (yo-self/parser.yo, the infix-operator branch around the
  strict-op check, ~line 1230-1315): `rhs_end` from `parse_expression`,
  `is_parenthesized_expr(rhs_start, rhs_end - usize(1))`, `skip_ws_fwd`,
  or the `:=` right-assoc handling — one of these is MISCOMPILED by
  stage-1 (the same source parses correctly when compiled by TS; this is
  a stage-2-only behavior, i.e. a current yo-self CODEGEN bug on one of
  these functions' shapes).
- Direct C diffing of the whole containing function is too noisy (650 vs
  1014 normalized lines — different temp materialization styles). Next
  step: extract the SMALL helpers (`is_parenthesized_expr`, `skip_ws_fwd`,
  `parse_left_assoc_op`, token.yo's `find_matching_bracket`) individually
  from /tmp/stage2.c vs a TS-emitted reference and diff those; or bisect
  the resume-index behavior by inserting sentinel statements between the
  `:=` construct and the export line and watching the error line move.

## Sibling symptom (same investigation)

`s2 fmt --check <any file>` crashes: SIGSEGV (rc 139) on a trivial file,
`"HashSet ctrl pointer is null"` (rc 134) on others — fmt is NOT usable as
the parse probe; use the check+sandbox recipe above.

## Context

All four stage-2 CLANG error families and the argv-string corruption are
FIXED (issues/fixed/yo-self-stage2-clang-errors.md, commits f9263e9b4,
2043abd5d, 51b33524b, c10706588, f3aae4d30). Corpus 112 files, 111/111+
argv DIFF 0; stage-2 emit 0 errors deterministic. This parser divergence
(and the fmt crash) are what remain between here and the fixpoint
(stage-2 ≡ stage-3), then tasks #69/#70.
