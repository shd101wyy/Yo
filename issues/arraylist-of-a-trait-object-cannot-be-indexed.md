# `ArrayList(Dyn(Trait)).get()` fails to specialize — a list of trait objects cannot be read back

**Status:** open
**Found:** 2026-09-15, writing `error_chain` for `std/error` (plans/STD_API_STABILIZATION.md)

## Symptom

Storing trait objects in an `ArrayList` type-checks and even builds the list,
but reading an element fails the C compile:

```
error: No matching call found with arguments:
(_ptr.add)(index)
    --> std/collections/array_list.yo:311:37
    |
311 |           .Some(_ptr) => .Some((_ptr.add(index)).*)
```

Reproduced with `ArrayList(AnyError)` — i.e. `ArrayList(Dyn(Error))` — via:

```yo
{ AnyError } :: import("std/error");
{ ArrayList } :: import("std/collections/array_list");
xs := ArrayList(AnyError).new();
xs.push(dyn(SomeError.Boom));
_v := xs.get(usize(0));      // <- fails here
```

## Why it matters

It is what blocks `error_chain` — the "every link in the chain" half of the
`ErrorChain`/`root_cause` row. `root_cause` needs no container and LANDS
(verified at runtime, `tests/error_source_chain.test.yo`); `error_chain` has no
usable return type today:

- `ArrayList(AnyError)` — this defect: the list cannot be read back.
- `Iterator` with `next() -> Option(AnyError)` — blocked by the sibling defect
  `issues/option-of-a-trait-object-never-emits-its-inherent-methods.md`: an
  `Option` of a trait object cannot take an inherent `Option` method, so every
  ergonomic use of the iterator fails the same way.

So this is not a one-API inconvenience: **a trait object is currently a
second-class element type** — it cannot be stored and read back from the
standard container, nor yielded through the standard iterator protocol.

## Note on the oracle

`yo check ./std` passes over this — 175/175, rc=0 — because it is
evaluator-only. The failure appears only at codegen, as a batch compile failure
with ZERO test failures reported. Score this class on the exit code of a real
`yo test`, never on `check` and never on a `✗` count
(`issues/fixed/...`, and the same signature as the hollow batch).

## Suggested direction

`_ptr.add(index)` is pointer arithmetic over the element type; a `Dyn` element
is a fat pointer, so the stride/specialization for it is what to look at first.
Compare against the working `Option(T)`-of-value case. The two trait-object
defects above are likely the same root cause seen from two containers — worth
checking before fixing either in isolation.

Sharpened by a second reader 2026-09-15, and this is the most precise
statement of the class: both are **"specialize a generic container method
whose element type is a `Dyn`"**. `ArrayList(Dyn).get` and
`Option(Dyn).is_some` are the same operation from the compiler's point of
view — a method on a generic whose type argument is a fat pointer — which is
why both are invisible to `yo check` and appear only at codegen.
