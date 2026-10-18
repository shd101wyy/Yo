# A store in a comptime-parameterized function is dropped when its first call is an operand of `!`

**Severity:** S1 — silently wrong code: a store through a pointer inside the function body is not emitted, so the program reads stale memory.

**Status:** fixed 2026-10-18 (#1445). Found 2026-10-17 while gating the fix for
`issues/fixed/2026-10-16-not-on-a-runtime-bool-in-a-comptime-type-parameterized-fn-is-e1101.md`.
Reproduces on develop at #1380 (`5425cd7bf`) and with that fix applied.

## Reproducer

`issues/repros/2026-10-17-a-store-in-a-comptime-parameterized-fn-is-dropped-when-its-first-call-is-an-operand-of-not.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
C :: struct(flag : bool);
take :: (fn(comptime(T) : Type, p : *C) -> bool)({
  (x : bool) = unsafe(p.*.flag);
  unsafe(consume(p.*.flag = false));
  x
});
cell :: (fn(b : &Box(C)) -> *C)(addr_of(b.*));
main :: (fn() -> unit)({
  c := box(C(flag : true));
  assert(!!take(i32, cell(&c)), "first");
  assert(!take(i32, cell(&c)), "second");
});
export(main);
```

It aborts with "second". The emitted `take` specialization reads `flag` and
returns; the `(*p).flag = false` store is missing.

## What triggers it

All three are needed:

- the function has a comptime parameter, so the call specializes it;
- the pointer argument is a CALL'S RESULT (`cell(&c)`). `take(i32, addr_of(c.*))` emits the store;
- the specialization's FIRST call is the operand of `!`. Binding the result
  first (`r := take(i32, cell(&c)); assert(r, …)`) emits the store, and so
  does `take(i32, cell(&c)) == true`.

The read is irrelevant: replacing it with `(x : bool) = true` still drops the
store. The memoized specialization is whichever the first call site produced,
so a later plain call reuses the broken body. The bug is therefore
order-dependent.

## Root cause

`!` is a Call tuple (`not`, `comptime_not`), and the dispatcher trial-calls
every candidate with fresh-id clones of the arguments under
`ctx.is_in_function_call_checking_phase` (`src/evaluator/calls/function.yo`).
Evaluating the operand's clone specializes `take`, and the specialization
outlives the trial: `_trial_call_overload_candidate` purges only the clones'
own metadata, and the specialization cache hands the same body to the real
call and to every later one. That body was evaluated with the flag still set.
In the checking phase, the `.*` arm of
`src/evaluator/exprs/property_access.yo` keeps a deref of a placeholder
pointer (the call result bound to `p`) as a compile-time placeholder rather
than a runtime deref, so the store `p.*.flag = false` landed on that
placeholder and codegen emitted nothing for it. Evaluating the body outside
the checking phase (the fix below) emits the store, which confirms the cause;
the exact branch of `src/evaluator/exprs/assignment.yo` that drops it was not
traced. A pointer
with no value (`addr_of(c.*)`) takes the runtime deref even in the checking
phase, and a first call outside a trial (a bound result, or `== true`, which
does not go through a Call-tuple trial) evaluates the body for real. That is
why each of the three conditions was needed.

## Fix

`create_specialization_at_call` (`src/evaluator/calls/helper.yo`) clears
`is_in_function_call_checking_phase` while it evaluates the specialized body
and restores it afterwards. A specialization is a real definition, whoever
asked for it, so the trial's checking-phase shortcuts no longer shape it.

Test: `tests/prefix_operators.test.yo`, "a store in a comptime-parameterized
fn first called as an operand of ! is emitted". It covers the reproducer, a
store with no read before it, and a generic method (`_NotWrap.take`) first
called as `!w.take()`. With #1433 alone it aborts at "the first call's store
cleared it".

## Exposure

`std/async/mutex.yo`'s `_unlock_state(T, &guard, self._state())` on develop has
the same shape (a comptime `T`, a call-result pointer, a store through
`st.*`), but every call to it is a statement today, so it is not hit.
#1433's test in `tests/prefix_operators.test.yo` bound each result before
asserting it for this reason; the new test spells the `!` shapes.
