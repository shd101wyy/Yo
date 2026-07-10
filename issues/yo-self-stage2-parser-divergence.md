# yo-self stage-2 binary: parser mis-resumes after `:=` inside call args (blocks fixpoint)

## Status

RESOLVED (2026-07-10, same day) — the "parser divergence" was not a parser
bug at all: it was a use-after-free of TOKEN STRING VALUES. Emitted
`ArrayList(T).get()` for ref-struct T returned `Some(*(_ptr+index))` with
NO `__yo_incr_rc`, while every caller's match-arm cleanup still emitted the
decr — each `get()` was a net −1 on the element, so the parser's token
`.value` buffers were freed one read at a time (the ≥6-comment threshold
was just when allocator reuse made the corruption visible; `[TOK]`-dump
tracing showed all values perfect at tokenize time and dead at parse time).

Four faithful ports fixed the chain (all in one commit; corpus test
tests/codegen-bootstrap/arraylist_refstruct_get.yo):

1. evaluator/exprs/property_access.yo — a runtime deref of an
   UnknownVal-carrying pointer now falls through to the RUNTIME branch
   (attaching the borrowed temp, TS property-access.ts:381-398); the
   Unknown early-return is gated on ctx.is_in_function_call_checking_phase.
2. codegen/exprs/drop_dup.yo — emit_deferred_dup_or_code's materialize
   path declares via get_variable_type_string (the declared_c_var_names
   choke-point), so the undeclared-temp gate no longer suppresses the very
   dup the materialization enables.
3. expr.yo wrap_body_in_begin + both def-time trial helpers — a bare-ATOM
   function body (`to_string : (...)(self)`) is wrapped in a synthetic
   `begin(...)` before dispatch, so the begin-tail ownership pass emits the
   borrowed-param \_\_\_dup (TS routes ALL bodies through
   evaluateBeginExpression). Narrowed to atoms: wrapping closure CALL
   bodies perturbed the async result-refine pipeline.
4. evaluator/calls/function_type.yo — \_build_def_time_body_env binds
   runtime params VALUELESS (TS function-type.ts:346); Some(UnknownVal)
   made set_expr_as_needs_to_call_dup's value-branch early-return.
   - calls/function.yo — the io.async/io.await result-type refinement is
     also applied on the VALUELESS-callee path (TS keys on
     functionType.ioBuiltin, value-independent), since a def-time `io.async`
     field read now has no FuncVal.

NEXT FRONTIER (new issue): the stage-2 binary now parses the sandbox
prelude fully but SIGSEGVs during EVALUATION — a swallowed throw
("Variable foo not found") lets a NULL AstExpr (`rhs_evaled`) reach
ast_expr_is_fn_call in the assignment control-flow validator: the
\_\_yo_effect_escaped propagation is lost between the throw and the check.
Real std/prelude.yo shows "parsed 0 top-level exprs" (throw-skeleton).

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

## Additional probe data (sentinel statements)

- The error fires on the FIRST statement after the `:=` construct,
  whatever it is (`a :: i32(1);` sentinel → error on ITS line, export
  untouched). Interleaved comments don't absorb it. The threshold scales:
  20 leading comments → error still on the first post-`:=` statement.
- The >=6 comments must be BEFORE the `:=` construct (6 after: clean;
  3 before + 3 after: clean) — the failing computation involves the
  construct's ABSOLUTE token index (leading comments shift it past a
  boundary; a fixed-size lookback / hardcoded window in the `:=` parse
  path is the prime suspect).

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
