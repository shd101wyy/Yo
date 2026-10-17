# A store in a comptime-parameterized function is dropped when its first call is an operand of `!`

**Severity:** S1 — silently wrong code: a store through a pointer inside the function body is not emitted, so the program reads stale memory.

**Status:** open, found 2026-10-17 while gating the fix for
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

## Suspected mechanism (not verified)

The `!` operator module has a `comptime_not` candidate whose parameter is
`comptime(self)`. Its trial evaluates the operand call, and the specialization
it creates seems to classify the store as compile-time only. Step 7 of
`src/evaluator/exprs/assignment.yo` then sets
`is_compile_time_only_assignment`, codegen emits nothing for it, and the
specialization is cached and reused by the real call.

## Exposure

`std/async/mutex.yo`'s `_unlock_state(T, &guard, self._state())` on develop has
the same shape (a comptime `T`, a call-result pointer, a store through
`st.*`), but every call to it is a statement today, so it is not hit.
`tests/prefix_operators.test.yo` binds each result before asserting it for
this reason.
