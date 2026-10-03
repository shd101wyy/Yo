# Values by default: sharing is visible in the type

**Status: BACKLOG. Direction approved by the user 2026-10-03; this plan is out
for review, no phase started.**

- Builds on [`plans/STRING_VALUE_SEMANTICS.md`](../STRING_VALUE_SEMANTICS.md),
  which is in progress.
- Absorbs `issues/retired/collections-value-or-reference-semantics.md` (decided) and
  its `std/imm/` note.
- No backward compatibility is kept (AGENTS.md). The goal is the right
  language, and every user, `std/` and `src/` site migrates.

---

## 1. The goal

**A copy of any value is independent, unless the value's type contains an
`Rc` or an `Arc`.** Aliasing exists only where a sharing wrapper is spelled
out. `ref(...)` and `atomic(...)` leave the language: every declared type is
a value.

Today the rule is per type, and invisible at the use site:

```rust
Bag :: struct(n : i32, items : ArrayList(i32));
q := p;                 // p : Bag
q.n = i32(2);           // p.n unchanged: the struct is a value
q.items.push(i32(7));   // p.items changed: ArrayList is ref(struct(...))
```

## 2. What `ref` does today

Counts are declarations, measured on develop 2026-10-03.

| Construct | std | src | tests |
| --- | --- | --- | --- |
| `ref(struct(...))` | 39 | 55 | 360 |
| `ref(enum(...))` | 1 | 44 | 56 |
| `atomic(ref(struct(...)))` | 14 | 7 | 31 |
| `atomic(ref(enum(...)))` | 0 | 3 | 4 |

It does three different jobs:

1. **Data containers:** `ArrayList`, `Deque`, `BTreeMap`, `LinkedList`,
   `PriorityQueue`, `HeaderMap`, `ImmString`. These become copy-on-write
   values (§3.1).
2. **Indirection for recursion:** a recursive type needs a pointer to itself.
   This is mostly `ref(enum)`, for example the compiler's trees.
3. **Identity and resources:** `Mutex`, `RawMutex`, `Cond`, `Barrier`,
   `Semaphore`, `WaitGroup`, `Once`, `Channel`/`Sender`/`Receiver`,
   `JoinHandle`, `ThreadPool`, `Waker`, `Arena`, `Atomic*`, `BufReader`,
   `BufWriter`, `Stdin`/`Stdout`/`Stderr`, `ChildStdin`/`ChildStdout`/
   `ChildStderr`, `Rng`. A copy of a mutex must not be a second mutex.

Each job gets its own principled replacement.

## 3. The design

### 3.1 Every declared type is a value

`struct(...)`, `enum(...)` and `newtype(...)` declare values, and nothing
else does. A value that owns heap data (`String`, the collections, `Box`)
copies it lazily with copy-on-write: a copy shares the buffer, and the first
write to a shared buffer clones it. The uniqueness step is the
`STRING_VALUE_SEMANTICS` S3 helper, generalized.

### 3.2 Three wrappers carry indirection and sharing

| Wrapper | Meaning | Copies | Threads |
| --- | --- | --- | --- |
| **`Box(T)`** | heap indirection, a **value** (Swift's `indirect`, Rust's `Box`) | independent (copy-on-write) | as `T` (§3.6) |
| **`Rc(T)`** | **shared**, mutable, one thread | alias: a write is seen through every copy | not `Send` |
| **`Arc(T)`** | **shared** across threads, atomically counted | alias | `Send` when `T` is `Send`; mutation through `Mutex`/atomics inside |

- **`Box` changes meaning.** Today's `Box` is a shared cell (its prelude
  docs: "Sharing is silent"). That role becomes `Rc`. `Box` becomes the value
  indirection a recursive type uses:
  `Expr :: enum(Num(i32), Add(Box(Expr), Box(Expr)))`. A copy of an `Expr`
  tree is independent, and a write into it clones only the path it touches.
- **`Rc`** is the one way to say "these copies are the same object" on one
  thread. Graph nodes, a shared context, an observer list.
- **`Arc`** is the only atomically counted thing in the language.
  `atomic(...)` disappears.
- **Layout.** `Box(V)`, `Rc(V)` and `Arc(V)` are each one heap allocation
  holding `V` inline, the same layout a `ref(struct)` has today. Moving to
  wrappers costs no allocation and no indirection.

### 3.3 Auto-dereference

Explicit sharing must not mean writing `.*` everywhere. Today `b.x` on a
`Box(P)` is E0406 ("No field `x` on Box(P). Its fields: *"); you have to
write `b.*.x`.

- A `Deref` trait (implemented by `Box`, `Rc`, `Arc`) lets `w.field` and
  `w.method(...)` reach the inner value when `w`'s own type has no such
  member.
- **Resolution order.** The wrapper's own members come first (`rc.clone()`
  is the wrapper's), then the inner value's. `w.*` still names the inner
  value explicitly. Ambiguity is an error with the same shape as E0616.
- **Writes through `Box`** are copy-on-write. Writes through `Rc`/`Arc` reach
  the shared object.

### 3.4 Identity and resources are move-only values

A resource (a lock, a socket, a file, a thread handle) is neither a value
that copies nor a reference that silently aliases. **It is a value that
cannot be copied.**

- A type marked **move-only** cannot be copied implicitly. A use that is
  not its last use is a compile error, extending the existing E0901
  "use of moved value" tracking, with a fix-it to move it (`own(...)`),
  pass it `inout`, or share it through `Rc`/`Arc`.
- To share a resource you spell it out: `Arc(Mutex(T))`, `Rc(Channel(T))`.
  That is the idiom agents already know from Rust.
- **`Dispose` requires move-only.** It runs once, when the single owner goes
  away. That is the honest form of today's `Dispose where(Self <: Rc)`, which
  exists to stop a copy from disposing twice. Rust has the same rule:
  `Drop` types are not `Copy`.
- How move-only is spelled is open for review (§7): a marker trait the user
  implements, or a type modifier.

Move-only is **not** optional, and it is not "later". Without it, a resource
has no copy-safe home for `Dispose` once `ref(struct)` is gone. A value
wrapping a private `Rc` would be a handle whose copies alias without the type
saying so, the hidden aliasing this plan removes.

### 3.5 The heap primitive stays private

`Box`, `Rc` and `Arc` are implemented in `std` on a heap-cell primitive: one
allocation with an RC header, today's `ref(struct((*) : V))`. The primitive
is not user-facing. It is available only to the prelude, as a builtin or
behind a std-only pragma, and is decided in V1. User code has no way to
declare a reference type except by wrapping a value in `Rc`/`Arc`.

### 3.6 Traits: delete `Rc`, re-scope `Dispose` and `Trace`

- **The `Rc` marker trait is deleted.** It is registered for every
  `ref(struct)` (`src/evaluator/types/utils.yo:147`) and has three uses:
  - marking reference types: there are none any more;
  - gating `Dispose`: `Dispose` now requires move-only (§3.4);
  - gating `Trace`: cycles can only run through `Rc`/`Arc` cells, so `Trace`
    is implemented by any type, and the cell primitive wires the payload's
    `trace` into its header's `traverse_fn`.

  That frees the name for the `Rc(T)` wrapper. About 30 std, 40 src, 34 test
  and 20 doc mentions migrate.
- **`Acyclic`** keeps its meaning. A type with no `Rc`/`Arc` reachable is
  acyclic by construction, which most types now are.
- **`Send`.**
  - `Rc` is not `Send`. `Arc(T)` is `Send` when `T` is.
  - A value holding non-atomic copy-on-write buffers (`String`, the
    collections, `Box`) crosses threads by move, with the existing `rc == 1`
    isolation check, or by an explicit deep copy. Never by a copy that would
    share a non-atomic count between threads.

### 3.7 What gets simpler

- **The verifier.** Aliasing exists only through `Rc`/`Arc`, so everything
  else is a pure value. `requires(distinct(a, b))` (#1107) and most frame
  reasoning go away, and the list encoding (`seq_of`, `old(xs)`) becomes
  exactly true.
- **The cycle collector.** Only `Rc`/`Arc` cells can form cycles. Values,
  `Box` trees and the collections are never tracked.
- **Agent-written code.** Action at a distance needs an `Rc`/`Arc` in a
  type, and the vocabulary (`Box`, `Rc`, `Arc`, `Arc(Mutex(T))`) is the one
  models already know.

### 3.8 `std/imm/`

`std/imm/` (`string`, `list`, `vec`, `map`, `set`, `sorted_map`,
`sorted_set`) is today's immutable, atomically counted family. Once the
plain types are copy-on-write values, immutability protects nothing within a
thread. Sharing one buffer across threads is `Arc(T)` over the value type.
**Recommendation: delete `std/imm/`** in V5, once `Arc` gives read access
without copying the inner handle. A copy would touch the inner value's
non-atomic count from several threads. In this repo `std/imm` is used almost
only by its own tests; the one std importer is `std/encoding/utf8`.

## 4. Order and prerequisites

1. **`STRING_VALUE_SEMANTICS` (in progress).** It builds the shared
   machinery:
   - E0908 on `inout` writes through a borrowed value, judged by the callee's
     mutation mask;
   - the count-accuracy guarantee (S2);
   - the copy-on-write uniqueness step (S3).
2. **This plan's phases (§5).** The collections' move to values is phase V2
   here. It is no longer a separate campaign.

## 5. Phases

Each phase is one PR, or a stack with one battery, gated by:
- check src/std, the fixpoint, gates_fast, the fast suite and the hollow
  sweep;
- for a phase that changes a hot type, `check ./src` time and stage-2 RSS
  before and after, with the memory ratchet re-baselined past ±10 %.

- **V0: decisions from review.** Resolve §7, and amend this document.
- **V1: wrappers and auto-dereference.**
  - Introduce the private heap primitive.
  - Re-implement today's shared `Box` as `Rc(T)`, and add `Arc(T)` on the
    same primitive if today's `Arc` differs.
  - Add `Box(T)` as a copy-on-write value indirection.
  - Add the `Deref` trait and resolution (§3.3).
  - Delete the `Rc` marker trait, renaming nothing else.
  - Every current `Box` use migrates to `Rc` unless it is recursion, which
    goes to `Box`.
  - No `ref` removal yet.
- **V2: collections become values.**
  - `ArrayList`, `HashMap`, `HashSet`, `Deque`, `BTreeMap`, `LinkedList`,
    `PriorityQueue` and `HeaderMap` become `struct`s over a copy-on-write
    buffer.
  - E0908 now covers them too (they become value aggregates).
  - Migrate `src/`, where a container held in two places on purpose becomes
    `Rc(ArrayList(T))`, and `std/`. The E0908 audit mode lists the sites.
- **V3: move-only and `Dispose`.**
  - The move-only marker and its checking, extending E0901.
  - `Dispose` requires move-only.
  - Migrate the resource types (§2 job 3) to move-only values. Their call
    sites share through `Rc`/`Arc` explicitly.
- **V4: recursion.** `ref(enum)` trees in `src/` (44) and tests become value
  enums with `Box` children. Measure the compiler, since this touches its
  hottest types.
- **V5: remove `ref(...)` and `atomic(...)` from the language.**
  - Remove them from the parser, the evaluator and codegen's
    reference-type paths.
  - Migrate the remaining `ref(struct)` sites, mostly `src/` context objects
    (to `Rc(...)`) and about 360 test declarations.
  - Delete `std/imm/` (§3.8).
  - Update DESIGN, MEMORY_SAFETY, PARALLELISM/THREAD_SAFETY, CYCLE_COLLECTION,
    the pack and the skills, in en-US and zh-CN.

**Seed gate.** Every phase that changes `std/` must be lowerable by the
seed. V1 adds no syntax. V5 removes syntax, so `std/` stops using `ref`
before the parser drops it, and the parser change lands only once
`SEED_VERSION` carries the std that no longer needs `ref`.

## 6. Risks

- **Performance.**
  - A copy-on-write uniqueness check sits on every write to a `String`,
    collection or `Box`.
  - A clone happens on the first write to a shared buffer.
  - The compiler's hot trees move from `ref(enum)` to `Box` children.

  Measured per phase, with a stop if `check ./src` regresses past the
  ratchet.
- **Count accuracy is semantic.** A count that reads 1 with two live handles
  turns a copy-on-write write into a leak through a supposedly independent
  copy. `STRING_VALUE_SEMANTICS` S2 is the guard, extended to every
  copy-on-write type.
- **Migration size.** About 100 src, 54 std and about 450 test declarations,
  plus every `Box` and resource use site. Phased so each step is reviewable,
  with the E0908 audit mode and the E0901 extension as the tools that find
  sites.
- **Auto-dereference ambiguity.** The resolution order of §3.3 has to be
  airtight for method calls through `Rc` and `Arc`.

## 7. Open questions for review

1. **Names.** `Box` (value indirection), `Rc` (shared) and `Arc` (shared,
   atomic) follow Rust. Is reusing `Box` with value semantics clearer than a
   new name such as `Indirect(T)`? Rust's `Box` is uniquely owned, which a
   copy-on-write `Box` matches observably.
2. **The move-only spelling.** A marker trait (`impl(T, MoveOnly)`), a
   modifier (`move(struct(...))`), or derived from `impl(T, Dispose)`?
3. **Explicit copies of move-only values.** Is `clone()` allowed for
   resources that can be duplicated (a `Sender`)? Or does sharing always go
   through `Rc`/`Arc`?
4. **Mutation through `Rc`.** Yo has no borrow checker, so a write through
   `Rc(T)` is a plain write to shared state, like Swift classes. Is that
   acceptable, or should `Rc(T)` be read-only, with mutation through
   `Rc(Cell(T))`/`Rc(RefCell(T))`?
5. **`Arc` reads.** How `Arc(T)` hands out read access without copying the
   inner handle: a borrowed view, or the auto-dereference path, never a copy.
6. **Should the heap primitive be visible** in `unsafe` / `pragma(AllowUnsafe)`
   code for advanced data structures, or only to the prelude?
