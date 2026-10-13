# `true && x` / `false || x` with a runtime `x` folds to the constant in a `cond` guard

**Severity:** S1 — silent miscompilation: a `cond` arm (and so an `if`) whose guard is a compile-time identity operand `&&`/`||` a runtime operand is taken, or skipped, without looking at the runtime operand.

> Found 2026-10-13 by the std allocator hand-off audit, through
> `ArrayList(unit).ensure_total_capacity`
> (`issues/fixed/arraylist-zst-reserve-adopts-a-buffer-its-temporary-frees.md`).
> **OPEN**: the fix is in the self-hosted evaluator and is split from the std
> PR that found it.

## Reproducer

```yo
{ println } :: import("std/fmt");
_a :: (fn(flag : bool) -> i32)(cond((true && flag) => i32(2), true => i32(3)));
_b :: (fn(flag : bool) -> i32)(cond((flag && true) => i32(2), true => i32(3)));
_c :: (fn(flag : bool) -> i32)(cond((false || flag) => i32(2), true => i32(3)));
_d :: (fn(flag : bool) -> bool)(true && flag);
_e :: (fn(flag : bool) -> i32)({
  x := (true && flag);
  cond(x => i32(2), true => i32(3))
});
_f :: (fn(flag : bool) -> i32)(if(true && flag, i32(2), i32(3)));
main :: (fn() -> unit)({
  println(`a=${_a(false)} b=${_b(false)} c=${_c(false)} d=${_d(false)} e=${_e(false)} f=${_f(false)} (want 3 3 3 false 3 3)`);
  println(`c(true)=${_c(true)} (want 2)`);
});
export(main);
```

With v0.2.60 (`yo compile … --allocator system`):

```text
a=2 b=3 c=3 d=false e=3 f=2 (want 3 3 3 false 3 3)
c(true)=3 (want 2)
```

`_a` and `_f` are wrong, and `_c` returns 3 for every `flag`: its emitted C is
`return 3;`, and `_a`'s is `return 2;`. Swapping the operands (`_b`) or binding
the value first (`_e`) gives the right answer. The real-world form is
`(size_of(T) == usize(0)) && self._ptr.is_some()` in a generic `cond`, which
was taken for every zero-sized `T`.

## Root cause

`evaluate_and_or` (`src/evaluator/builtins/and_or.yo`) walks the operands with a
`result_val` accumulator. A compile-time operand that does NOT short-circuit
(`true` for `&&`, `false` for `||`) sets `result_val` to that constant as long
as no runtime operand has been seen YET. A later runtime operand only sets
`has_runtime`. The final step then keeps `result_val` whenever it is a bool,
which is the branch meant for a genuine short circuit:

```yo ignore
(final_val : Option(EvalValue)) = match(
  result_val,
  .Some(rv) => cond(
    // Short-circuited with definitive answer — keep it.
    is_bool_val(&rv) => .Some(rv),
    has_runtime => .None,
    …
```

So `true && flag` gets the compile-time value `true`, and `cond` selects the arm
from that value. A plain expression position (`_d`) still emits the operand,
because codegen does not take the value there.

## Fix shape

Record whether a short circuit actually happened. Keep the constant only then.
Otherwise the value is `.None` when any operand is runtime, the unknown when
any is unknown, and `BoolVal(is_and)` when every operand was a compile-time
identity.

## Why this is a separate PR

Every `comptime && runtime` and `comptime || runtime` guard in `src/` and `std/`
changes behaviour when the fold is fixed. Each arm that today is silently
always taken, or never taken, starts to run. The ZST arm in
`ArrayList.ensure_total_capacity` was one: it double-freed once it could run,
and it is fixed in std now. The evaluator fix needs a sweep of those guards and
the bootstrap fixpoint, so it is its own change.
