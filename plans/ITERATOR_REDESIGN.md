# Iterator Redesign — Projection-Style Borrowed Iteration

Status: **Design sketch.** Not yet implemented. Phase D of `plans/MEMORY_SAFETY.md` deferred this redesign; everything else in that plan has landed.

## Problem

The current `Iterator` trait yields raw pointers:

```rust
Iterator :: trait(
  Item : Type,
  next : fn(ref(self) : Self) -> Option(Self.Item)
);

// In practice every collection iterator binds `Item := *(T)`:
impl(forall(T : Type), ArrayIterPtr(T), Iterator(
  Item : *(T),
  next : (fn(ref(self) : Self) -> Option(*(T)))( ... )
));
```

With Phase C's structural gates, `*(T)` is no longer reachable from safe code. That makes every collection iterator (Array, Slice, ArrayList, HashMap, …) **uncallable from safe code as currently shaped**, even though `for(list.iter(), x => body)` is the most basic user-facing operation in the language. We need an iteration protocol that:

1. Doesn't expose `*(T)` at the public API.
2. Yields **borrowed** elements (no per-iteration copy or RC dup for `object` types).
3. Supports `break` / `continue` naturally inside the loop body.
4. Stays consistent with Yo's "no lifetimes, no borrow checker" stance.
5. Composes with existing safe types without forcing `T <: Clone`.

The earlier sketch in `plans/MEMORY_SAFETY.md` proposed three replacements (value iteration, index iteration, `each_mut` callback). Of those, callback-style iteration **fails goal 3** — a closure body's `break` / `continue` would have to escape into the caller's loop, which the closure-capture gate (Phase B) explicitly forbids. Value iteration **fails goal 2** for value-struct types and `object` types with non-trivial RC traffic. Index iteration works but only for random-access collections.

This plan proposes a fourth approach: **projection-style iteration**, modelled on Hylo's `let` / `inout` subscript projections.

## Non-Goals

- **No `&(T)` reference type.** The whole point is to avoid lifting "borrow" into the type universe — once `&(T)` is a type, it composes through `Option`, `Result`, struct fields, etc., and the only sound way to keep that safe is a borrow checker with lifetimes. We rejected lifetimes for the rest of the language; we reject them here too.
- **No closure-based iteration as the primary API.** `break` / `continue` ergonomics drive this.
- **No new global lifetime rules.** The only escape rule is the existing closure-capture gate, extended to cover projection-bound names.

## Design

### Core idea — `inout` in return slot is a _binding-yield marker_, not a type

`ref(name) : T` is already a binding-kind modifier on a parameter: the binding refers to caller-side storage. This proposal extends the same modifier into the **top of a return slot**, with two crucial restrictions:

- `inout` in a return slot appears only at the **outermost** position. `ref(T)` is not a type expression — `Option(ref(T))`, `(ref(T), bool)`, `struct(x : ref(T))` are all syntactically rejected.
- A call to a function whose return slot is `ref(T)` produces a **place expression** in C-ABI terms (a `T*`) but a **inout-bindable expression** in the evaluator. It can flow only into one of:
  - The right-hand side of an `ref(name) := expr;` binding form (new local binding kind).
  - The argument slot of another function's `inout` parameter (chaining).
  - An immediate read (`x := f()` where `f()` returns `ref(T)` does an auto-deref-copy, same shape as reading a parameter `inout` binding).
  - An immediate write (`f() = v;` writes through the projection — same as `arr(i) = v;` today via the Index trait).
  - An immediate field access whose own type is `ref(T')` (chaining through nested projections).

The structural restriction means: any path that would smuggle `ref(T)` into a stored binding, a struct field, or a closure capture is a compile error at the construction site. The user can't write `r := some_call()` and have `r` be "an inout reference" — either `some_call()` is auto-derefed (producing a `T` value, copied) or the LHS is the new `ref(name) := ...` binding form.

### The new binding form: `ref(name) := projection_call(...);`

```rust
ref(x) := list.project(pos);
x = (x + i32(1));  // writes through the projection
print(x);          // reads through the projection
```

Semantics are exactly those of an `inout` parameter binding:

- Reads through `x` dereference the projection.
- Writes through `x` write to the projected storage.
- `x` cannot be captured by a closure (existing Phase B gate — `isInout` already wired in).
- `x` cannot be returned as itself (the function has no `inout` return slot; returning `x` is auto-deref into a copy).
- `x` is scoped to its enclosing block; when control leaves the block, the projection ends.

The `ref(name) :=` form is new syntax — added to the parser alongside the existing `name := value` and `(name : Type) = value` forms. The bound variable carries `isInout: true` in the evaluator env, so the existing `inout`-aware codegen (binding lowers to `T*`, reads emit `(*x)`, writes emit `(*x) = v`) applies.

### Projection method on collections

A collection exposes a single projection method:

```rust
project : fn(ref(self) : Self, pos : Position) -> ref(Element);
```

`project` yields a writable borrow of the element at `pos`. Unlike Hylo and Rust, Yo doesn't carry read-only-vs-mutable at the binding level — every binding is read-write by default and `inout` is the only borrow flavor — so there's no `let` / `inout` variant pair to define. A read-only projection in user code is just a `project`-returned `inout`-binding that the body happens not to write through; the compiler doesn't enforce read-only-ness because the underlying value model doesn't either.

If we later add a `in(name) : T` read-only-by-ref modifier (deferred from `plans/MEMORY_SAFETY.md` Open Question 5), the trait can grow a sibling `project_const` method then. For v1 a single `project` covers every use case.

### Updated Iterator protocol — split `advance` and `current`

The iterator yields a value-typed `Position` from `next()`, and the **collection's projection** is what actually hands back the borrow:

```rust
Iterator :: trait(
  Position : Type,
  Collection : Type,
  /// Advance the iterator. Returns the next position, or `.None` when exhausted.
  next : fn(ref(self) : Self) -> Option(Self.Position),
  where(Self.Collection <: Indexable(Self.Position))
);

Indexable :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Element : Type,
    project : fn(ref(self) : Self, pos : Idx) -> ref(Self.Element)
  )
);
```

This shape decouples _what positions exist_ (the iterator's job) from _how to read/write an element at a position_ (the collection's job). Linked-list iterators can have `Position := *(Node(T))` internally (privileged) and project through a node-deref; array iterators have `Position := usize` and project through array indexing. The user never sees either pointer.

The `for` macro lowers `for(coll, x => body)` to:

```rust
{
  iter_var := coll.iter();
  while(runtime(true), {
    pos_var := iter_var.next();
    match(
      pos_var,
      .Some(pos) => {
        ref(x) := coll.project(pos);
        body
      },
      .None => break
    )
  });
}
```

Notice `body` is **lexically inside the while loop** — `break` and `continue` work exactly as they do in a hand-written `while`. There is no closure boundary between the body and the loop, so no escape problem.

### Worked example — `ArrayList(T)`

Privileged stdlib file (`pragma(Pragma.AllowUnsafe);`):

```rust
ArrayListIter :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(
    _coll : ArrayList(T),
    _idx : usize
  )
);
impl(
  forall(T : Type),
  ArrayListIter(T),
  Iterator(
    Position : usize,
    Collection : ArrayList(T),
    next : (fn(ref(self) : Self) -> Option(usize))({
      cond(
        (self._idx >= self._coll.len()) => Option(usize).None,
        true => {
          out := self._idx;
          self._idx = (self._idx + usize(1));
          Option(usize).Some(out)
        }
      )
    })
  )
);
impl(
  forall(T : Type),
  ArrayList(T),
  Indexable(usize)(
    Element : T,
    // Body computes the address of the element; the `ref(T)` return
    // slot tells the call site to receive it as an inout-binding.
    project : (fn(ref(self) : Self, pos : usize) -> ref(T))({
      match(
        self._ptr,
        .Some(p) => unsafe((p &+ pos)),
        .None => panic("ArrayList: empty iterator projection")
      )
    })
  )
);
```

User-side safe code:

```rust
{ ArrayList } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(2));
  list.push(i32(3));
  for(list, (x) => {
    cond(
      (x == i32(2)) => continue,
      (x > i32(10)) => break,
      true => x = (x + i32(10))
    );
  });
});
```

Inside the loop body, `x` is `inout`-bound to the underlying element. Reading copies the value; writing (`x = ...`) goes through to the collection. `break` and `continue` are real loop control — they refer to the `while` the macro generated.

### Codegen sketch

A function whose return slot is `ref(T)`:

```
// signature:
T* iter_project_T(ArrayList_T* self, size_t pos);

// body returns a T* (the address of the projected element).
```

The C ABI of `ref(T)`-return is identical to a raw-pointer return. The evaluator simply tracks the "this is a projection, not a freestanding pointer" attribute and forbids the result from flowing into non-projection contexts.

At the call site:

```rust
ref(x) := coll.project(pos);
//   ^^^ stored as Variable { isInout: true, ... }
//
// Codegen:
//   T* x = ArrayList_project_T(&coll, pos);
//
// Reads of x inside the block lower to (*x).
// Writes of x lower to (*x) = ....
//
// At block exit there is nothing to clean up — the projection is borrowed,
// not owned.
```

### Soundness of `ref(T)` return slots — the flowability rule

The danger case is a function that returns a borrow into its own local storage:

```rust
(fn() -> ref(i32))({
  x := i32(12);
  return x;         // ← would point into the dead call frame
});
```

The language must reject this. We do so with a single structural rule on the return expression — no lifetime inference, no borrow checker, just an AST walk. An expression is **inout-flowable** iff it roots back to an `inout`-bound parameter along a projection-respecting chain:

- **R1.** A name reference is flowable iff its binding has `isInout: true` (an `inout`-typed parameter, or a local declared via `ref(name) := ...`).
- **R2.** `expr.field` is flowable iff `expr` is flowable. (A field-of-borrow is itself a borrow.)
- **R3.** `expr(args)` is flowable iff the callee's return slot is `ref(T)` and every `inout`-typed argument it receives is itself flowable.
- **R4.** `cond` / `match` arms are checked independently — every arm reachable as a return value must be flowable.

The evaluator runs this check on the return expression of every `ref(T)`-returning function, AND on the RHS of every `ref(name) := expr;` local binding. The same predicate covers both because in both positions we are creating an `inout`-bindable handle that must point at live storage.

Worked verdicts on the four canonical cases:

```rust
// (1) Local return — reject.
(fn() -> ref(i32))({
  x := i32(12);
  return x;        // R1: x.isInout = false → reject
});

// (2) Field of local — reject.
(fn() -> ref(i32))({
  x := SomeStruct(a : i32(12));
  return x.a;      // R2 needs x flowable; x is local → reject
});

// (3) Inout parameter — accept.
(fn(ref(x) : i32) -> ref(i32))({
  return x;        // R1: x.isInout = true → accept
});

// (4) Field of inout parameter — accept.
(fn(ref(p) : Point) -> ref(i32))({
  return p.x;      // R2: p flowable → accept
});
```

Mixed / chained cases the same rule handles without further machinery:

```rust
// Local copy breaks the chain.
(fn(ref(p) : Point) -> ref(i32))({
  q := p;          // q : Point — auto-deref-copy; q.isInout = false
  return q.x;      // R2 needs q flowable; q is a local → reject
});

// Projection rooted in a local — rejected at the inout-binding site.
(fn() -> ref(i32))({
  list := ArrayList(i32).new();
  ref(r) := list.project(usize(0));  // R3: list is local → reject HERE
  return r;
});

// Chain through an inout-bound local — accept.
(fn(ref(p) : Point) -> ref(i32))({
  ref(r) := p.x;   // R2: p flowable → r is inout-bound and flowable
  return r;          // R1: r.isInout, initializer flowable → accept
});

// Two inout parameters, conditional choice — accept (both arms flowable).
(fn(ref(p) : Point, ref(q) : Point, use_p : bool) -> ref(i32))(
  cond(
    use_p => return p.x,
    true  => return q.x
  )
);

// One arm flowable, the other not — REJECT (every reachable arm must pass).
(fn(ref(p) : Point, fallback : i32) -> ref(i32))(
  cond(
    p.x > i32(0) => return p.x,    // R2: flowable
    true         => return fallback // R1: fallback.isInout = false → reject
  )
);

// Method call on inout receiver — accept (method's return is inout, self is flowable).
impl(Point,
  get_x : (fn(ref(self) : Self) -> ref(i32))(self.x)
);
(fn(ref(p) : Point) -> ref(i32))(
  p.get_x()  // R3: get_x returns ref(i32); its inout-self arg = p (R1) → accept
);

// Chained projection — each link in the call graph re-validates.
get_inner :: (fn(ref(p) : Outer) -> ref(Inner))(p.inner);
get_x     :: (fn(ref(i) : Inner) -> ref(i32))(i.x);
(fn(ref(p) : Outer) -> ref(i32))(
  get_x(get_inner(p))  // R3: inner call is flowable (R1 on p); outer call is R3 on the result
);

// Generic projection over a collection — flowability is generic-agnostic.
get_first :: (forall(T : Type), fn(ref(arr) : ArrayList(T)) -> ref(T))(
  arr.project(usize(0))  // R3: project returns ref(T); arg = arr (R1) → accept
);

// for-loop write-through (the canonical user-facing pattern).
for(list, (x) => {
  x = (x + i32(1));  // x is inout-bound by the macro; assignment writes through
});

// ref(name) := from a function returning a value — REJECT at the binding.
fetch_value :: (fn() -> i32)(i32(42));
(fn() -> unit)({
  ref(r) := fetch_value();  // RHS has type i32 (not ref(i32)) → reject
});

// Aliasing two inout params is permitted by the language but produces
// confusing semantics — the call site can pass the same address twice.
// We surface this as a runtime / audit concern rather than a structural
// rule, matching Swift's "law of exclusivity" approach in spirit but
// without compile-time enforcement.
swap :: (fn(ref(a) : i32, ref(b) : i32) -> unit)({
  tmp := a;
  a = b;
  b = tmp;
});
main :: (fn() -> unit)({
  x := i32(1);
  swap(x, x);   // a and b alias x — `a = b` then `b = tmp` collapses to no-op
});
```

**Why the rule is sound.** By induction on the projection chain: every flowable expression's root is an `inout`-typed parameter, which by definition points at storage in _some active caller frame above the current one_. The flowable chain only navigates through fields and projection calls that stay inside that root storage — never into local allocations, never out via a let-binding that copies the value. Therefore the returned borrow refers to storage that is alive at least as long as the call that produced it.

**What the rule does NOT prevent.** Structural mutation of the underlying collection between projection and use — push/clear/realloc — can still invalidate the borrow. That's the same audit obligation as today's pointer-iterator stdlib, identical to C++'s "don't invalidate your iterators" convention and to Rust's runtime story for `RefCell`. Documented in the trait contract, fuzzed in CI, not proven by the type system.

**What the rule explicitly forbids.** Rebinding an `inout`-bound local — `ref(r) := new_projection` after `ref(r)` is already declared — is not in v1. Each `ref(name) := expr;` is a fresh binding; reassigning the binding (as opposed to writing _through_ it via `r = newValue`) is rejected. This keeps the soundness argument from having to reason about mutating origins.

### Other structural guarantees (summary)

In addition to the flowability rule above, the language enforces:

- `ref(T)` cannot appear inside any other type expression — guaranteed by parsing `ref(T)` only at the top of a return slot or a parameter slot. So `Option(ref(T))`, `struct(x : ref(T))`, `(ref(T), bool)`, generic args holding `ref(T)`, etc. all reject at parse time.
- An `inout`-bound binding (parameter or `ref(name) := ...` local) cannot be captured by a closure — already enforced by the Phase B gate from `plans/MEMORY_SAFETY.md` (`Cannot capture inout parameter 'x' in a closure`). The same `isInout: true` flag covers both binding sources.
- An `inout`-bound local cannot escape into a non-`inout` stored binding — `r := inout_bound_local` auto-derefs (`r : T`); there is no `inout` value-type for `r` to be.
- An `inout`-bound local cannot be returned from a function unless the function's return slot is `ref(T)` AND the expression satisfies the flowability rule.

Net effect: every `inout`-bound binding visible in user code traces back to an `inout`-typed parameter, which traces back to caller-side storage. The structural rules are strictly weaker than Rust's borrow checker — a determined user can still invalidate a borrow by structurally mutating the underlying collection mid-iteration. The audit story owns that gap, same as the rest of `plans/MEMORY_SAFETY.md`.

### Why this composes — the `Option(ref(T))` non-problem

Because `ref(T)` is forbidden inside type expressions, `Option(ref(T))` literally doesn't parse. The iterator's `next()` returns `Option(Position)` where `Position` is a value type (typically `usize` or a small struct); the projection is a _separate call_ on the collection. Refs never flow through `Option`, `Result`, struct fields, generic args, or any other compositional surface — the language never has to reason about "where can this `ref(T)` end up".

This is the same answer Hylo gives: borrows are binding kinds, not value-type kinds. The asymmetry between "appears in signatures" and "doesn't appear in value-type expressions" is the entire point.

### Why split `next` and `project` (vs. `next` directly yielding)

Three reasons:

1. **Composition with `Position` value types** — letting iterators yield value-typed positions means iterator combinators (`map`, `filter`, `zip`, `enumerate`, `take`, …) can be written entirely in safe code without ever touching a projection. The projection only happens when the consumer (the `for` macro or a user call) actually needs the element. This matters because chained iterators are the killer ergonomic of the API.

2. **Reusable positions** — random-access collections can hand the same `Position` value to multiple `project` calls. A user might write `for(list.indices(), i => { print(list(i)); list(i) = list(i) * i32(2); })` and have both reads and writes go through the same index protocol with no extra trait machinery.

3. **Avoids a coroutine/generator transform** — making `next()` itself yield a borrow inline would require the iterator's body to "pause" between yields, which is essentially a coroutine. Splitting `next` and `project` keeps both methods as ordinary functions.

The cost is one extra method call per iteration step. With cross-function inlining the C compiler will collapse the projection call into the loop body in practice; even without inlining the overhead is one pointer-arithmetic plus a function call per element, which is comparable to the current pointer-iterator cost.

## Phases

### Phase A — Parser & evaluator support for `ref(T)` return slot ✅

Landed. Scope of what shipped:

- **Parser** — `function.ts` recognises `-> ref(T)` (after the existing `comptime` / `unquote` / labeled-return unwrapping). Unwraps `ref(T)` to evaluate `T` as the underlying type and sets `isReturnTypeRef = true`. Outside the return-slot position the keyword `ref` is not recognised — `Option(ref(T))`, `struct(x : ref(T))`, `(ref(T), bool)`, and `fn(p : ref(T)) -> ...` all surface as "Variable 'ref' not found" via normal identifier resolution. (A more targeted diagnostic is a future refinement; the structural impossibility is what matters for soundness.)
- **Type system** — `FunctionReturn` carries a new `isRef?: boolean` field. The function's return _type_ stays as `T` (the underlying type); `isRef` records the binding-yield marker as a separate flag, never leaking into the type universe.
- **Codegen — signature** — `generateFunctionPrototype` emits `T*` as the C return type when `return.isRef` is set. The same machinery that emits `T*` for `ref(name) : T` parameters covers this.
- **Codegen — body (minimal)** — for the simple pass-through case where the function body is a `ref`-bound parameter atom (e.g. `(fn(ref(p) : i32) -> ref(i32))(p)`), the function-body emit in `generation.ts` suppresses the standard inout deref so the emitted return is `return p;` (matching the `T*` signature) instead of `return (*p);`. More complex flowable expressions (field access, projection chains) are Phase B work — they need the flowability check and a more general place-expression lowering.
- **Tests** — `tests/ref_return.test.yo`: four `comptime_expect_error` negatives (`ref(T)` in param type, in `Option(...)`, in a tuple, in a struct field) plus a positive parse-and-compile test for `(fn(ref(p) : T) -> ref(T))(p)`.

Deferred to Phase B:

- The full **flowability rule** on return expressions (cond/match arms, projection chains, field access).
- **Call-site auto-deref** — calling `f()` where `f` returns `ref(T)` should yield a `T` value via `(*call())` in value contexts. Tied to the temp-variable-type story; will land alongside the `ref(name) := ...` binding form so both contexts can be lowered consistently.
- A more targeted **diagnostic** when `ref(T)` appears outside the return slot.

### Phase B — `ref(name) := expr;` local binding form (parser-side ✅; codegen ☐)

Parser + evaluator landed:

- `ref(name) := expr;` recognized in `src/evaluator/exprs/initialization-assignment.ts`. Wraps the lhs identifier in a `ref(...)` call; the evaluator unwraps it to the inner name and flags the bound variable with `isRef: true` (same flag used for `ref(name) : T` parameter bindings).
- `ref(name) := ...` is rejected when combined with `::` or in a comptime-only context (borrows are runtime constructs only).
- The existing Phase B closure-capture gate from `plans/MEMORY_SAFETY.md` already fires on any binding with `isRef: true`, so the ref-binding inherits the no-escape rule for free.
- Codegen side (`src/codegen/exprs/initialization-assignment.ts`): the lhs is unwrapped for emission; the binding's C-declared type uses `T*` when `isRef` is set on the variable (matching the existing `ref(name) : T` parameter ABI).

Tests landed in `tests/ref_local_binding.test.yo`:

- `comptime_expect_error` negatives for `ref(r) :: ...` (with `::`), and for closure-capture of a ref-bound local.
- Positive smoke test that regular `:=` bindings still compile cleanly (no false positives).

**End-to-end codegen for ref-returning calls (landed in the same commit as the parser side ✅):**

- `attachTempVariableToExpr` in `src/expr.ts` grows an optional `isRef` parameter. The function-call evaluator passes `true` when the called function's return slot has `isRef`, so the temp variable holding the call result gets `isRef: true` in its env entry.
- The temp's declaration in `src/codegen/exprs/other-fn-call.ts` checks `functionValueType.return.isRef` and appends `*` to the C declared type — so `int32_t _temp = fn_call(...)` becomes `int32_t* _temp = fn_call(...)`, matching the actual C return type.
- Atom reads of the temp variable use the existing ref-aware atom emitter (which keys off `isRef`) to produce `(*_temp)` in value contexts — same code path as `ref`-bound parameter reads. So `y := identity(x);` becomes `int32_t y = (*_temp);` in the C output, with the deref happening exactly once at the read site.
- `ref(name) := call(...)` flows the raw `T*` through both variables (call's temp and binding's local), each declared `T*`. Subsequent reads and writes through `name` go through the same `(*name)` lowering as `ref(name) : T` parameters.

**Flowability rule (landed in the same commit as Phase C readiness):**

- `src/evaluator/types/flowability.ts`: a single `isFlowableExpr(expr)` helper implements R1–R4. It unwraps outer `begin(...)` wrappers (single-expression bodies appear post-eval as `begin((expr))`) before applying the recursive rule.
- `src/evaluator/exprs/initialization-assignment.ts`: runs `isFlowableExpr` on the RHS of every `ref(name) := X;` binding. Non-flowable RHS yields a targeted error listing what counts as flowable.
- `src/evaluator/values/anonymous-function.ts` and `src/evaluator/calls/function-type.ts`: both function-body evaluation paths (inline lambda + top-level `(fn(...) -> ref(T))(body)`) run the check on the body's final expression, unwrapping begin blocks. The error points at the offending sub-expression.

### Phase C — `Indexable(Idx)` trait + collection impls ✅

Landed:

- `Indexable(Idx)` trait declared in `std/prelude.yo` alongside `Index(Idx)`. The `project` method returns `ref(Element)` instead of `*(Element)`. Single method only (no read-only variant — see Open Question 1).
- `Indexable(usize)` impls for `Array(T, N)`, `Slice(T)`, `ArrayList(T)`, and `String`. Bodies wrap the existing pointer-arithmetic builtins (`__yo_array_index`, `__yo_slice_index`, `ArrayList` pointer arithmetic, `&(bytes(pos))`) in `unsafe(...)`. The flowability rule treats `unsafe(...)` as the trusted escape hatch from R1–R4 since the Phase C privilege gate already restricts `unsafe` to pragma'd files.
- Flowability rule also accepts `panic(...)` and any expression with `controlFlow` set (return/unwind/break/continue) as vacuously flowable — those paths never actually yield a value.
- Body type-check accommodates `-> ref(T)` functions by treating the body's expected type as `*(T)` (the C-ABI shape the body actually produces). `panic` inside a `-> ref(T)` function yields `*(T)` so it slots cleanly into `match`/`cond` arms whose other arms produce a `*(T)` borrow.
- Tests in `tests/indexable.test.yo` cover all four collections: read through a `ref`-bound projection returns the underlying element, write through the projection propagates to the collection.

Possible cleanup:

- Verifying the existing `Index(usize)` trait can be expressed as a thin wrapper over `Indexable(usize).project`.

### Phase D — Iterator-protocol migration

- Update the `Iterator` trait declaration to add `Position` and `Collection` associated types and the new `where Collection <: Indexable(Position)` constraint.
- Migrate every stdlib iterator (`ArrayIterPtr`, `SliceIterPtr`, `ArrayListIter`, `HashMapIter`, …) to yield positions instead of `*(T)`. Drop the legacy `*IterPtr` types from the public surface (move to `_ArrayIterPos`-style internal names).
- The `for` macro in `std/prelude.yo` changes its expansion to insert the `ref(x) := coll.project(pos);` binding between the `next()` call and the body.

### Phase E — User-facing migration

- `public-safe-report` lint catches any remaining `*(T)`-yielding iterator on the public surface.
- Update existing tests that destructured `*(T)` iterators (the for-macro change is transparent for callers that already used `for(coll, x => body)`; only direct `.next()` consumers need updating).
- Update `docs/{en-US,zh-CN}/DESIGN.md` iteration section.

## Alternatives Considered

### A. Callback-style (`iter.each((x) => body)`)

Rejected. `break` and `continue` inside the closure body can't refer to the outer loop (the closure is a separate function value; the Phase B closure-capture gate would reject any attempt to smuggle the outer loop's continuation in via a captured variable). Working around this with algebraic effects (`unwind` to break, `return` to continue) is technically possible but adds ceremony at every for-loop and exposes the effect machinery to user code. Discarded.

### B. Value iteration with `T <: Clone`

Rejected. Forces `T` to be Clone-able for _every_ iteration, which is fine for primitives (zero cost) and `object` types (RC dup, often elided) but unacceptable for large value structs (per-iteration memcpy). Also doesn't address in-place mutation — assignments to the loop variable wouldn't propagate back. Useful as a **secondary** API (`iter_values()`) but not the primary.

### C. Hide projections inside the `for` macro only (no projection method exposed)

Considered. The for-macro's expansion would directly emit pointer-arithmetic code generated from a knowledge of the iterator's concrete type. Rejected because (a) it requires the macro to special-case every collection type, (b) it makes `iter.skip(5)` / `iter.map(f)` / etc. impossible to write in user code without the macro, and (c) it pushes complexity from the type system into the macro layer where it's much harder to inspect or extend.

### D. `&(T)` first-class reference type + transient-storage rule

Considered. Make `&(T)` a real type but enforce that any value whose type transitively contains `&(T)` cannot be stored in a let-binding or struct field (i.e., must flow as a place expression). This is the closest to a borrow-checker-lite design. Rejected for v1 because it requires the evaluator to recursively walk type expressions for the "contains-&(T)" predicate, with knock-on effects on generic substitution, trait constraints, and impl matching. The projection design here gets the same iteration ergonomics without the type-system depth.

### E. Coroutine `yield` inside `next()`

Considered (Hylo-style). Make `next()` itself yield a borrow inline:

```rust
next : fn(ref(self) : Self) yields ref(Item)
```

with a `yield expr` form in the body that pauses and returns control to the caller. Rejected because it requires the codegen to lower `next` into a coroutine — either CPS-transform the body or generate a state machine. Yo already has the state-machine machinery (async/await uses it), so this is technically achievable, but the implementation cost dwarfs the projection approach for marginal additional ergonomics.

## Open Questions

1. **Read-only projections.** Deferred until `in(name) : T` (read-only-by-ref parameter modifier — see `plans/MEMORY_SAFETY.md` Open Question 5) lands. Until then, all projections yield read-write `inout`-bindings; user code that only reads through the binding pays no actual cost (the C-ABI return is a pointer either way, and Yo's evaluator doesn't insert any extra reads on bind).

2. **`String` iteration semantics.** `String`'s elements are bytes, but most users want `rune` iteration. Two iterators (`bytes()` / `chars()`) or one? Lean: two, matching Rust.

3. **HashMap key/value tuple iteration.** Current API yields `IterPair(K, V)` by value. Migration target: yield positions whose projection returns a tuple of `(ref(K), ref(V))`? Tuple-of-inouts is a corner case for the structural rule — `(ref(K), ref(V))` is a tuple-type containing `inout`, which the rule rejects. The workaround is to projection-return a single value of type `struct(key : K, value : V)` and let the user destructure inside the loop, OR special-case the for-macro to handle two projections in parallel. Open.

4. **Interaction with effect-typed `ctl` bodies.** A `ctl(...) -> R` function can `unwind` out of an `ref(x) := projection_call(...);` block. What happens to the projection? Lean: nothing — the projection has no destructor, it just dangles when the call frame is gone, which is fine because nothing was holding a reference to it after unwind.

5. **Generic combinators.** `IteratorChain :: struct(it : I)` where `I <: Iterator` — how does `IteratorChain.next()` thread the `Position` and `Collection` associated types? Lean: associated-type passthrough, same shape as how `Result(T, E).map` threads `E`. May need experimentation.

6. **Match destructuring of `inout`-bound values.** If `opt` is inout-bound and we write `match(opt, .Some(x) => ..., .None => ...)`, should `x` inherit `isInout` (so the body can write through it to caller storage) or be a fresh value-copy? Conservative answer for v1: fresh value-copy (current Yo behavior). Future refinement: a `match(opt, .Some(ref(x)) => ...)` form that explicitly opts into inout-binding for the destructured payload. Defer until a real use case demands it.

7. **Returning `Slice(T)` from a function whose argument is an `ref(Collection)`.** A function `(fn(ref(arr) : ArrayList(i32)) -> Slice(i32))(arr.as_slice())` returns a `Slice(i32)` whose internal pointer roots in `arr`'s storage — semantically identical to an `inout`-return but escaping the flowability check (because the user-visible return type is `Slice(i32)`, not `ref(i32)`). This is the pre-existing "dangling slice" hole from `plans/MEMORY_SAFETY.md` (see "Known Limitations"). The iterator redesign doesn't introduce the hole and doesn't close it; the right fix is either (a) extend flowability to "any type whose internal representation transitively contains `*(T)` must be flowable when returned", or (b) accept the hole and rely on AddressSanitizer at runtime. Decision deferred until we have a concrete user-visible failure mode.

## Status

- ✅ Design sketched (this document).
- ✅ Phase A — `ref(T)` return slot parsing + signature codegen (minimal body).
- ✅ Phase B — parser + binding form + end-to-end ref-call codegen + flowability rule all landed.
- ✅ Phase C — Indexable trait + Array/Slice/ArrayList/String impls landed.
- ☐ Phase D — Iterator protocol migration.
- ☐ Phase E — User-facing migration + lint pass.

## References

- Hylo's subscript and projection design: <https://www.hylo-lang.org/> — particularly the discussion of `let` and `inout` subscript variants and the binding-kind-vs-type-kind distinction.
- Swift's `inout` parameter convention — closest existing language analogue to Yo's `inout` (param-only modifier, lowered to pointer at the ABI).
- Mutable Value Semantics (Racordon, Abrahams) — the broader research line that motivates Hylo's design.
