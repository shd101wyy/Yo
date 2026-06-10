# Flowability — safe-by-default references

Yo's **flowability** check guarantees, at compile time, that safe code
cannot construct a dangling reference. After the slice rework
(static `str`, copying ranges), the rule surface is small:

## What can dangle — and what cannot

- **`ref(name) : T` parameters and `ref(r) := …` bindings** are
  second-class references to caller/outer storage. They are the ONLY
  borrowed views left in safe code, and flowability constrains where they
  may flow.
- **`str`** is the builtin view of **static** string bytes (literals and
  template-literal segments). Its backing is immortal, so a `str` is
  freely copyable, storable in fields, returnable — no flow constraints
  and no runtime cost. There is no way to view a heap `String`'s bytes as
  `str` from safe code (`as_str()` does not exist).
- **Range indexing copies.** `arr(a..b)` on `Array`/`ArrayList` returns a
  new `ArrayList(T)`; `s(a..b)` on `String` returns a new `String`;
  `v(a..b)` on `str` returns a `str` window of the same static bytes.
  Mutating or growing the source never affects the copy, and vice versa —
  the classic slice-invalidation footgun is *unconstructible*.
- **Owned values** (`i32`, `bool`, `String`, `ArrayList`, structs of
  them, …) carry their storage with them and are never constrained.
- **Raw views** (`*(T)`, `RawSlice(T)`, structs wrapping them, and
  `String.raw_bytes()`) belong to PRIVILEGED code: a file must declare
  `pragma(Pragma.AllowUnsafe);` to even name such a type in an
  annotation. Safe code cannot receive, store, or return them.

## The `ref` rules

A `ref` may only be placed into storage that **outlives** it. The
compiler proves this structurally (no lifetime annotations) at two sites:
function `-> ref(T)` returns and `ref(r) := …` local bindings.

- **R1 — names.** A `ref`-bound name flows anywhere; at binding sites, an
  enclosing-scope local also flows (its scope contains the target's).
- **R2 — projection.** `base.field` flows iff `base` does.
- **R3 — borrowing calls.** A call returning `ref(T)` flows iff every
  argument that can source the borrow flows.
- **R4 — `cond`/`match`.** Flows iff every branch flows.

A function's local can never be returned by `ref` — the callee's frame
dies first. See `tests/ref_*.test.yo` for the full matrix.

## Escape hatches

`pragma(Pragma.AllowUnsafe);` exempts a whole file (the std's audited
internals use this); `unsafe(expr)` marks a single expression as checked
by the author. See [MEMORY_SAFETY.md](./MEMORY_SAFETY.md).

## Tests

`tests/flowability_comprehensive.test.yo` (static-str model, copying
ranges, raw-view gating) and `tests/ref_*.test.yo` (the `ref` rule
matrix).
