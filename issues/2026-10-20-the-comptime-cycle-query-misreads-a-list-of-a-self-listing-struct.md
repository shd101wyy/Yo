# The comptime cycle query misreads a list of a self-listing struct

**Severity:** S3 — `Type.can_form_rc_cycle(ArrayList(LS))` reads `false` for
`LS :: ref(struct(k : ArrayList(Self)))` although the emitted constructor of
that list registers with the cycle collector; only the introspection answer
is wrong, the generated program is right.

**Status:** open. **Found:** 2026-10-20 with the v0.2.66 seed, while probing
`issues/2026-10-20-a-ref-enum-cycle-through-a-ref-struct-is-never-collected.md`.
Cause not established.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
LS :: ref(struct(k : ArrayList(Self)));
main :: (fn() -> unit)({
  s := LS(ArrayList(LS).new());
  comptime_assert(Type.can_form_rc_cycle(ArrayList(LS)), "q");
  ()
});
export(main);
```

`yo check` fails the assertion. The answer depends on what ran before it:

| Statements before the spelled query                                          | Answer  |
| ---------------------------------------------------------------------------- | ------- |
| none                                                                         | `false` |
| `s := LS(ArrayList(LS).new());`                                              | `false` |
| `s := ...; x := s.k;`                                                        | `false` |
| `l := ArrayList(LS).new();` and a query of `type_of(l)` (itself `false`)     | `false` |
| `s := ...;` and a query of `type_of(s.k)` (itself `true`)                    | `true`  |

`Type.can_form_rc_cycle(LS)` is `true` throughout, and so is
`Type.impls(ArrayList(LS), Acyclic) == false`. In codegen,
`ArrayList(LS)`'s constructor calls `__yo_gc_register`, and a cycle
`k.push(LS(k))` is collected.

## What is known

The walk from the list root re-roots at `LS` and needs to meet the list's own
struct id again in `LS`'s field type. That it does not suggests that the
spelled `ArrayList(LS)` and the `ArrayList(Self)` inside `LS`'s definition
are different instantiations with different ids. Generic instantiations get
eval-fresh ids (`src/evaluator/calls/comptime_fn.yo`, "ids stay eval-fresh"),
and the field's copy is built against `LS`'s self-shell. Why a query of
`type_of(s.k)` makes later spelled queries agree is not known. This is a
hypothesis; nobody has printed the ids.

## Test

`tests/cycle_collector.test.yo`, "Type.can_form_rc_cycle reads a spelled
ArrayList(Self) instantiation as codegen does": a runtime `assert` on
`Type.can_form_rc_cycle(ArrayList(QNode))`. With the seed it fails.
