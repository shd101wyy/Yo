# A `HashMap` of a move-only key or value does not compile

**Severity:** S2 — valid programs are rejected: no `HashMap` can hold a `Dispose` value or a `Box` key, so the unique `Box` and every resource type are unusable as map keys or values.

**Status:** open. Found 2026-10-12 while testing the unique `Box` (V1 step 2);
it is not `Box`-specific and reproduces on the v0.2.59 seed.

## Symptom

```text
error[E0901]: use of moved value: cannot copy `(data_ptr.add)(probe_index).*`, whose type `MapEntry(K : …, V)` is move-only, and it cannot be moved either: it is the value a pointer or reference points to, and that storage still owns it (a dereference copies, it never moves).
note: raised here, inside the standard library
    --> std/collections/hash_map.yo:374:48
    |
374 |           bucket := (data_ptr.add(probe_index)).*;
```

## Reproducer

```yo
{ HashMap } :: import("std/collections/hash_map");
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(Fd, Dispose(dispose : (fn(self : &Self) -> unit)(())));
main :: (fn() -> unit)({
  m := HashMap(i32, Fd).new();
  m.insert(i32(1), Fd(n : i32(2)));
  println(m.len());
});
export(main);
```

`yo check` fails with the error above; `HashMap(Box(P), i32)` fails the same
way through its key.

## Root cause

`HashMap`'s probe loops read each bucket by value
(`bucket := (data_ptr.add(probe_index)).*`), a copy of a `MapEntry(K, V)`.
Since V3 a dereference of a move-only value cannot be copied (E0901), so any
`K` or `V` that is move-only makes the whole map unusable.

## Fix direction

The probes must read the bucket in place (a borrow of the slot, or field
reads through the slot pointer) instead of copying it. This is the
non-copying element access of decision 20, which V2b gives the collections
(`plans/VALUES_BY_DEFAULT.md` §6 V2b); the regression test is the reproducer
above as a `tests/` case, plus a `HashMap(Box(K), V)` insert/get in
`tests/rc.test.yo`'s unique-`Box` section.
