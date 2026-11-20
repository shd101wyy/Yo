# `evaluate_match`'s scrutinee-temporary place leaks on every unwind out of the match

**Severity:** S3: a 10-byte `String` leaks once per thrown evaluation of a
`match` in the compiler's own run (3 allocations, 30 B, in a full
`check src/main.yo` self-check). It is one of the residual stacks of the
v0.2.79 G4 leak gate, and its count grows with the source the compiler
checks.

**Status:** OPEN. Found 2026-11-20 while closing
`issues/fixed/2026-11-19-a-move-in-a-later-cond-condition-leaks-when-an-earlier-arm-is-taken.md`.

## Evidence

The G4-style run (ASan stage-2 `check src/main.yo --std-path ./std`, the
`v0279/g4-leak-preR7` tree) reports four direct stacks, 414 B in 18
allocations. One of them is

```text
Direct leak of 30 byte(s) in 3 object(s) allocated from:
    #1 alloc             (String.from's byte buffer)
    #2 String.from(slice : str)
    #3 evaluate_match    (inlined origin_scrutinee_temporary_place)
```

The 10 bytes are `"#scrutinee"`, the `root_name` of the
`LocalBorrowPlace` that `origin_scrutinee_temporary_place`
(`src/evaluator/utils.yo`) builds for

```yo ignore
(scr_temp_place : Option(LocalBorrowPlace)) = if(
  (borrowed_match_scrutinee_kind(ast_expr_token(expr)) == u8(1)) && is_temporary_operand(&scrutinee_expr, &env, ctx),
  Option(LocalBorrowPlace).Some(origin_scrutinee_temporary_place(&scrutinee_expr)),
  Option(LocalBorrowPlace).None
);
```

(`src/evaluator/exprs/match.yo`, `evaluate_match`). At d8f0d89fa the same
stack was 20 B in 2 allocations. The count scales with the checked source:
it follows how many borrowed `match`es over a temporary are evaluated and
then thrown out of, so the G4 bar drifts with the tree until this is fixed.

In the emitted C, `scr_temp_place` is dropped exactly once, at the normal
end of `evaluate_match`. It is absent from every "Drop local variables
before early return" list (the `exn.throw` unwind paths) after its
definition. `imm_place` and `mut_place` have the same type and are declared
the same `(x : T) = …` way two lines earlier; they are in those lists, and
so is every local declared after `scr_temp_place`. A trial evaluation that
throws (and is swallowed) after line 1328 therefore leaks the place.

## Not reproduced outside the compiler

Three user programs each bind an `Option(String)` and then `exn.throw` to a
handler that `unwind`s: a typed binding from an `if` with a `&&`
condition, a `:=` binding, and a typed binding from a plain value. All three
drop the value on the unwind (no LeakSanitizer report). So the omission
depends on something more specific to this binding (its initializer's
call taking `&scrutinee_expr`, the `LocalBorrowPlace` type's
classification, or how the later `match(&scr_temp_place, …)` borrows are
judged). The next step is a debug print of the unwind drop list's
candidate filter for `scr_temp_place` in a stage-1 `compile src/main.yo`.

## Fix shape

Find why the evaluator does not list `scr_temp_place` among the owned locals
of the unwind paths, and fix it there (a codegen/evaluator ownership bug).
A source workaround in `evaluate_match` would hide the class. The
regression guard is the G4 gate's residual list: this stack disappears.
