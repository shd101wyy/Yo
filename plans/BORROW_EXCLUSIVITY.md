# Borrow Exclusivity — making flowability COMPLETELY sound

Status: PROPOSAL v2 (2026-06-12). Companion to
`issues/flowability-growth-invalidation-method-calls.md` (the residual) and
the landed call/alias gates (commit 8b0b67b1).

> **v2 design constraints (from the language owner):** maximize what is
> caught statically; eliminate runtime checks/overhead (target 0–15% of
> C); keep the language simple and LLM-friendly. This reorders the
> options: the PRIMARY direction is now **Option D — inferred effect
> summaries + call-site overlap checking (Hylo-style, zero runtime
> cost, zero new syntax)**. The dynamic backstop (Option B below) is
> demoted to an optional fallback if Option D's rejections prove too
> strict in practice.

## Option D (RECOMMENDED, v2) — inferred summaries + call-site overlap checks

Precedent: **Hylo (formerly Val)** achieves memory safety without
lifetime annotations and without runtime checks via two rules: DECLARED
parameter conventions (`let` = immutable borrow, the default — the body
may not mutate through it; `inout` = exclusive mutable access; `sink` =
consume) and a **call-site Law of Exclusivity** — arguments that may be
mutated must not overlap arguments that are borrowed.

Yo deliberately has NO declared conventions: object parameters are
mutable shared handles, and `push`/`len` are signature-identical. That
does not break the model — it moves the convention from DECLARED to
INFERRED. The per-parameter summary below (`MUTATES(p)` ≈ Hylo `inout`;
no inferred mutation ≈ Hylo `let`) plays exactly the role Hylo's
declarations play, and is sound by construction: it is computed from the
body, not trusted. The costs are conservatism where the body is
unknowable (recursion back-edges, `dyn` dispatch, extern) — softened by
Yo's per-call-site specialization, which lets summaries see CONCRETE
callees (closure arguments, resolved trait impls) keyed by `funcId`.
Option C's `readonly(self)` is the opt-in declared equivalent of Hylo's
`let`, verified, never required for soundness. Yo can therefore adopt
the same shape with ZERO new syntax: Yo compiles whole-program and the
evaluator already walks every function body.

### Step 1 — per-function effect summaries (inferred, no annotations)

For every function, compute for each object-typed parameter:

```
summary(f) = per param p:
  MUTATES(p)        — p is a receiver/argument of an invalidating use
                      anywhere in f's body (transitively, via callee
                      summaries; recursion/unknown → conservatively true)
  BORROWS(p)        — a `ref` borrow rooted in p is live across any
                      potentially-invalidating point in f
  ESCAPES(p)        — p is stored into a field/global/return
```

This is a bottom-up fixpoint over the call graph — the same flavor of
analysis as the existing CTFE-capability and await-point analyses, so the
infrastructure idioms already exist. Builtins/extern get pessimistic
summaries.

### Step 2 — call-site overlap rule (the Hylo law)

At every call `f(a1, …, an)`: for every pair (ai, aj) where
`BORROWS(pi)` (or pi is a `ref` param) and `MUTATES(pj)`, the compiler
must prove ai and aj are **distinct objects**. Provable cases (almost
all code):

- different alias groups rooted in distinct LOCAL allocations — a
  freshly constructed object (`ArrayList.new()`, struct literals) is
  unique-by-construction until aliased; the existing
  `isOwningTheSameRcValueAs` machinery already tracks this, it only
  needs a "fresh allocation" root bit;
- one side is a literal/copy (`.get`/`.clone()` results);
- the same variable on both sides → immediate, precise ERROR.

Unprovable cases (both handles arrived from parameters, fields, or
returns with no local pedigree) → **compile error** with the workaround
in the message (copy the element out, or restructure so the borrow does
not cross the call). No runtime check is ever emitted.

```rust
// Caller-side resolution examples:
a := ArrayList(String).new();      // fresh → unique root
b := ArrayList(String).new();      // fresh → unique root
copy_first(a, b);                  // OK: distinct allocations, proven statically
copy_first(a, a);                  // ERROR: same object passed as borrowed+mutated
g :: (fn(x : ArrayList(String), y : ArrayList(String)) -> unit)(
  copy_first(x, y)                 // ERROR (propagated): cannot prove x ≠ y here…
);                                 // …so g's summary inherits the obligation, and
h := ArrayList(String).new();
g(h, h);                           // …the question resolves at THIS call site: ERROR
```

The obligation propagates up the call graph as part of the summary
(`copy_first` requires p1 ≠ p2 → `g` requires x ≠ y → resolved where the
objects are born). At the top of most programs objects have local
pedigree, so the question almost always resolves statically — this is
exactly why Hylo's model works without annotations.

### Step 3 — heap-mediated handles (the honest residue)

Two handles pulled out of a heap graph (e.g. two values from a
`HashMap`) have no pedigree. Under v2 these are REJECTED when used as a
borrowed+mutated pair across a call — with copy-out as the suggested
idiom. This is the simplicity trade: no runtime check, slightly stricter
language. If real-world code hits this often, the Option B borrow
counter can be added LATER, emitted ONLY at the (rare, statically
identified) unproven sites — hybrid cost ≈ 0.

### Why this fits the goals

- **Runtime overhead: zero.** Nothing is emitted; soundness is a
  compile-time property.
- **Language complexity: zero new syntax.** Everything is inferred;
  users (and LLMs) only ever SEE precise compile errors that teach the
  rule. An optional `readonly(self)` annotation (Option C) remains a
  pure ergonomic refinement, not a soundness requirement.
- **LLM-friendliness:** the rule is one sentence — "while you borrow
  from a container, nothing may mutate it, and a function may not
  receive the same container as both borrowed and mutated" — and every
  violation produces an error message stating the fix.

### Implementation order (v2)

1. "Fresh allocation" root bit on the alias machinery (constructors mark
   the new variable as a unique root; aliasing clears it). Enables
   call-site distinctness proofs.
2. Effect summaries: bottom-up MUTATES/BORROWS per object param,
   memoized per specialized function (the evaluator already specializes
   per call — summaries piggyback on `funcId`).
3. Call-site overlap check in `tryToCallFunctionWithArguments` (and the
   yo-self mirror in calls/helper.yo) using summaries + alias verdicts;
   obligation propagation into the caller's summary when unresolved.
4. Tests: the f(list, list) family (same var, aliased var, fresh-distinct
   OK), propagation through one and two call levels, heap-mediated
   rejection with copy-out positive.
5. Docs: FLOWABILITY.md "the call-site law" section (en/zh).

---

## Historical analysis (v1) — kept for the record


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

## Option B (v1 recommendation, now FALLBACK) — dynamic exclusivity backstop, Swift-style

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

## v1 recommendation (superseded by Option D above)

Option B remains the documented fallback: if Option D's rejections of
heap-mediated handle pairs prove too strict in practice, add the borrow
counter ONLY at statically-unproven sites (hybrid; near-zero cost). The
`readonly(self)` modifier (Option C) composes with either direction.
