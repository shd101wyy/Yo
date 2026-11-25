# `evaluate_match`'s scrutinee-temporary place leaks on every unwind out of the match

**Severity:** S3: a 10-byte `String` leaks once per thrown evaluation of a
`match` in the compiler's own run (3 allocations, 30 B, in a full
`check src/main.yo` self-check). It is one of the residual stacks of the
v0.2.79 G4 leak gate, and its count grows with the source the compiler
checks.

**Status:** FIXED 2026-11-23 on `fix/evaluate-match-scrutinee-temporary-place-unwind`.
Found 2026-11-20 while closing
`issues/fixed/2026-11-19-a-move-in-a-later-cond-condition-leaks-when-an-earlier-arm-is-taken.md`.
The cause is not specific to `evaluate_match`: any local whose NAME contains
`_temp_` was never dropped on an unwind (see "Root cause").

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

## Reproduction outside the compiler

The three user programs this document first tried did not leak because their
bindings had ordinary names. The trigger is the binding's name: a local
spelled with `_temp_` in it leaks on every unwind through its frame, whatever
its type or initializer. `tmp/fixme4.yo` below leaks under the v0.2.79 seed and
under a develop-built tree binary (`e1ece945d`); renamed to `place`, it does not:

```yo
{ String } :: import("std/string");
{ Exception } :: import("std/error");
Place :: struct(root_name : String, text : String);
boom :: (fn(exn : Exception) -> i32)(exn.throw(dyn(Box.new(`boom`))));
work :: (fn(s : &String, exn : Exception) -> i32)({
  (scr_temp_place : Option(Place)) = Option(Place).Some(Place(root_name : String.from("#scrutinee"), text : s.clone()));
  r := match(&scr_temp_place, .Some(tp) => i32(tp.text.len()), .None => i32(0));
  boom(exn) + r
});
main :: (fn() -> unit)({
  s := String.from("abc");
  exn := Exception(throw : (err -> unwind(())));
  _ := work(&s, exn);
});
export(main);
```

```text
$ yo compile tmp/fixme4.yo --optimize 2 --sanitize address --allocator system -o tmp/fixme4 && ./tmp/fixme4
==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 10 byte(s) in 1 object(s) allocated from: ...
Direct leak of 3 byte(s) in 1 object(s) allocated from: ...
```

## Root cause

`_keep_pending_drop` (`src/codegen/exprs/return.yo`) filters the drops an
early exit emits. Its C-emission-order guard skips a minted codegen temporary
whose C declaration has not been emitted yet, and it recognized a minted
temporary by `guard_cn.contains("_temp_")`. `__yo_v_scr_temp_place` contains
`_temp_`, so it was judged a temporary; the emitter records only names of the
minted shape (`_<prefix>_temp_<digits>`) in `declared_c_var_names`, so the
local was never "declared" and its drop was skipped at every escape. The
normal scope-end path does not use this guard, which is why the end of
`evaluate_match` still dropped it.

A gated probe in a develop-built compiler compiling `src/main.yo` showed it:
the `scr_temp_place` drop reached the escape filter at 475 sites and was
rejected by this guard at all 475, while its neighbours (`imm_place`,
`arm_value_roots`) passed it.

## Fix

The guard recognizes a minted temporary by the generator's exact shape,
`is_any_temp_variable_name` (`src/utils.yo`), the predicate written for that
question. Every other local, whatever its name, goes on to the block-scope
stack check that decides liveness for C locals. Regression test:
`tests/error.test.yo`, "a local named like `scr_temp_place` is released when
an unwind passes its frame" (a `Drop` counter; the test fails before the fix
and passes after it).
