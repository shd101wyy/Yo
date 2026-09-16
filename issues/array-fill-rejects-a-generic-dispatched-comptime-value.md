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

## Narrowed 2026-09-16 — `fill` and generics are both fine; the trait DISPATCH is not

Four probes in the same generic shape, so only one thing varies:

| probe | body | result |
| --- | --- | --- |
| A | `-> Array(T, usize(3))`, value passed through, no construction | **OK** |
| C | `Array(T, usize(3))(x, x, x)` — explicit construction, same `(Default, Comptime)` bound | **OK** |
| D | `Array(T, usize(3)).fill(T(0))` — `fill`, generic element, comptime LITERAL | **OK** |
| G2 | `Array(T, usize(3)).fill(T.default())` — `fill`, generic element, TRAIT CALL | **FTT stub** |

So none of these is the cause: the generic return type (A), the `Comptime`
bound (C), `fill` itself (D), or `fill` with a generic element type (D again).

What fails is specifically **a generic-dispatched trait method call in a
`comptime(...)` argument position**. `T(0)` is comptime-evaluable without
knowing which impl to pick; `T.default()` requires resolving the `Default` impl
for the bound `T` first, and that resolution has not happened when
`fill`'s `comptime(val)` is checked — even though after specialization `T` is
`i32` and `i32.default()` is the constant `0`.

The emitted C names the symptom exactly. The stub is

```
yo_id_..._ret_Array_T____Default___Comptime___3_
```

— the return type still carries the UNSUBSTITUTED `T` with its bound, while a
sibling function in the same file is correctly `Array_int32_t_3`.

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
