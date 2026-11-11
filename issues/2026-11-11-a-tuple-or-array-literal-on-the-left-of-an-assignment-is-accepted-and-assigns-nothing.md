# A tuple or array literal on the left of an assignment is accepted and assigns nothing

**Severity:** S1. `(a, b) = (b, a);` passes `yo check` and compiles; it reads like a destructuring swap, but it builds
a temporary tuple from `a` and `b`, stores the right side into that temporary and discards it: the program prints
`a=1 b=2` (a silently wrong result, no diagnostic). An array literal or a struct literal on the left behaves the
same. With move-only elements the left side is evaluated as a value that moves `a` and `b`, so a later read is a
confusing E0901 pointing at the left side. Pre-existing: v0.2.76 accepts the `i32` forms too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A39). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-tuple-or-array-literal-on-the-left-of-an-assignment-is-accepted-and-assigns-nothing.yo`
(negative, expects the not-a-place rejection `id(a) = i32(5)` already gets):

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(a) := i32(1);
  mut(b) := i32(2);
  (a, b) = (b, a);
  println(`OUT a=${a.to_string()} b=${b.to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
OUT a=1 b=2
```

The emitted C (names shortened): the store goes through a pointer to a temporary built from the left side.

```text
Tuple tmp_lhs = (Tuple){ ._0 = __yo_v_a, ._1 = __yo_v_b };
Tuple tmp_rhs = (Tuple){ ._0 = __yo_v_b, ._1 = __yo_v_a };
Tuple* __yo_place_ptr = &(tmp_lhs); // Evaluate the place once
…
(*__yo_place_ptr) = tmp_rhs;
```

- `…-shapes.yo` (negative): `[a, b] = [i32(5), i32(6)]`, `P(x : a, y : b) = P(…)` and `(a, t.0) = (…)`; every
  value prints unchanged.
- `…-strings.yo` (negative): `(a, b) = (String.from("new-a"), String.from("new-b"))` on two `String` locals; today
  E0901 at the later read of `a`, "value moved here" pointing into the left side.
- `…-pos.yo` (positive control): the swap written with a temporary, `tmp := a; a = b; b = tmp;`, prints `a=2 b=1`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `(a, b) = (b, a)`, `(a, b) = (i32(5), i32(6))` on `i32` locals | accepted, no effect | rejected: not a place |
| `[a, b] = [b, a]`, `[a, b] = [i32(5), i32(6)]` | accepted, no effect | rejected: not a place |
| `P(x : a, y : b) = P(…)` (a struct literal), `(a, t.0) = (…)` | accepted, no effect | rejected: not a place |
| `(a, b) = (fresh, fresh)` on `String` locals, `a`/`b` not used afterwards | accepted, no effect, no leak | rejected: not a place |
| the same with a later read of `a`; `(a, b) = (b, a)` on `String` (ledger s14, s19) | E0901 at the read, "moved" at the left side | rejected: not a place |
| `id(a) = i32(5)`, `id` a function (ledger s21) | "Cannot assign to the result of a function call" | the same |

## Root cause

Verified in `src/evaluator/exprs/assignment.yo`, `evaluate_assignment`'s property / index path, which takes every
left side that is neither an atom nor a typed binding. It evaluates the left side with `is_lhs_of_assignment` set,
then rejects a non-place only in one case: the left side is a call, not a `.` access nor a projection call, and its
callee's type `is_function_type` (the fix of `issues/fixed/assignment-to-call-expression-silently-accepted.md`). A
tuple literal is a `tuple(...)` call (`BK_TUPLE`, `src/expr.yo`), an array literal is the array builtin's call, and a
struct literal's callee is a type: none has a function type, so each falls through and is treated as a place. Codegen
(`src/codegen/exprs/assignment.yo`) materializes the "place" once (`_place_evaluation_runs_a_call`), which here means a
temporary, and stores into it.

## Expected

A clean rejection. Yo has no destructuring assignment: no design document defines one (`grep -rn "destructuring
assignment"` finds only `{ x, y } := point`, a binding), and the only place shapes `=` accepts are a name, a field
access, an index and a `&mut` projection call (the comment above the check lists them). Every other left side gets the
not-a-place error the call form already has, ideally with a code and a help line naming the swap spelled with a
temporary (or `swap(&mut a, &mut b)`). If destructuring assignment is wanted later, it is a design decision
(`issues/questions/`), not this fix.

## Test

With the fix, the three negative programs and the positive control move to `tests/origins/unsound/`;
`tests/basic.test.yo`, beside "assignment to the result of a function call", gains `comptime_expect_error` rows for
the tuple, array and struct literal targets.
