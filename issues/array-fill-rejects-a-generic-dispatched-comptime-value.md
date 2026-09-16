# `Array.fill` rejects a generic-dispatched comptime value — and does it as an FTT stub

**Status:** OPEN. Found 2026-09-16 while trying to close the `Array(T, N)`
`Default` row of `plans/STD_API_STABILIZATION.md`.

## Symptom

`Array(T, N).fill` is declared `fill : (fn(comptime(val) : T) -> comptime(Self))`
under `where(T <: Comptime)`. A LITERAL satisfies `comptime(val)`, even inside a
generic function. A value produced by a **generic-dispatched trait call** does
not — even when `T` is bounded `Comptime` and the concrete `T`'s `default()` is
itself a compile-time constant.

Measured with the same generic shape in both arms
(`issues/repros/array-fill-rejects-a-generic-dispatched-comptime-value.yo`):

| fill value | result |
| --- | --- |
| `i32(0)` — literal | **works**, prints 3 |
| `T.default()` — generic dispatch | **FTT stub** |

The failure mode is the bad one: `yo compile` exits **rc=0**, and the binary
aborts at run time with

```
yo: FATAL: reached yo_id_..._ret_Array_i32__3_, whose body failed to transpile —
its definition-time evaluation failed and was swallowed.
```

`yo check` on the same file also exits **0**, because `check` never evaluates
function bodies ([[yo-check-src-std-are-a-filter-not-a-gate]]). So nothing
short of running the binary reports this.

## What it blocks

**`Array(T, N)`'s `Default`**, which is the only spelling available:

```rust
impl(
  generic(T : Type, U : usize),
  where(T <: (Default, Comptime)),
  Array(T, U),
  Default(default : (fn() -> Self)(Array(T, U).fill(T.default())))
);
```

That impl registers, compiles, and aborts. Narrowing the bound from `Default`
to `(Default, Comptime)` does not help — the probe above already carries the
`Comptime` bound.

## This row is NOT blocked on value substitution — the plan mis-attributes it

`plans/STD_API_STABILIZATION.md` lists `Array(T,N)` `Default` beside the byte
conversions under
`plans/backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`, on the reasoning that
"a `default()` generic over `N` is the same substitution problem". It is not.

- The byte conversions needed an associated constant in a LENGTH position.
  That landed in #714 and they are written
  (`feat/std-byte-conversions`, pending the seed bump).
- `Array` `Default` needs no such thing: a bare generic `N` was ALWAYS a legal
  length, and `impl(generic(T : Type, U : usize), Array(T, U), …)` is how std
  already writes `Eq`/`Ord`/`Clone`/`Hash` for arrays. What it needs is the
  ability to produce N copies of a value that is not a literal — which is the
  "runtime element-wise initializer Yo has no spelling for yet" the row's own
  text names, and which this defect is the precise form of.

So closing the value-substitution row does not close this one, and the two
should be tracked apart.

## Fix shapes

1. **Make `comptime(val)` accept a generic-dispatched call whose result IS a
   comptime constant after specialization.** The specialization knows `T`, so
   `T.default()` is constant-foldable at that point; the failure is that the
   check runs before or without that knowledge.
2. **A runtime element-wise initializer** — the thing the row originally asked
   for. Broader: it would also give `Default` for arrays whose element type is
   NOT `Comptime` (`String`, owning types), which fix 1 would still exclude.

(2) subsumes (1) for this row but is the larger change.

## Whatever the fix, the gate is running the binary

`check` is green and `compile` is rc=0 today. Any test for this must execute
the program, or grep the emitted C for the FTT comment
([[yo-self-ftt-measurement-methodology]]) — a compile that "succeeds" proves
nothing here.
