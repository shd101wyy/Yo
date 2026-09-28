# `io.await` placement rules (E0904) are enforced only in codegen: `yo check` and the LSP accept the program

**Severity:** S2 — `check` and the LSP report clean what codegen rejects with E0904 — the await-placement rule surfaces only in a ~3-minute compile

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit
(`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Seed v0.2.45 and
develop `af62bdb28` (tree-built compiler).

## Symptom

```
$ yo check issues/repros/await-placement-rules-only-enforced-in-codegen.yo
check: …await-placement-rules-only-enforced-in-codegen.yo — evaluator OK     (rc=0)

$ yo compile issues/repros/await-placement-rules-only-enforced-in-codegen.yo --skip-c-compiler
error[E0904]: `io.await` in a `cond` condition inside an `io.async` block must BE the
first condition — it cannot be nested inside a larger expression, and it cannot be in
a later branch.
  --> …:5:11
```

The repro is `if(!(e.await(_b(e), e)), { return(i32(1)); })` inside
`io.async`.

## Why it matters

- `yo check` is documented as the first gate (AGENTS.md: "run this FIRST"),
  and `yo lsp` is built on the evaluator. Neither reports this error, so an
  editor or agent loop sees a clean program that does not compile.
- AGENTS.md already works around it: "async state-machine rules are enforced
  in codegen, so gate those with `yo compile src/main.yo --skip-c-compiler`".
  That rule costs about 3 minutes per check of the compiler tree.
- `issues/questions/yoself-accepts-await-in-cond-that-ts-rejects.md` is a related
  earlier symptom of the same split (the rule's location decided which
  compiler rejected the program).

## Root cause

`_unsupported_await_message` and the placement predicates
(`await_is_in_non_splittable_position`, `await_is_in_first_cond_position`,
`expr_is_bare_await`) live in `src/codegen/async/state_code_gen.yo` and run
only when the state machine is emitted. The evaluator's await analysis
(`src/evaluator/async/await_analysis.yo`) has the same information but does
not diagnose.

## Fix direction

Short term: move the placement check into the evaluator's await analysis so
`check` and `lsp` report E0904 at the same span.

Long term: the restriction itself is an artefact of the lowering. With awaits
normalised to statement position, and `cond` chains lowered to nested
`if`/`else` so a later condition still runs only when earlier ones fail,
every one of these shapes can be compiled with unchanged semantics. That is
phase 1 of the plan, after which E0904 can be retired.

## Related: a misleading E0904 hint

A begin block used as a value with awaits inside,
`r := { a := await; b := await; (a*b) };`, is rejected with E0904
"Hoist it into a local first: `result := io.await(f, io)`", pointing at a
line that already IS `a := io.await(…)`
(`issues/repros/async-shape-d1-begin-block-value-with-awaits-misleading-e0904.yo`). The rejection
is fine for today's lowering; the hint names the wrong remedy. It should
say that a block used as a value cannot contain awaits yet, and to bind
the block's statements at the enclosing level.

## Note: the evaluator validator the codegen comment describes does not exist

The doc comment on `codegen_user_error` (`src/codegen/constants.yo`, added
in #917) says that the rules decidable from the syntax "are also enforced
by the evaluator (`validate_await_placement`, evaluator/async/await_placement.yo)".
No such function or file exists in any branch (`git log -S validate_await_placement`
finds only that comment). The fix for this issue should create the check
and make the comment true.
