# A place lent into a reference field is never dropped

**Severity:** S1: a memory leak in generated code. A local whose place is lent into a holder's reference field (`V(l)(xs : &l)`) is never dropped, and in a loop the leak is unbounded.

## Reproducer

`issues/repros/2026-11-03-a-place-lent-into-a-reference-field-is-never-dropped.yo`:

```yo
{ ArrayList } :: import("std/collections/array_list");
BsRV :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(xs : &(ArrayList(i32), p)));
main :: (fn() -> unit)({
  mut(l) := ArrayList(i32).new();
  l.push(i32(7));
  v := BsRV(l)(xs : &l);
});
export(main);
```

`yo compile … --sanitize address --allocator system` and running the binary gives:

```text
SUMMARY: AddressSanitizer: 48 byte(s) leaked in 2 allocation(s).
```

These are the list's object and its buffer. The emitted C has no drop of `l` at all. The leak reproduces on develop `dd9ca178c` (N2b, #1720) and on every later branch.

## Root cause

A struct constructor records a dup for each field argument as a field store (`set_expr_as_needs_to_call_dup(…, "field-store")`, `src/evaluator/calls/type.yo`). It does this even when the field is a reference that only stores the place's address (T9). The dup/drop pair optimizer then pairs that dup with `l`'s scope-end drop. It cancels both, as it would for a move into the holder. But a holder's drop never drops a reference field, so nothing drops `l`.

## Fix

A reference field gets no field-store dup: storing a reference copies no ownership. The fix is in `src/evaluator/calls/type.yo`. The test is `tests/borrow_spelling.test.yo`, "A place lent into a reference field is dropped at its own scope end"; the runner's leak check fails it before the fix.
