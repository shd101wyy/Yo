# Borrow Exclusivity — making flowability COMPLETELY sound

Status: PROPOSAL (2026-06-12). Companion to
`issues/flowability-growth-invalidation-method-calls.md` (the residual) and
the landed call/alias gates (commit 8b0b67b1).

## Where we are

The static borrow-invalidation gates close every SAME-SCOPE invalidation:
reassign, move, method-call/argument use, alias creation, pre-existing
alias groups. What static checking fundamentally cannot see:

1. **Cross-function parameter aliasing** — `f(xs, xs2)` called as
   `f(list, list)`; inside `f`, nothing says the params alias.
2. **Heap-mediated aliasing** — a handle to the same object retrieved
   from a struct field, a global, or a function return.
3. **Lying projections** — the ref-binding RHS is exempt from the freeze
   so multi-borrow works; a ref-returning method that ALSO mutates slips
   through.

All three reduce to the same root: Yo objects are RC'd shared handles —
**aliasing is a feature** — and there is no type-level aliasing/effect
information.

## Option A — full static soundness (Rust-style exclusivity): REJECTED

To prove non-aliasing statically you need uniqueness in the types:
`&mut`-style exclusive handles, call-site rejection of `f(list, list)`,
and alias tracking through every field store and return. That is a
different language: it deletes the shared-handle object model Yo chose
deliberately (no lifetimes, no `&/&mut` bifurcation). The halfway version
— "assume every same-type parameter may alias" — is sound but rejects the
COMMON two-container pattern:

```rust
// Sound-but-unusable under static may-alias: dst MIGHT alias src,
// so the borrow of src would freeze dst.push too.
copy_first :: (fn(dst : ArrayList(String), src : ArrayList(String)) -> unit)({
  ref(e) := src.project(usize(0));
  dst.push(e.clone());   // rejected, though dst ≠ src in 99% of calls
});
```

## Option B (RECOMMENDED) — dynamic exclusivity backstop, Swift-style

Swift faced exactly this shape (reference semantics, no lifetimes) and
solved it with the **Law of Exclusivity**: static checks where the
compiler can see, **runtime exclusivity checks** where it can't. We adopt
the same two-layer design:

- **Layer 1 (exists)**: the static gates — compile-time errors, best
  diagnostics, zero runtime cost. Unchanged.
- **Layer 2 (new)**: a runtime borrow flag on RC objects. The residual UB
  becomes a deterministic, well-messaged PANIC — the same soundness
  stance as bounds checking.

### Runtime representation — zero memory cost

Both `__yo_ref_header_t` variants have padding to absorb a counter:

```c
// Lightweight header today: { size_t ref_count; uint16_t type_id; }
// — 6 bytes of tail padding on 64-bit. After:
typedef struct __yo_ref_header_t {
  size_t ref_count;
  uint16_t type_id;
  uint16_t borrow_count;   // NEW — lives entirely in existing padding
} __yo_ref_header_t;

static inline void __yo_borrow_acquire(void* obj) {
  __yo_ref_header_t* h = (__yo_ref_header_t*)obj;
  if (h->borrow_count == UINT16_MAX) __yo_panic("borrow counter overflow");
  h->borrow_count++;
}
static inline void __yo_borrow_release(void* obj) {
  ((__yo_ref_header_t*)obj)->borrow_count--;
}
static inline void __yo_assert_unborrowed(void* obj, const char* op) {
  if (((__yo_ref_header_t*)obj)->borrow_count != 0) {
    __yo_panic_fmt("cannot %s: an element of this collection is borrowed "
                   "(a live 'ref' points into its storage)", op);
  }
}
```

(Atomic objects use atomic RMW on the counter; `str` needs nothing — it
is static data by construction.)

### Codegen — acquire/release ride the existing borrow plumbing

`ref(r) := xs.project(i)` already computes its source set
(`collectRefBorrowSources`, alias-group marking). Codegen emits an
acquire on each source OBJECT at the binding and a release at the
binding's scope end — on the same deferred-cleanup lists that drops use
(including the early-return paths we just hardened):

```c
// ref(r) := xs.project(0);
__yo_struct_String* r = fn_ArrayList_project(xs, 0);
__yo_borrow_acquire(xs);          // NEW
...
// scope end (and every early-return cleanup block):
__yo_borrow_release(xs);          // NEW — alongside the existing drops
```

### Std — invalidating methods assert

Every non-readonly method of a borrow-yielding container asserts at
entry, via a builtin so it costs one predictable branch:

```rust
push : (fn(self : Self, value : T) -> Result(unit, ArrayListError))({
  unsafe(__yo_assert_unborrowed(self, "push"));
  // ... existing body
}),
```

### What it buys — the residual, made safe

```rust
f :: (fn(xs : ArrayList(String), xs2 : ArrayList(String)) -> unit)({
  ref(r) := xs.project(usize(0));   // borrow_count(list) = 1
  xs2.push(String.from("filler"));  // SAME list → assert fires:
  // panic: cannot push: an element of this collection is borrowed
  println(r);
});
main :: (fn() -> unit)({ list := ...; f(list, list); });
```

Heap-mediated handles and lying projections are caught identically —
the flag lives on the OBJECT, so it doesn't matter which handle or path
reaches it.

## Option C — `readonly(self)` receiver modifier (optional ergonomic layer)

Not required for soundness; relaxes the conservative static freeze AND
skips the dynamic assert. Fits Yo's existing parameter-modifier grammar
(`ref(self)`, `own(x)`):

```rust
len : (fn(readonly(self) : Self) -> usize)(self._length),
get : (fn(readonly(self) : Self, index : usize) -> Option(T))(...),
```

Semantics:
- The static gate ALLOWS calling a `readonly(self)` method on a borrowed
  source (`xs.len()` while `ref(r)` lives — currently rejected).
- The compiler VERIFIES the annotation: inside a `readonly` method body,
  `self` is treated as borrow-frozen (reusing the gate machinery), so a
  readonly method cannot write fields, call non-readonly methods on
  `self`, or pass `self` to mutating positions. The annotation cannot lie.
- Dynamic layer: readonly methods don't assert (they can't invalidate).

## Recommendation

1. **Ship Option B** — it is the only design that achieves complete
   soundness without abandoning the shared-handle object model, costs no
   memory and one branch per mutating container op, and converts the
   remaining UB class into deterministic panics. Precedent: Swift
   exclusivity enforcement, which shipped exactly this trade.
2. **Follow with Option C** for ergonomics: un-freeze `len`/`get`-style
   reads statically, verified by the compiler.
3. **Do not pursue Option A** — static-only soundness under unrestricted
   aliasing either changes the language into Rust or over-rejects the
   common patterns.

## Implementation order

1. Header field + the three runtime helpers (both header variants,
   atomic variant for `atomic object`).
2. Codegen acquire/release for `ref(r) := …` bindings (sources from the
   existing mark machinery; releases on the deferred-cleanup lists).
3. `__yo_assert_unborrowed` builtin + std markup of invalidating methods
   (ArrayList, String, HashMap, Deque, BTreeMap — the project()/borrow
   providers and their mutators).
4. Tests: the param-aliasing repro panics (run-time test with expected
   non-zero exit), gmalloc-clean positive paths, borrow across early
   returns/unwind.
5. yo-self mirrors of the evaluator-side pieces; codegen pieces land
   with the codegen port.
6. (Phase 2) `readonly(self)` modifier: parser + verification + gate
   relaxation + std annotation sweep.
