# Flowability — safe slices and references by default

Yo lets safe code use `Slice(T)`, `str`, and `ref(name) : T` borrows freely,
yet it is **impossible to produce a dangling slice or reference from safe
code**. The compile-time check that guarantees this is called **flowability**.

You normally never think about it — the stdlib is written so the everyday
patterns just work. This document explains the rule for the cases where the
compiler does say *"the expression is not flowable"*, and for anyone writing
low-level code that hands out borrowed views.

## The problem it solves

A `Slice(T)` is a *fat pointer* — a `(data pointer, length)` view into storage
it does **not** own. `str` is the same shape. A `ref(name) : T` parameter is a
second-class pointer into a caller's variable. None of these keep their backing
storage alive. If one escaped to a place that outlives that storage, reading it
later would be a **use-after-free**:

```rust
// REJECTED — would dangle.
first :: (fn() -> Slice(i32))({
  local := ArrayList(i32).new();
  local.push(i32(7));
  match(local.as_slice(), .Some(s) => s, .None => panic("empty"))
  // `local`'s heap buffer is freed when this frame returns;
  // the returned slice would point into freed memory.
});
```

Flowability rejects exactly this class of escape, at compile time, with no
runtime cost and no lifetime annotations.

## The model: "the value must flow into storage that outlives it"

A value is **flowable into a destination** when the compiler can prove, purely
structurally, that the value's backing storage lives at least as long as the
destination. There are no lifetime variables; the proof follows the syntax of
the expression back to a *root* whose lifetime is known.

Flowability only constrains values whose representation **transitively carries
a raw pointer** — `Slice(T)`, `str`, `*(T)`, and any `struct` / tuple / `enum`
/ `Array` that wraps one. Plain `i32`, `bool`, owned `String` / `ArrayList`
(they own a reference-counted buffer that travels with the value), and other
self-contained values are never constrained — they have nothing that can
dangle.

## Where it is enforced

The check runs at the five places a borrowed view can be parked into
longer-lived storage:

| # | Site | Example |
|---|------|---------|
| 1 | `-> ref(T)` function return | `fn(ref(b) : Slice) -> ref(i32)` |
| 2 | value return carrying a raw ptr | `fn(...) -> Slice(i32)` / `-> str` / `-> StructWithSlice` |
| 3 | `ref(name) := expr` local binding | `ref(r) := p` |
| 4 | simple reassignment `name = expr` | `cur = other_slice` |
| 5 | field / index / destructure write | `holder.s = x`, `arr(0) = x`, `(a, b) = (x, y)` |

## What counts as a flowable source

When the compiler walks an expression, these are the roots it accepts. The set
differs slightly per site (a function *return* is stricter than a local
*binding*, because a return must outlive the whole call):

- **A `ref`-bound name** — `ref(name) : T` parameter or `ref(name) := …` local.
  It points at storage in an active caller frame, so it outlives this call.
  *(All sites.)*
- **Any parameter** (not just `ref`) — the caller's argument value is alive for
  the whole call, so a slice rooted in it can be returned to the caller.
  *(Return + binding/assignment sites.)*
- **A `comptime` value or a string / char literal** — it lives in static
  storage and never dangles at runtime. *(All sites.)*
- **An enclosing-scope local** — a local whose scope *encloses* (and therefore
  outlives) the destination. Accepted at the binding (`ref(r) := local`) and
  reassignment/field-write sites, **not** at function-return position (a callee
  local never outlives the caller). For a `name = expr` reassignment or a
  `holder.s = expr` field write, the source local must live in a scope no
  deeper than the destination's container.

## The structural rules

Walking inward from the expression, it is flowable iff one of:

- **R1 — name.** A flowable source per the list above.
- **R2 — projection `base.field`.** Flowable iff `base` is. (Projecting a field
  out of a flowable aggregate yields a borrow with the same root.)
- **R3 — call returning a borrow.** A call whose return slot is `ref(T)` (or, at
  a slice-return site, a value type carrying a raw pointer) is flowable iff
  every argument that could be the borrow's *source* — its `ref`-typed
  parameters, and slice/object parameters that could back the result — is itself
  flowable. (So `slice.project(i)` is flowable iff `slice` is.)
- **R4 — `cond` / `match`.** Flowable iff **every** arm is flowable. One
  dangling arm taints the whole expression.
- **Constructors** — `.Variant(args)`, `Struct(field : arg)`, and tuples
  `(a, b)` are flowable iff every argument/element whose own representation
  carries a raw pointer is flowable. (A freshly built aggregate can only smuggle
  a pointer through its arguments.) Labeled arguments `field : value` are
  transparent — the *value* is what flows.

The net guarantee: every flowable expression's root is something the compiler
knows outlives the destination, so the stored view can never dangle.

## Examples

```rust
// ACCEPTED — projects a slice out of a `ref` parameter; the buffer is the
// caller's and outlives the call.
window :: (fn(ref(buf) : Slice(i32)) -> Slice(i32))(buf);

// ACCEPTED — both match arms root in the parameter `seed`.
pick :: (fn(seed : Slice(i32), other : Slice(i32), c : bool) -> Slice(i32))(
  cond(c => seed, true => other)
);

// REJECTED (site 5, field write) — a slice into an inner-block local stored
// into an outer struct field would outlive its backing.
SliceBox :: struct(s : Slice(i32));
store :: (fn(seed : Slice(i32)) -> unit)({
  (holder : SliceBox) = SliceBox(s : seed);
  {
    tmp := ArrayList(i32).new();
    tmp.push(i32(1));
    holder.s = match(tmp.as_slice(), .Some(s) => s, .None => seed); // ✗
  };
  ()
});
```

## The escape hatch

A file that declares `pragma(Pragma.AllowUnsafe);` opts out of the flow gates
entirely (it is already trusted to use raw pointers), and within any file an
`unsafe(expr)` expression is treated as flowable — the documented "I have
checked this" marker. The stdlib's low-level projections (`Slice`, `ArrayList`,
`String` indexing) use exactly this: they compute an element address with
pointer arithmetic and wrap the result in `unsafe(...)`, so callers get a safe
API over an audited unsafe core. See [MEMORY_SAFETY.md](./MEMORY_SAFETY.md).

## Scope and limitations

Flowability is a **structural, scope-nesting** proof, not a full
borrow-checker. It guarantees that a stored view's backing *scope* encloses the
view's destination. It deliberately does **not** track two things:

1. **Reassignment or move of the backing within the same scope.** If a slice is
   taken from a same-scope local collection and that local is then *reassigned*
   (dropping its old buffer) while the slice is still held, the slice dangles —
   flowability accepts the original same-scope binding because the scopes nest,
   but it does not see the later reassignment:

   ```rust
   buf := ArrayList(i32).new();
   buf.push(i32(7));
   s := match(buf.as_slice(), .Some(x) => x, .None => panic("e"));
   buf = ArrayList(i32).new();  // old buffer freed; `s` now dangles
   ```

   This is the known boundary of the scope-nesting model; tracking it requires
   move/borrow invalidation, which is future work.

2. **`unsafe` / pragma'd code.** By design, the gates do not run there.

Within those boundaries — safe code, no in-scope move of the backing — a
dangling slice or reference is **not constructible**.

## Tests

`tests/flowability_comprehensive.test.yo` exercises every rule × enforcement
site × accept/reject, plus `tests/slice_flowability.test.yo`,
`tests/ref_flowability.test.yo`, `tests/ref_local_binding.test.yo`, and
`tests/ref_closure_capture.test.yo`.
