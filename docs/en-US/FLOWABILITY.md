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

## Borrow invalidation

While a `ref(name) := …` binding is live, the same-frame variables its
borrow roots in (the R1–R4 sources) may not be **reassigned** or
**moved** — doing so would free or replace the borrowed backing:

```rust
ref(r) := xs.project(usize(0));
xs = ArrayList(String).new();   // ✗ rejected: would free the buffer r points into
println(r);
```

The same constraint applies to **call uses and aliases** of the source:
while the borrow lives, the source may not be used as a method receiver
or call argument (`xs.push(...)`, `grow(xs)`), and no new binding may be
created from it (`xs2 := xs`) — object types have reference semantics, so
a method's signature cannot prove it doesn't mutate (`push` and `len`
both take `self : Self`). Pre-existing aliases are constrained too (the
marks apply to the whole alias group). Creating ANOTHER borrow from the
same source stays allowed (`ref(b) := xs.project(1)` while `a` is live).

The constraint ends with the binding's block — reassigning or mutating
the source after the borrow's scope closes is fine, as is mutating
unrelated variables. To keep the container freely usable, copy the
element out (`xs.get(i)`) instead of borrowing it.
See `tests/ref_borrow_invalidation.test.yo`.

**Known limitation:** aliasing that crosses a function boundary is
invisible to these checks — a function receiving the same object through
two parameters can mutate through one while borrowing through the other
(`issues/flowability-growth-invalidation-method-calls.md` tracks this).

## Escape hatches

`pragma(Pragma.AllowUnsafe);` exempts a whole file (the std's audited
internals use this); `unsafe(expr)` marks a single expression as checked
by the author. See [MEMORY_SAFETY.md](./MEMORY_SAFETY.md).

## Tests

`tests/flowability_comprehensive.test.yo` (static-str model, copying
ranges, raw-view gating) and `tests/ref_*.test.yo` (the `ref` rule
matrix).
