# An enum-literal argument for an `Option` of a pointer to a generic parameter is rejected

**Severity:** S2 — calling `fn(generic(T : Type), n : Option(*T))` with `.Some(px)` is E0601 ("Expected: *(T), Given: *(i64)") even when `T` is already bound by an earlier argument; binding the literal to a typed local first works.

**Status:** open. Found 2026-10-24 while implementing P6
(`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` D23): the node linking helpers
of `std/collections/linked_list.yo` were first written as
`_set_next(node, .Some(new_node))`, and every such call failed. The list now
links nodes through `_join(a, b)` (two plain pointer arguments) instead.
Reproduces identically with the v0.2.68 seed and a develop build of
`f1cfa553d`.

## Reproducer

`issues/repros/2026-10-24-an-enum-literal-argument-for-an-option-of-a-pointer-to-a-generic-parameter-is-rejected.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
only_opt :: (fn(generic(T : Type), n : Option(*T)) -> usize)(size_of(T));
ptr_and_opt :: (fn(generic(T : Type), p : *T, n : Option(*T)) -> usize)(size_of(T));
main :: (fn() -> unit)({
  x := i64(3);
  px := addr_of(x);
  println(&only_opt(.Some(px)));
  println(&ptr_and_opt(px, .Some(px)));
});
export(main);
```

```text
error[E0601]: Incompatible types for field "value":
- Expected: *(T)
- Given  : *(i64)
```

Measured variants:

| Parameter          | Argument                                | Result |
| ------------------ | --------------------------------------- | ------ |
| `n : Option(*T)`   | `.Some(px)`                             | E0601  |
| `p : *T, n : Option(*T)` | `px, .Some(px)` (`T` bound by `p`) | E0601  |
| `p : *T, n : Option(*T)` | `px, o` with `(o : Option(*i64)) = .Some(px)` | rc 0 |
| `p : *T, n : Option(*T)` | `px, .None`                       | rc 0   |
| `p : T, n : Option(T)`   | `i64(1), .Some(i64(2))`            | rc 0   |
| `p : *W(T), n : Option(*W(T))` | `pw, .Some(pw)`              | E0601  |

So the failure needs a pointer between the `Option` and the binder: the
enum literal's payload is checked against the variant's field type
`*(T)` with `T` unsubstituted (a top-level `T` field is substituted, a `T`
under `*` is not), and that check runs before — or without — the binding
the other argument already made.

## Fix direction

Where an enum-literal argument is checked against a generic parameter type,
resolve the expected variant field through the current binder substitution
deeply (through `Pointer`), or synthesize the literal's type from its payload
and unify it like any other argument. Regression test: the repro as a
`tests/` case.
