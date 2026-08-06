# Future Direction: Origin-Based References `&(T, R)`

> **Status: speculative, not planned.** Preserved for future reference. Yo's current memory-safety story is [`MEMORY_SAFETY.md`](../MEMORY_SAFETY.md) (`unsafe(...)` marker) plus `object` / `Iso(T)` / `Arc(T)`. This document explores what a compile-time-checked borrow system would look like _if_ user demand later justifies the implementation cost. Do not implement without explicit go-ahead.
>
> Decision rationale: the design here is essentially "Rust lifetimes wearing Yo's clothes" — same expressiveness, same complexity, same LLM failure modes. The committed `unsafe(...)` marker plus Yo's existing RC infrastructure provides Zig-level practical safety at a fraction of the implementation and cognitive cost. Revisit if real-world Yo code accumulates patterns that the current setup can't express cleanly.

## Goal

Add a compile-time-checked reference type `&(T, R)` where `R` is an **Origin** — a new kind of comptime parameter alongside `Type`, `usize`, etc. Origins make borrowing precise enough to handle multi-ref returns and library APIs, while staying uniform with Yo's existing parameter system (no `'a` special syntax). Together with [`unsafe(...)`](../MEMORY_SAFETY.md), `object`, and `Iso(T)`, this delivers Rust-level UAF safety without Rust's syntactic surface.

The pitch: **"Origins are just comptime parameters. `forall(R : Origin)` brings one into scope, `&(T, R)` uses it, `where(R1 < R2)` constrains it. No new syntactic category."**

## Prerequisite

Builds on [`MEMORY_SAFETY.md`](../MEMORY_SAFETY.md). Raw pointers (`*(T)`) remain for FFI, stdlib internals, and performance hot paths; `&(T, R)` is layered on top, not a replacement. Cast `*(T)` → `&(T, R)` is an `unsafe(...)` operation.

## Non-Goals

- **No `&!` (mut) vs `&` (immut) split.** Single-threaded code doesn't need aliasing-XOR-mutation. Cross-thread is `Iso(T)` / `Arc(T)`'s job.
- **No path uniqueness check** (the old `ae`-branch Rule 1.1).
- **No `borrow {...}` block.** Redundant under Origin tracking.
- **No linear or general affine types.** `Iso(T)` already provides targeted affinity for transfer/one-shot use cases; a system-wide rule would be redundant.
- **`object` is not removed.** It narrows in role (cycles, unknown-lifetime sharing, cross-thread) but stays the default for those use cases.

---

## Design

### Origin Is a Comptime Parameter Kind

Yo already has comptime parameter kinds: `Type`, `usize`, etc. Origin is a new one:

```rust
foo :: (fn(forall(T : Type, R : Origin), x : &(T, R)) -> &(T, R))(x);
```

- `R : Origin` brings an origin variable into scope.
- `&(T, R)` is the reference type — two type-constructor arguments: the pointee type and the origin.
- `forall(...)`, `where(...)`, and call-site type application work for Origin exactly as for `Type`.

There is **no special syntax for origins** beyond using them in `forall` and `&(T, R)`. They are first-class comptime parameters.

### Origin Values

| Value            | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `Origin.Static`  | Outlives everything; used for global/static data         |
| Fresh origin var | Each `forall(R : Origin)` introduces a fresh variable    |
| Inferred origin  | The placeholder `_` in `&(T, _)` — compiler infers       |
| Anonymous local  | Each begin-block has an unnamed origin; not user-namable |

The compiler internally generates one anonymous origin per begin-block (or finer scope). These cannot be named directly — they appear in error messages by location ("origin of the begin-block at file.yo:42").

### Constraints

Origins support a subset relation. `where(R1 < R2)` means **R1 ⊂ R2**, i.e. R1 lives inside R2, i.e. R2 outlives R1. This matches mathematical intuition (smaller scope < bigger scope).

| Constraint           | Meaning                                            |
| -------------------- | -------------------------------------------------- |
| `R1 < R2`            | R1 is contained in R2 (R2 outlives R1)             |
| `R1 == R2`           | Same origin                                        |
| `R == Origin.Static` | R is the static (unbounded) origin                 |
| `Origin.Static < R`  | Vacuously false — nothing strictly outlives Static |

These appear in `where(...)` clauses, parallel to trait constraints.

### Construction and Dereference

```rust
x := i32(42);
r := &(x);              // r : &(i32, _) — origin inferred to be the enclosing scope
r.*                     // read; safe (no unsafe wrap)
r.* = i32(99);          // write; safe
r.field                 // auto-deref on field access (only matters for ref-to-struct)
```

`&(expr)` produces a `&(T, R)` whose origin is determined by `expr`:

| Form              | Origin of `&(expr)`                               |
| ----------------- | ------------------------------------------------- |
| `&(local)`        | Origin of the begin-block where `local` was bound |
| `&(param)`        | The parameter's declared origin                   |
| `&(r.field)`      | Same origin as `r`                                |
| `&(struct.field)` | Same origin as `struct`                           |
| `&(arr(i))`       | Same origin as `arr`                              |
| `&(f(args))`      | Computed from `f`'s return-origin signature       |

### Elision Rules

Most signatures don't need explicit origins. The compiler elides them following these rules (close to Rust's, adapted to Yo):

1. **Each elided input ref gets a fresh origin.** `(fn(x : &(i32), y : &(i32)) -> ...)` becomes `(fn(forall(R1 : Origin, R2 : Origin), x : &(i32, R1), y : &(i32, R2)) -> ...)`.

2. **Single input ref → output borrows it.** `(fn(x : &(T)) -> &(U))` becomes `(fn(forall(R : Origin), x : &(T, R)) -> &(U, R))`.

3. **Method with `&(Self)` receiver → output borrows from self.** `(fn(self : &(Self), other : &(T)) -> &(U))` becomes `(fn(forall(Rself : Origin, Rother : Origin), self : &(Self, Rself), other : &(T, Rother)) -> &(U, Rself))`.

4. **Otherwise: explicit origins required.** Multi-ref returns without a `&(Self)` receiver must annotate. The compiler emits a clear error pointing at the ambiguous return type.

If the user wants different elision behavior, they write explicit `forall(R : Origin)` and use it. Elision is **always overridable** by being explicit.

### Inference: Which Types Are Second-Class

A type is **second-class** if it transitively contains a `&(T, R)` for any R. Inferred automatically from struct/enum field types — no annotation. Same recursive rule as the earlier proposal:

- `&(T, R)` itself is second-class.
- A struct/enum is second-class iff any field type is second-class.
- `Option(&(T, R))`, `Result(&(T, R), E)`, tuples — propagate automatically.

Second-class values carry the **narrowest** origin of any contained `&(_, R)` — the type-level scope of the whole value. The constraint becomes: a second-class value bound in scope `S` requires `S < R` for every `R` it transitively contains.

### Which Type Constructors Can Hold a Second-Class Argument

| Type constructor                              | Accepts second-class T? | Reason                                  |
| --------------------------------------------- | ----------------------- | --------------------------------------- |
| `Option(T)`, `Result(T, E)`, tuples, structs  | yes (inferred)          | Propagates through fields               |
| `Array(T, N)`                                 | yes (inferred)          | Stack-allocated, fixed size             |
| `Slice(T)`                                    | yes (inferred)          | Fat pointer; non-owning view            |
| `*(T)`                                        | yes (inferred)          | Pointer to a ref is well-defined (rare) |
| `ArrayList(T)`, `HashMap(K, V)`, `HashSet(T)` | **no**                  | Heap-allocated, growable                |
| `Box(T)`                                      | **no**                  | Heap-allocated owner                    |
| `object`                                      | **no**                  | Heap-allocated, RC                      |
| `Iso(T)`, `Arc(T)`                            | **no**                  | Heap-allocated, transferable            |

Heap-allocated containers carry an implicit `where(!(T <: SecondClass))`. User-defined `object` types get this for free — the compiler refuses to define a second-class `object`.

### Closures and Captures

A closure capturing a `&(T, R)` is itself second-class with origin R. It cannot be stored in a heap container or returned past R's scope. Most iterator combinators are fine because closures are consumed immediately.

### `object` Stays — Role Narrows

`object` is the right tool when origins can't help:

- **Cyclic graphs** (trees with parents, doubly-linked structures) — origins require strict ordering; cycles need RC + cycle removal.
- **Unknown-lifetime sharing** — factory returns a value whose final resting place is unknown to the producer.
- **Cross-thread shared state** — via `Arc(object)`.
- **Heap escape** for large values.

`object` and `&(T, R)` compose: `&(MyObject, R)` borrows an RC handle cheaply for scoped operations without dup/drop traffic.

### `Iso(T)` Stays — Role Unchanged

`Iso(T)` provides affine, transferable ownership. It's the right tool for one-shot resources, ownership transfer (including across threads), and cases where you specifically need linearity. Origins don't subsume `Iso` — they're complementary.

---

## Why This Is Memory-Safe

1. Every `&(T, R)` has an origin R that bounds its referent's lifetime.
2. Every binding/field/return of a second-class value must satisfy `binding-scope < R` for every R it contains (the constraint solver enforces this).
3. Returned refs must use origins that are either parameter-introduced or `Origin.Static`. Locals' anonymous origins cannot appear in return types.
4. Therefore every `r.*` reads memory live within R.

This is single-threaded UAF safety, achieved with Origins instead of lifetime annotations. Cross-thread races are still `Iso(T)` / `Arc(T)`'s concern.

---

## Iterators Under Origins

Current (`*(T)`-based) iterator:

```rust
ArrayListIterPtr :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(
    _list : ArrayList(T),        // RC handle keeps storage alive
    _index : usize
  )
);
```

After migration. The iterator becomes generic over Origin:

```rust
ArrayListIterPtr :: (fn(comptime(T) : Type, comptime(R) : Origin) -> comptime(Type))(
  struct(
    _list : &(ArrayList(T), R),  // borrowed view at origin R
    _index : usize
  )
);

impl(
  forall(T : Type, R : Origin),
  ArrayListIterPtr(T, R),
  Iterator(
    Item : &(T, R),
    next : (fn(self : &(Self)) -> Option(&(T, R)))(
      cond(
        (self._index >= self._list._length) => .None,
        true => {
          r := self._list.get_ref(self._index);
          self._index = (self._index + usize(1));
          .Some(r)
        }
      )
    )
  )
);

impl(
  forall(T : Type),
  ArrayList(T),
  iter : (fn(forall(R : Origin), self : &(Self, R)) -> ArrayListIterPtr(T, R))(
    ArrayListIterPtr(T, R)(_list : self, _index : usize(0))
  )
);
```

Caller side stays clean — origins are elided:

```rust
main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(2));
  for(list.iter(), (r) => {
    printf("%d\n", r.*);          // r : &(i32, R); R is list's origin (elided)
  });
});
```

Why this typechecks: `list`'s scope is the enclosing begin-block (call it `S`). `list.iter()` returns `ArrayListIterPtr(i32, S)`. The iterator binding `for` introduces lives in `S` too. Constraint `S < S` is trivially satisfied.

---

## Standard Library Migration

Same shape as the earlier draft, now expressed with origins:

1. **Public APIs returning `*(T)` for borrow-style access** → return `&(T)` (elided origin = single input ref) or `&(T, R)` (explicit).
2. **Iterator structs** holding `_list : ArrayList(T)` → hold `_list : &(ArrayList(T), R)` parameterized by Origin.
3. Internal `unsafe(...)` wraps from Phase 1 (the `MEMORY_SAFETY.md` plan) remain for raw memory access.

Scope unchanged from the earlier draft: ~50–80 method signatures, mostly mechanical.

---

## Implementation Phases

### Phase 1 — Type system: Origins as comptime parameters

- [ ] Add `Origin` as a new comptime parameter kind alongside `Type`, `usize`, etc. (`src/types/`).
- [ ] Parse `R : Origin` in `forall(...)` clauses.
- [ ] Parse `&(T, R)` as a two-arg type constructor. The single-arg form `&(T)` desugars to `&(T, _)` with an elision placeholder.
- [ ] Add `Origin.Static` as a built-in well-known origin.
- [ ] Parse origin constraints in `where(...)`: `R1 < R2`, `R1 == R2`, `R == Origin.Static`.

### Phase 2 — Origin inference & constraint solver

- [ ] At type-check time, every begin-block introduces an anonymous origin.
- [ ] `&(expr)` expressions compute their origin from `expr` per the table above.
- [ ] Function signatures with elided origins get fresh variables; elision rules 1–3 apply.
- [ ] Build a constraint set per scope: subset/equality relations among origins.
- [ ] Solve constraints by union-find + reachability over the begin-block scope tree.
- [ ] Reject programs whose constraint set is unsatisfiable, with an error that names both sides ("origin of `r` at file:line cannot be contained in the origin of `local_x` at file:line").

### Phase 3 — Breaking change: `&(x)` semantics

- [ ] `&(x)` now produces `&(T, R)` (not `*(T)`). The old behavior is recovered by `*(T)(&(x))` — an address-cast that's a safe operation.
- [ ] Stdlib sweep: every `&(x)` used as a pointer needs the cast.
- [ ] Test sweep: same.

### Phase 4 — Second-class inference & heap container constraints

- [ ] Implement `isSecondClass(T) : bool` via structural recursion through struct/enum field types.
- [ ] Reject `object` definitions with second-class fields (compile error at definition site).
- [ ] Add `where(!(T <: SecondClass))` to built-in heap containers: `ArrayList`, `HashMap`, `HashSet`, `Box`, `Iso`, `Arc`.
- [ ] Stack-allocated types (`Array(T, N)`, `Slice(T)`, tuples) need no constraint — they propagate by inference.

### Phase 5 — Iterator trait migration

- [ ] Update `Iterator` / `IntoIterator` in `std/prelude.yo` to permit `Item : &(T, R)`.
- [ ] Add `get_ref(self : &(Self, R), i : usize) -> &(T, R)` on collections; existing `get` (returning `Option(T)` by value) unchanged.
- [ ] Migrate every `*IterPtr` to be `Origin`-parameterized.
- [ ] Verify the `for` macro expansion still works.

### Phase 6 — Stdlib safe-boundary sweep

- [ ] Replace `*(T)` with `&(T)` (elided) in public method signatures where the pointer is non-owning and bounded by the call. Caller-side `unsafe(...)` wraps disappear.
- [ ] Keep `*(T)` for OS-buffer APIs, C FFI, allocator primitives.
- [ ] Run full test suite; expect mechanical fixes from the `&(x)` semantic change.

### Phase 7 — Tests & docs

- [ ] `tests/origins.test.yo` — positive (safe borrows compile) and negative (constraint violations rejected).
- [ ] `tests/origins_iterators.test.yo` — iterator migration end-to-end.
- [ ] `tests/origins_elision.test.yo` — verify elision rules 1–3 and the "explicit required" fallback.
- [ ] Update `docs/{en-US,zh-CN}/DESIGN.md` and add `docs/{en-US,zh-CN}/MEMORY_SAFETY.md`.
- [ ] Update `.github/instructions/yo-syntax.instructions.md`, `yo-design.instructions.md`.
- [ ] Update `.github/skills/yo-syntax/syntax-cheatsheet.md` and `yo-core-patterns/core-patterns-cheatsheet.md`.

---

## Open Questions

1. **Subset direction.** `R1 < R2` chosen to mean **R1 ⊂ R2** (R2 outlives R1). Mathematical-intuition-friendly. Rust users will read it backward; documentation should call this out explicitly with a "differs from Rust" note.

2. **Origin equality vs subset.** Do we need a way to express `R1 == R2`, or is `(R1 < R2) && (R2 < R1)` adequate? Lean: provide `==` as syntactic sugar; the solver can normalize.

3. **Multi-output ref returns.** A function returning a tuple of refs, each from a different parameter, must annotate explicitly: `(fn(forall(R1 : Origin, R2 : Origin), a : &(T, R1), b : &(U, R2)) -> (&(T, R1), &(U, R2)))`. Verbose but unambiguous. No elision available.

4. **Origins in struct definitions.** A struct that holds a `&(T, R)` needs R as a comptime parameter: `MyView :: (fn(comptime(T) : Type, comptime(R) : Origin) -> comptime(Type))(struct(field : &(T, R)));`. Verbose at definition; less verbose at use thanks to elision. Acceptable but worth example coverage in docs.

5. **`Origin.Static` enforcement.** A `&(T, Origin.Static)` requires the referent to be statically allocated. For now, only literal globals and `static` declarations satisfy. `Origin.Static` is not constructible from regular code (you can't widen a borrowed origin to Static).

6. **Deref ergonomics.** Same options as before: explicit `.*` only, auto-deref for `.field`/`.method`, or full auto-deref. Recommend auto-deref for field/method access (matches what Yo already does for `*(T)`).

7. **Method origin elision for `&(Self)` receivers.** Rule 3 says outputs borrow from self. But what about a method with `&(Self)` and another `&(T)` parameter where the output should borrow from the _other_ parameter? Currently: explicit annotation required. Acceptable for v1; revisit if real APIs demand a more sophisticated default.

8. **Error message quality.** Origin solver errors are notoriously hard to read in Rust. Yo errors must point at:

   - Where each origin was introduced (begin-block start, parameter declaration).
   - Where the constraint was emitted (the assignment/return that requires the relation).
   - What relation was needed (`R1 < R2`) and what was inferred (incompatible).
     Worked examples in `docs/MEMORY_SAFETY.md`.

9. **Comptime generic interactions.** `forall(T : Type)` combined with `forall(R : Origin)` should compose cleanly. Specialization on origins is unusual — most uses just plumb origins through. The evaluator should treat origin parameters like other comptime parameters in specialization.

10. **`recur` and origins.** `recur(args)` should preserve origin annotations consistent with the enclosing function's signature. Mechanical, but needs a test.

---

## Examples

### Single-ref input/output (elision)

```rust
identity :: (fn(x : &(i32)) -> &(i32))(x);

main :: (fn() -> unit)({
  v := i32(42);
  r := identity(&(v));
  assert((r.* == i32(42)), "identity");
});
```

Elided to `(fn(forall(R : Origin), x : &(i32, R)) -> &(i32, R))`.

### Multi-ref input, return borrows from one (explicit)

```rust
longest :: (fn(
  forall(R : Origin),
  a : &(str, R),
  b : &(str, R)
) -> &(str, R))(
  cond(
    (a.length() >= b.length()) => a,
    true => b
  )
);

main :: (fn() -> unit)({
  s1 := `hello`;
  s2 := `world!`;
  r := longest(&(s1), &(s2));     // both s1, s2 share enclosing scope
  printf("%s\n", r);
});
```

### Iterator that borrows the source

```rust
impl(
  forall(T : Type),
  ArrayList(T),
  iter : (fn(forall(R : Origin), self : &(Self, R)) -> ArrayListIterPtr(T, R))(
    ArrayListIterPtr(T, R)(_list : self, _index : usize(0))
  )
);

// Caller uses elision throughout:
main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  total := i32(0);
  for(list.iter(), (r) => {
    total = (total + r.*);
  });
  assert((total == i32(1)), "sum");
});
```

### Returning a ref to a local (rejected)

```rust
// error: origin of return type cannot be the anonymous origin of begin-block at file.yo:N.
//        Return an owned value, or accept the source as a parameter.
bad :: (fn() -> &(i32))({
  local_x := i32(42);
  &(local_x)
});
```

### Object cannot hold a ref (rejected at type-definition time)

```rust
// error: object types cannot contain second-class fields.
//        Field 'parent : &(TreeNode, R)' makes 'object TreeNode' second-class,
//        which is incompatible with heap allocation.
TreeNode :: object(
  count : i32,
  parent : &(TreeNode)
);
```

Use the RC pattern instead:

```rust
TreeNode :: object(
  count : i32,
  parent : Option(TreeNode)         // RC handle, cycles handled by cycle removal
);
```

### Static origin for global data

```rust
GLOBAL_NAME :: "yo";

get_name :: (fn() -> &(str, Origin.Static))(
  &(GLOBAL_NAME)
);
```

### Object + borrow composition

```rust
process :: (fn(forall(R : Origin), node : &(TreeNode, R)) -> i32)(
  (node.count + i32(1))
);

main :: (fn() -> unit)({
  root := TreeNode(count : i32(10), parent : .None);
  result := process(&(root));        // borrow the RC handle, no dup/drop
  printf("%d\n", result);
});
```

### Multi-input method, explicit output origin

```rust
impl(
  Config,
  pick_section : (fn(
    forall(Rself : Origin, Rname : Origin),
    self : &(Self, Rself),
    name : &(str, Rname)
  ) -> &(Section, Rself))(
    self.sections.find(name).unwrap()
  )
);
```

Output borrows from `self`, not from `name`. Without the explicit annotation the elision rule (single-`&(Self)` method ⇒ output gets self's origin) handles this — but spelling it out is sometimes clearer.

---

## Alternatives Considered

The exhaustive list is in [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md#alternatives-considered). Specific to origins:

### Rust-style `'a` syntax

Rejected: not uniform with Yo's existing comptime parameter system. `forall(R : Origin)` is exactly parallel to `forall(T : Type)` — adding `'a` would be a new syntactic category for no extra power.

### Pure scope-bounded inference (no named origins)

The previous draft of this doc. Rejected: can't express multi-ref returns precisely, forces conservative narrowest-scope inference that over-rejects valid programs.

### Linear / general affine types

Rejected: `Iso(T)` already provides targeted affinity for transfer/one-shot cases. A global affine rule would be redundant and would add "use after move" errors that are notoriously confusing.

### Removing `object`

Considered. Rejected: `object` handles cyclic graphs, unknown-lifetime sharing, and cross-thread sharing — none of which origins can express. Origins narrow `object`'s role (no more "default for any shared data") but don't replace it.

---

## What This Does Not Solve

- **Data races across threads.** `Iso(T)` / `Arc(T)` / `Send` — see `plans/ARC_TYPE.md`.
- **Out-of-bounds reads.** `ArrayList.get` is bounds-checked; pointer arithmetic stays `unsafe(...)`.
- **Logic errors involving live data.** Memory safety only prevents UB.
- **Resource leaks** (FDs, sockets) — `object` + `___drop`. Orthogonal.

---

## Status

**Speculative, not planned.** See the banner at the top.

If revisited, three decisions would gate Phase 1:

1. **`&(x)` semantic break in Phase 3** — would recommend yes if pre-1.0 still.
2. **Subset direction for `R1 < R2`** — would recommend `R1 ⊂ R2` (R2 outlives R1). Documentation would need to flag the "opposite of Rust" reading.
3. **Deref ergonomics** — explicit `.*` only, or auto-deref for `.field`/`.method` (would recommend auto-deref, matching `*(T)`).

Triggers that would justify reopening this design:

- Repeated user complaints about RC overhead in iterator-heavy code that can't be elided by ownership analysis.
- Real Yo programs accumulating UAF-shaped bugs that slip past the `unsafe(...)` audit boundary.
- A user base that materially overlaps with Rust's, where the "no lifetimes" pitch becomes a liability rather than an asset.

None of these are observed yet.
