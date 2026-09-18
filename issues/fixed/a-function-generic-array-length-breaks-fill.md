# `Array(T, N).fill(v)` fails when `N` is a FUNCTION generic (an impl generic is fine)

**Status: FIXED 2026-09-18.** Not fixed by anything aimed at this defect — the
run-time `fill` (user decision, 2026-09-18) emits a loop over `MaybeUninit`
storage rather than an `__yo_array_fill` initializer list, and that lowering
does not care whether `N` came from a function generic or an impl generic.
Measured on the fix: the `repn` reproducer below prints `4 9`, where it
previously aborted out of an rc=0 compile.

**Status when written:** OPEN. Found 2026-09-17 while measuring how to close the
`Array(T, N)` `Default` row of `plans/archive/STD_API_STABILIZATION.md`.

**How far this was taken: two compiles, and no further probing.** No
instrumentation was run and no mechanism is proposed. What follows is what those
two compiles show and nothing beyond it.

## The defect

A function whose array length is a **function** generic parameter fails to
transpile, and the binary aborts at run time out of an rc=0 compile:

```rust
repn :: (fn(generic(T : Type, N : usize), proto : Array(T, N), x : T) -> Array(T, N))(
  Array(T, N).fill(x)
);
```

```
yo: FATAL: reached yo_id_..._ret_Array_T__N_, whose body failed to transpile -
its definition-time evaluation failed and was swallowed.
```

## The variable is the LENGTH, not the value — measured, not inferred

The two reproducers differ **only** in the fill value and fail **identically**:

| reproducer | fill value | result |
| --- | --- | --- |
| `issues/repros/fn-generic-array-length-fill.yo` | `v + i32(9)` — a run-time value | FTT abort stub |
| same file, control arm | `i32(9)` — a compile-time literal | FTT abort stub |

That control is load-bearing. Without it the obvious reading is "a run-time fill
value does not work", which points at `fill`'s `comptime(val)` parameter and at
a runtime element-wise initializer — the wrong fix, and the one this project was
about to build.

## An IMPL generic length is fine

The same capability through an impl generic compiles and runs:

```rust
impl(
  generic(T : Type, U : usize),
  where(T <: Comptime),
  Array(T, U),
  zeros : (fn() -> Self)(Array(T, U).fill(T(0)))
);
```

→ `Array(i32, usize(4)).zeros()` prints `4 0`.

This is the form `std/` already uses for `Eq`/`Ord`/`Clone`/`Hash` over
`Array(T, U)`, so the supported path is not blocked — which is why this is an
open defect rather than a blocker.

**Do not generalise between the two forms.** A function generic and an impl
generic in a type position are not interchangeable here, and probing one while
reasoning about the other is how a working design gets declared impossible.

## Not to be confused with

`issues/array-fill-accepts-a-runtime-value-and-aborts-at-run-time.md` — that one
is a genuine USER error (`fill` is `comptime(val)` by construction and
`T.default()` is a run-time call) reported as an abort stub instead of a
diagnostic. **This** one is a compiler defect: the fill value is compile-time
known in both arms above and it still fails.
