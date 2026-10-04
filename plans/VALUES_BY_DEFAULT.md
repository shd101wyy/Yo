# Values by default: sharing is visible in the type

**Status: ACTIVE. Direction approved by the maintainer 2026-10-03. Reviewed
2026-10-03 (PR #1153): the inventory was re-measured, the design gaps in §3
were filled, and §6 is the implementation and migration plan. V0 is done:
the maintainer confirmed the ten decisions of §4 as written on 2026-10-03
(#1155 added §3.10). Amended 2026-10-03 with the maintainer: the wrapper
constructors `box`/`rc`/`arc` and the count reader's rename to `ref_count`
(§3.2, decision 11, V1 step 0), explicit allocators (§3.11, decision 12),
and the constructors' `alloc` parameter in place of `new_in` (the types are
not callable). V1 starts once `plans/STRING_VALUE_SEMANTICS.md` S1–S3 have landed.
Amended 2026-10-03: §3.13 (async) added and confirmed by the maintainer,
with decisions 13 (move-only futures) and 14 (second-class borrowing
futures).
Amended 2026-10-05 with the maintainer: **unique ownership (Hylo's model)
replaces copy-on-write** (§0). Decisions 15–18 there are confirmed; 19–21
are proposed.**

- Builds on [`plans/STRING_VALUE_SEMANTICS.md`](STRING_VALUE_SEMANTICS.md),
  which is in progress (S1, the E0908 extension, on
  `feat/value-copy-dead-write-warning`).
- Absorbs `issues/retired/collections-value-or-reference-semantics.md`
  (decided) and its `std/imm/` note.
- No backward compatibility is kept (AGENTS.md). The goal is the right
  language, and every user, `std/` and `src/` site migrates.
- Supersedes, once V5 lands: `plans/reference/REF_REFERENCE_SEMANTICS.md`
  (the `ref(...)`/`atomic(...)` constructors) and the Rust-`Rc` note in
  `std/prelude.yo`'s `Box` docs. `plans/reference/ARC_TYPE.md` stays true in
  substance (`Arc` keeps its layout, bound and deref) and gets a banner.

---

## 0. Amendment 2026-10-05: unique ownership replaces copy-on-write

**Direction approved by the maintainer 2026-10-05** ("yes lets adopt hylo's
model"). This section overrides every part of §1–§9 that it names. The
superseded text is kept below, under a banner, as the record of what was
decided before. Decisions 16–21 were proposed, each with a
recommendation, final once the maintainer confirms it (§4's
rule: a changed decision is a dated amendment, not a silent edit).
The maintainer confirmed 16, 17 and 18 on 2026-10-05 ("make things in Yo
explicit, like copy in hylo", with owning values only and no local
borrows in the first cut); 19–21 remain proposed.

### 0.1 Why

Copy-on-write puts a reference count on every `String`, collection and
`Box` buffer. That count raised a question this plan could not answer well:
atomic (every buffer pays an atomic increment and `String` becomes `Sync`)
or non-atomic (best single-thread speed, but copies cannot be read from two
threads, so §3.8 needed a transfer-isolation walk that clones shared buffers
at every thread boundary). COW also hides costs: a uniqueness check in every
mutator, and an O(n) clone inside the first write to a shared buffer.

Hylo's model removes the question rather than answering it. **A buffer has
exactly one owner, so it needs no count.** A copy is explicit and eager. A
last use moves. Sharing exists only where `Rc` or `Arc` is spelled out, and
those are the only counted things in the language.

### 0.2 The model

**Three kinds of type**, decided by what a value owns:

| Kind | Which types | A copy is | Example |
| --- | --- | --- | --- |
| **implicitly copyable** | owns no heap memory, has no `Dispose`: integers, floats, `bool`, `rune`, raw pointers, `str` views, and structs, enums, tuples and arrays made only of these | a bitwise copy, as today | `p2 := p` for `p : Point` |
| **explicit-copy** | owns a buffer: `String`, the collections, `Box(T)`, `Dyn(Trait)`, and any type containing one (unless it is move-only) | a **compile error unless it is the value's last use** (then it is a move); an independent copy is spelled `x.clone()`, which is eager and O(n) | `t := s.clone()` |
| **move-only** (§3.4, V3) | `Dispose`, `MoveOnly`, or a move-only field | a compile error unless it is the last use; `clone()` exists only if the type implements `Clone` (`Sender`) | `f2 := f` moves the `File` |

- **Moves are implicit at the last use, and copies are never implicit**
  except for the first kind. `y := x`, passing `x` to a `sink` parameter,
  storing it in a field, element or capture, and returning it are moves when
  `x` is not used afterwards. Otherwise they are E0901 with a note naming
  `x.clone()` (explicit-copy) or `Rc`/`Arc`/`inout` (move-only).
- **Borrowing is the default and is free.** A plain parameter borrows, an
  `inout` parameter is an exclusive borrow, and a `sink` parameter
  (decision 15) consumes. This is Hylo's `let`/`inout`/`sink`; Yo has no
  `set`. Borrows are second-class: they cannot be stored, returned or
  captured, so no lifetimes appear in the language.
- **No buffer is ever shared, so no buffer is ever counted.** `String`'s and
  the collections' buffers are plain allocations owned by their value, like
  Rust's `Vec` and `String`. A mutator writes in place with no uniqueness
  test. `clone()` copies the elements. There is no `make_unique`.
- **`Box(T)` is a uniquely owned heap cell with no count**, like Rust's
  `Box`. A copy is `b.clone()`, a deep copy. A recursive type uses it for
  indirection (`Expr :: enum(Num(i32), Add(Box(Expr), Box(Expr)))`).
- **`Rc(T)` and `Arc(T)` are the only counted cells.** `Rc` is shared and
  mutable on one thread; `Arc` is shared across threads, atomically counted,
  with mutation through `Mutex`/atomics. Whether copying one needs
  `.clone()` is decision 17.
- **`Dyn(Trait)` is a uniquely owned, type-erased cell.** It is
  explicit-copy when the trait or the payload provides `Clone` (a `clone`
  vtable slot), and move-only otherwise. Sharing a trait object is
  `Rc(Dyn(Trait))`.
- **Threads.** `Send` means "may be moved to another thread". A `String`, a
  collection or a `Box` of `Send` values is `Send`: moving it hands over the
  only owner, and there is no count to race on. §3.8's transfer-isolation
  walk is deleted. `Sync` means "copies may be read from several threads".
  A uniquely owned buffer is `Sync` when its elements are, so
  `Arc(ArrayList(T))` and `Arc(String)` become legal read-only sharing, and
  writes still go through `Mutex`/atomics (D3).
- **The cycle collector sees `Rc`/`Arc` cells only.** `Box`, `String` and
  collection buffers are part of their owner's value and are traversed
  inline. Only a cell whose payload reaches an `Rc`/`Arc` is tracked.
- **Allocators.** An explicit `clone()` lands where its source lives,
  through the source's owner. That is today's `ArrayList.clone` rule, and
  it replaces decision 12's COW wording; there is no hidden clone left to
  place. The scope places new cells and buffers as §3.11 says.

Yo differs from Hylo in one deliberate place. Hylo makes every type,
including `Int`, non-copyable by default, with `@implicitcopy` regions as
the escape hatch (`hylo-lang/Documentation`, `val-for-swift-users.md`). Yo
copies the first kind implicitly (decision 16).

### 0.3 Decisions

15. **`own(x)` is renamed `sink(x)`.** Confirmed 2026-10-04: Yo's `own` is
    already linear, consuming the argument binding even when it dups. Gen A
    accepts `sink` in V3; Gen B renames every site and deletes `own`.
16. **Confirmed 2026-10-05: trivially copyable types copy implicitly; every owning value's copy is explicit.** The first row of
    the table above. Recommendation: yes. Requiring `.clone()` on `i32` would
    touch nearly every line of `src/` and buys nothing, because a bitwise
    copy has no hidden cost. The rule is structural (no heap, no `Dispose`),
    so no annotation is needed.
17. **Confirmed 2026-10-05: copying an `Rc`/`Arc` needs `.clone()`.** Recommendation:
    yes, as in Rust. A new handle is a new owner (a count change, a collector
    edge), and §1's promise is that sharing is visible where it is created.
    The cost is churn where `src/` stores context handles (V5 makes ~60
    context objects `Rc`). The §0.4 measurement counts it before V5 is sized.
    If the count is prohibitive, the fallback is implicit `Rc` copies (one
    rule change, no design change).
18. **Confirmed 2026-10-05: no first-class local borrows in the first cut.** A
    projection (`s.items`, `xs(i)`) borrows only in expression position: as
    a method receiver, a plain or `inout` argument, an operand, or a `for`
    source. `y := s.items` is a move, which decision 19 forbids, or an
    explicit copy. Hylo has `let` borrow bindings; Yo can add them later as
    one rule ("a local bound to a projection is a second-class borrow until
    its last use"), measured against the migration.
19. **Proposed: no partial moves.** A field of explicit-copy or move-only
    type cannot be moved out of a value that stays alive. Use
    `x.field.clone()`, a destructuring that moves the whole value
    (`{ a, b } := x`), or the std helpers `take(inout x.field)` (leaves
    `Default`) and `replace(inout x.field, v)`. This is Rust's
    `mem::take`/`mem::replace`, and it keeps every move a move of a whole
    binding, which is what `consumed_at_token` tracks.
20. **Proposed: collection element access by place.**
    - `xs(i)` is a place in every position. Read position borrows the
      element, and the left of `=` or an `inout` receiver writes it, with no
      uniqueness step. §3.1's `Index` split for COW is not needed; the
      `String` byte index stays read-only (S3).
    - `get(i) -> Option(T)` copies, so it exists only when `T` is implicitly
      copyable. Otherwise the per-instantiation check reports it with a note
      naming `xs(i)` or `get_cloned(i)`.
    - Non-copying access for every element type: `with(i, body : Fn(inout(v) : T) -> R)`,
      `take(i)`, `swap(i, j)`, `pop`, `drain`. That is §3.4's list, now
      general.
21. **Proposed: the compiler's large trees use `Rc` children, not `Box`.**
    `TypeValue.clone()` is O(1) today and is called throughout `src/`. With
    `Box` children every clone would be a deep copy. `TypeValue` and
    `AstExpr` are immutable after construction (`AstExpr` rewrites go
    through `ExprInfo.macro_expansion`), so `Rc` children share them
    honestly. The small trees (`Pattern`, `VcSort`, `VcTerm`, `Z3Sexpr`)
    take `Box`. V4 measures `check ./src` time and stage-2 RSS for each.

### 0.4 First gate: measure the migration

Before any phase is resized, an audit counts the copies the new rule turns
into errors. `YO_AUDIT_IMPLICIT_COPY=1` lists every point where the
evaluator inserts a dup (`set_expr_as_needs_to_call_dup` and the parameter,
capture and field-store paths) for a value of the explicit-copy kind whose
source is used again afterwards, so that the copy is not a move. Run it over
`src/`, `std/` and `tests/`, split by type (`String`, each collection,
`Box`, `Dyn`, `Rc`/`Arc` handles for decision 17), and record the numbers
here. The phase sizes below are written without them, on purpose.

### 0.5 What changes, section by section

| Superseded | Becomes |
| --- | --- |
| §1 "A copy of any value is independent" | unchanged in meaning; independence is now by explicit copy, not COW |
| §2 job 1 "These become copy-on-write values" | uniquely owned values, explicit-copy kind |
| §3.1 COW paragraph and the `Index` split | §0.2; decision 20 |
| §3.2 "`Box` … independent (copy-on-write)" and "`Box`'s count is invisible" | `Box` is unique and uncounted with a deep `clone()`; `ref_count` reads only `Rc`/`Arc`, since nothing else has a count |
| §3.3 "Writes through `Box` are copy-on-write" | writes through `Box` are plain writes (unique owner) |
| §3.5 "every copy-on-write buffer" on the cell primitive; "a unique cell skips the uniqueness check" | the cell primitive backs `Rc`/`Arc` only; `Box` and buffers are plain owned allocations; nothing has a uniqueness check |
| §3.6 "copy-on-write cells are `Send` (isolated at the transfer) and not `Sync`" | buffers are `Send` by move and `Sync` when their elements are |
| §3.7 `Dyn` COW and the closures' "captured collection is a copy-on-write value" | `Dyn` unique (explicit-copy or move-only); a closure capture of an explicit-copy value is a move, or an explicit `.clone()` at the capture |
| §3.8 transfer isolation | deleted; `Send` is a move |
| §3.9 `std/imm` "only `Sync` data family" | `Arc(ArrayList(T))` now covers concurrent reads; `std/imm`'s remaining role is persistence (versions sharing structure). It stays; whether that alone justifies 4,300 lines is a later decision |
| §3.11 "A copy-on-write clone lands where its source lives" | "an explicit clone lands where its source lives" (decision 12, amended) |
| decision 1 | `Box` is unique, uncounted, deep `clone`; the V1 rename order is unchanged |
| decision 7 | `Dyn` is unique (explicit-copy with a `Clone` slot, else move-only) |
| decision 8 | `Send` is a move; no isolation walk |
| decision 12 | as §3.11 above |
| §6 V1 `Box.make_unique` and its tests | deleted; the value `Box` has a deep `Clone` |
| §6 V2b "the flip" | V2b: buffers become uniquely owned plain allocations, `clone()` deep; the explicit-copy kind is switched on for `String` and the collections, with the migration §0.4 measured |
| §8 risks "uniqueness check per mutation", "count accuracy is semantic", "collector over-subtraction", "transfer isolation cost", "`Sync` usability" | gone; the new risks are in §0.7 |
| §9 Q11 (atomic COW counts) | **resolved by construction**: no buffer has a count. The maintainer's 2026-10-04 preference (non-atomic, best single-thread speed) is met fully, since a uniquely owned buffer pays nothing |

### 0.6 What survives unchanged

- **V1 Generation A, landed:** step 0 (`ref_count`, the prelude `rc`,
  #1186), the `Rc` marker trait's deletion (#1188), `Deref` and
  auto-dereference (#1191). V1 step 1's mechanical rename of every `Box` to
  `Rc` stands as written; the value `Box` it then introduces is the unique
  one.
- **V2a** (`feat/vbd-v2a-inout-mutators`: collection mutators take
  `inout(self)`, the E0908 audit down to 20 sites): exactly what unique ownership needs.
- **V3** (move-only, `Dispose`, resources, async §3.13) and decision 15
  (`sink`). V3's machinery (move points, `consumed_at_token`, use-after-move
  E0901, flow joins, no partial moves) is built around one predicate,
  "requires an explicit copy", with move-only as its strict case. V2b
  extends that predicate to the explicit-copy kind.
- **§3.10 exclusivity**: value-rooted places need no check, and writes
  through `Rc` assert. **§3.13 async**: futures were already move-only and
  borrowing futures second-class.
- **`STRING_VALUE_SEMANTICS` S1 and S2**, and S3's model-independent part
  (`plans/STRING_VALUE_SEMANTICS.md` §0).

### 0.7 New risks

- **Migration size.** Every implicit copy of a `String` or collection whose
  source lives on becomes an error. §0.4 measures it before the phases are
  sized. Diagnostics and `yo fix` insert `.clone()` where a copy is wanted;
  many sites want a move or a borrow instead, which is the point of looking.
- **Ergonomics without local borrows (decision 18).** Code that binds a
  field to a local to read it twice must clone, or read in place. The
  measurement says how often; `let` borrow bindings are the remedy if needed.
- **Tree clones in the compiler (decision 21).** With `Rc` children,
  `check ./src` time and RSS should stay flat; V4 measures each tree.

### 0.8 Revised order

1. **§0.4 measurement** (one audit PR; numbers recorded here).
2. **V1 step 1**: rename every `Box` to `Rc`, then the unique `Box`.
3. **V3** (in progress): move-only plus `sink`, on the general predicate.
4. **V2b**: unique buffers; the explicit-copy kind is switched on for
   `String` and the collections, with the migration. This absorbs
   `STRING_VALUE_SEMANTICS` S3's dropped COW half.
5. **V4** (trees, decision 21), **V5** (remove `ref`/`atomic`), then the
   `sink` sweep (Gen B) once a seed carries V3.

Generation A/B and the seed gate (§5) apply as before.

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

Counts are declarations, measured on develop 2026-10-03 with a multi-line
aware grep (`grep -Pzo 'ref\(\s*(struct|enum)\('`), then checked by hand.
The first draft of this plan counted single-line matches only and comment
mentions, which gave 55 / 44 for `src/`; the real numbers are below.

| Construct | std | src | tests (language) |
| --- | --- | --- | --- |
| `ref(struct(...))`, non-atomic | 45 | ~195 | ~126 |
| `atomic(ref(struct(...)))` | 22 | 0 | 13 |
| `ref(enum(...))` | 1 (`RegexNode`) | 7 | 10 |
| `atomic(ref(enum(...)))` | 0 | 0 | 1 |
| files touched | 64 | 88 | 68 of 180 (plus 10 cli-case fixtures) |

The seven `ref(enum)` types in `src/` are `TypeValue`
(`src/types/definitions.yo`), `AstExpr` (`src/expr.yo`), `EvalValue`
(`src/value.yo`), `Pattern` (`src/pattern.yo`), `VcSort` and `VcTerm`
(`src/verifier/terms.yo`) and `Z3Sexpr` (`src/verifier/z3.yo`). Of the ~195
`ref(struct)` declarations, about 60 are context objects mutated through
shared handles (`Environment`, `Frame`, `Variable`, `ExprInfo`,
`EvalContext`, `CodeGenContext`, `FunctionGenerationContext`, `Emitter`, the
specialization and comptime-fn caches, `VcCtx`, `BuildRegistry`, …) and the
rest are result records, options and report rows that are never aliased.
`Box(` appears at 56 code sites in `src/` (plus 59 `box(`), 8 in `std/`,
about 665 in tests.

`ref` does three different jobs:

1. **Data containers:** `ArrayList`, `HashMap`, `HashSet`, `Deque`,
   `BTreeMap`, `LinkedList`, `PriorityQueue`, `HeaderMap`, `StringBuilder`,
   `ImmString`. These become copy-on-write values (§3.1, phase V2).
2. **Indirection for recursion:** a recursive type needs a pointer to itself.
   In `src/` this is the seven `ref(enum)` trees; in tests, mostly
   `ref(enum)` too.
3. **Identity and resources:** `Mutex`, `RawMutex`, `RwLock`, `Cond`,
   `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `Channel`/`Sender`/`Receiver`
   (sync and async), `Thread`, `JoinHandle`, `ThreadPool`, `Waker`, `Park`,
   `Arena`, `File`, `TempDir`/`TempFile`, `Watcher`, `TcpStream`/`TcpListener`/
   `UdpSocket`/`UnixStream`/`UnixListener`, `TlsStream`, `HttpClient`,
   `Child`/`ChildStdin`/`ChildStdout`/`ChildStderr`, the RAII guards
   (`__MutexUnlocker`, `__RwLock*Unlocker`, `__SemaphoreReleaser`,
   `__BorrowGuard`, `_ScopeGuard`) and the `std/async` stream adapters
   (`ref(struct(_inner : S, _f : F))`, five of them). A copy of a mutex must
   not be a second mutex.

   Not every handle in this family is a resource. `Stdin`/`Stdout`/`Stderr`
   (`ref(struct(_offset : u64))`, no `Dispose`; `stdout()` mints a fresh
   object per call), `Rng`, `Atomic*`, `HeaderMap`, `Path`, `Url`, `Regex`
   and the parser/compiler scratch objects (`_Parser`, `NfaCompiler`, …)
   have identity today only because `ref(struct)` was the only way to get
   in-place mutation. They become plain values (§3.4).

Each job gets its own principled replacement.

## 3. The design

### 3.1 Every declared type is a value

> **Superseded by §0 (2026-10-05):** buffers are uniquely owned, not copy-on-write; an explicit-copy value copies with `.clone()`; element access is by place (decision 20). The text below is the copy-on-write design it replaces.

`struct(...)`, `enum(...)` and `newtype(...)` declare values, and nothing
else does. A value that owns heap data (`String`, the collections, `Box`)
copies it lazily with copy-on-write: a copy shares the buffer, and the first
write to a shared buffer clones it. The uniqueness step is the
`STRING_VALUE_SEMANTICS` S3 helper, generalized.

A value's mutators take `inout(self)`. Today a collection's `push` takes
`self : Self` and writes through the shared object; under values a write
through a borrowed by-value parameter is E0908 (already the rule for struct
fields holding RC data, extended by S1 to `inout` writes through a borrowed
value). A by-value parameter is the callee's own copy; to change the
caller's value, take `inout`.

**Indexing splits read from write.** `Index.index` returns a place
(`fn(inout(self), idx) -> *(Self.Output)`, `plans/reference/INDEX_TRAIT.md`),
one pointer for both reads and writes. Measured on v0.2.49 (review, yo-88):
`t := s; t(usize(0)) = u8(122)` writes the buffer `s` shares, and on
`String` it lets safe code write arbitrary bytes through the UTF-8
invariant. A read looks like a write to the mutation analysis too, because
the pointer escapes (`ch := s(i)` has mask `all`). For a copy-on-write type
the write path needs the uniqueness step and the read path must not, so the
trait splits, as Swift's subscript `get`/`set` does: a by-value
`get(self, idx) -> Output` in read position, and a place form used only on
the left of `=` or as an `inout` receiver, which runs make-unique first.
`String` keeps read-only byte indexing and loses the byte place (Rust has
no `s[i] = b` either), which closes the UTF-8 hole.

### 3.2 Three wrappers carry indirection and sharing

> **Superseded by §0 (2026-10-05):** `Box` is a uniquely owned, uncounted cell with a deep `clone()`, not copy-on-write; "`Box`'s count is invisible" no longer applies, and `ref_count` reads only `Rc`/`Arc`. Constructors, names and the `alloc` parameter stand.

| Wrapper | Meaning | Copies | Threads |
| --- | --- | --- | --- |
| **`Box(T)`** | heap indirection, a **value** (Swift's `indirect`, Rust's `Box`) | independent (copy-on-write) | as `T` (§3.8) |
| **`Rc(T)`** | **shared**, mutable, one thread | alias: a write is seen through every copy | not `Send` |
| **`Arc(T)`** | **shared** across threads, atomically counted | alias | `Send` and `Sync` when `T` is `Sync`; mutation through `Mutex`/atomics inside |

- **`Box` changes meaning.** Today's `Box` is a shared cell (its prelude
  docs: "Sharing is silent"). That role becomes `Rc`. `Box` becomes the value
  indirection a recursive type uses:
  `Expr :: enum(Num(i32), Add(Box(Expr), Box(Expr)))`. A copy of an `Expr`
  tree is independent, and a write into it clones only the path it touches.
  A `Box` whose payload is move-only (§3.4) is never copied, so it is a
  unique heap cell with a stable address: that is how resources keep an OS
  handle that must not move.
- **`Box`'s count is invisible.** The cell is counted so that a copy is O(1)
  and the first write clones (copy-on-write). The count is an implementation
  detail, not a semantic. No safe program can tell whether two `Box` copies
  share a cell: `ref_count` does not accept a `Box` in safe code, and nothing
  else exposes the cell. Three cheaper designs were considered and rejected:
  - an uncounted `Box` that deep-copies on every implicit copy (O(n) per
    tree copy);
  - a move-only `Box` (every recursive enum turns move-only, so V4 needs
    explicit clones everywhere);
  - Rust's model, which works because borrows cover most uses; safe Yo has
    no first-class borrow (§3.10).

  `Rc` is the one wrapper whose sharing a program can observe.
- **`Rc`** is the one way to say "these copies are the same object" on one
  thread. Graph nodes, a shared context, an observer list, the compiler's
  `Environment`.
- **`Arc`** is the only atomically counted thing in the language.
  `atomic(...)` disappears. `Arc(T)`'s bound becomes
  `where(T <: (Sync, Acyclic))` (§3.8; today's `Send` under its new name).
- **Layout.** `Box(V)`, `Rc(V)` and `Arc(V)` are each one heap allocation
  holding `V` inline behind the RC header, the same layout a `ref(struct)`
  has today. Moving to wrappers costs no allocation and no indirection, and
  `Option(Box(T))`, `Option(Rc(T))`, `Option(Arc(T))` keep the one-pointer
  niche (DESIGN §`Option` of a handle is one pointer).
- **Constructors.** `Box`, `Rc` and `Arc` are types; `box`, `rc` and `arc`
  are their only constructors. They are ordinary prelude functions written
  in Yo (no compiler special case), each moving its argument into a new
  cell, with an optional explicit allocator:

  ```rust
  box :: (fn(generic(T : Type), own(v) : T, (alloc : Option(Allocator)) ?= .None) -> Box(T))(...);
  rc :: (fn(generic(T : Type), own(v) : T, (alloc : Option(Allocator)) ?= .None) -> Rc(T))(...);
  arc :: (fn(generic(T : Type), own(v) : T, (alloc : Option(Allocator)) ?= .None, where(T <: (Sync, Acyclic))) -> Arc(T))(...);

  e := Expr.Add(box(l), box(r));            // T inferred from the argument
  c := rc(node, alloc : .Some(arena.allocator())); // placed in the arena
  ```

  - `T` is inferred from the argument, so a call never spells it; this is
    what the ~1,300 tree-node constructions V4 rewrites rely on. A value
    whose own type is not known spells it at the argument
    (`box(Option(i32).None)`).
  - `alloc : .None` (the default; defaults must be compile-time values)
    means the current `with_allocator` scope, else the global allocator;
    `.Some(a)` places the cell in `a` (§3.11). There is no `new_in` and no
    `box_in`: one function per wrapper. Measured 2026-10-03 on v0.2.49 with
    a pragma'd module declaring the function and a safe caller: both calls
    compile and run. The caller writes `.Some(...)`: Yo does not wrap a `T`
    into `Option(T)` (E0601), and a non-`Option` parameter cannot default to
    `Allocator.global()`, which is not a compile-time value (such a default
    is E1105 since #1165: `issues/fixed/a-default-parameter-value-that-is-not-compile-time-known-emits-invalid-c.md`).
    `Option(Allocator)` in a signature is a raw-pointer-carrying type,
    which the naming gate allows in std (implicitly unsafe-capable) and
    rejects in a safe user file; passing the value needs no pragma, as with
    `new_in` today.
  - **Default parameters resolve names in the defining module** since #1165
    (`issues/fixed/a-default-parameter-value-resolves-names-in-the-callers-module.md`).
    `.None` names nothing, so these constructors were never affected.
  - **The type is not callable outside the prelude.** This is ordinary
    member visibility (DESIGN §member visibility, the `Counter.new`
    pattern), not a builtin: after V5 each wrapper's only field is private,
    so only `std/prelude.yo`, which declares both the type and its
    constructor, may build one:

    ```rust
    Box :: (fn(comptime(V) : Type) -> comptime(Type))(struct(_cell : __yo_cell(V)));
    box :: (fn(generic(T : Type), own(v) : T, (alloc : Option(Allocator)) ?= .None) -> Box(T))(
      Box(T)(_cell : __yo_cell(T)(v, alloc))
    );
    ```

    **The primitive takes the allocator.** `__yo_cell(T)(v, .None)` is
    today's `__yo_rc_alloc_scoped` (the thread's scope, else global: one load
    of `__yo_scopes_ever_entered` in a program that never entered a scope);
    `.Some(a)` is the same helper given `a` as an explicit scope. So
    `box(v)` costs what a `ref` constructor costs today (the `.None` default
    is a compile-time constant, folded once `box` inlines), and
    `box(v, alloc : .Some(a))` pays no scope save/restore, no `_ScopeGuard`
    allocation and no closure. Routing the explicit case through
    `with_allocator(a, () => …)` would add all three to every call.
    During V1–V4, before the primitive exists, the constructors' explicit
    path does go through `with_allocator`; that overhead is confined to
    `alloc : .Some(a)` calls, and a narrow construct-with-scope intrinsic
    can land in V1 if a benchmark asks for it.

    In user code `Box(T)(_cell : …)` is E0405 ("Cannot construct Box
    outside its declaring module"); `__yo_cell` needs
    `pragma(Pragma.AllowUnsafe)` (decision 6). During V1–V4 nothing enforces
    it: the wrapper is still `ref(struct((*) : V))`, whose `*` field is
    public because `b.*` reads it, so `Box(T)(v)` compiles anywhere and the
    rule is documentation only (docs, skills and tests teach `box(...)`).
  - `box` and `arc` exist today without `alloc` (`std/prelude.yo`); `rc` is
    new. Being prelude exports, the three names cannot be bound by user
    code (no shadowing), as `box` already cannot.
  The builtin that reads a cell's count, `rc(x)` today, is renamed
  **`ref_count(x)`**: it reads the count of the cell `x` holds, which is the
  header field of that name. In safe code it accepts only `Rc` and `Arc`,
  the wrappers whose sharing is the point. A `Box`, a collection or `String`
  buffer and a `Dyn` are copy-on-write values whose sharing must stay
  unobservable, so only std and `pragma(Pragma.AllowUnsafe)` code (tests of
  copy-on-write) may read their counts. Yo has no shadowing, so a prelude `rc` claims
  the name in every module: today's 29 locals and parameters named `rc`
  (`rc := flock(...)`, exit codes) are renamed with it. V1 step 0 sequences
  the rename through the seed.

### 3.3 Auto-dereference

Explicit sharing must not mean writing `.*` everywhere. Today `b.x` on a
`Box(P)` is E0406 ("No field `x` on Box(P). Its fields: *"); you have to
write `b.*.x`. `.*` is not special for a struct: `Box :: ref(struct((*) : V))`
declares a field whose label is `*`, and `b.*` is an ordinary field access
(`src/evaluator/exprs/property_access.yo:1683`; `is_box_type` in
`src/types/guards.yo` tests for that label).

**`.*` becomes the payload of a `Deref` type, not a field.** Once V5 gives
the wrappers a private `_cell` (§3.2), there is no field labelled `*` to
read, and `w.*` must keep working in user code. So `w.*` on a type that
implements `Deref` names its payload place (the cell's inline value,
`w->value` in C), the same place auto-dereference forwards to; on a raw
pointer it stays the pointer dereference. The rule lands in V1 next to the
auto-dereference hooks, where it agrees with today's field reading, and V5
is the point where it becomes the only reading. `is_box_type` and the
`*`-label tests move to the `Deref` check then.

- A `Deref` marker trait in the prelude, `Deref :: trait(Target : Type)`,
  implemented by `Box`, `Rc` and `Arc` with `Target := V`. It says "this
  type forwards members to its `*` field"; nothing is called at runtime, and
  for the three wrappers the forwarded place is the inline payload
  (`w->value` in C). It is not implementable by user types in this plan: a
  user wrapper forwards nothing, which keeps every auto-dereference one of
  the three known cells. The check identifies the trait by the prelude
  `Deref`'s key (not its spelling), and accepts an impl only in the prelude
  and in compiler-generated code (V1, `feat/vbd-v1-deref`), so the `Rc`
  wrapper of V1 step 1 gets its impl in the prelude too.
- **Resolution order.** The wrapper's own members come first (`rc.clone()`
  is the wrapper's; a field named `*` is the wrapper's), then the payload's
  members, recursively through nested wrappers (`Rc(Box(T))` reaches `T`).
  `w.*` still names the payload explicitly. A name the wrapper and the
  payload both have resolves to the wrapper's, silently, the way an
  inherent method beats a trait method today; the ambiguity error E0616
  applies only among traits at one level, unchanged. Spelled out (as
  implemented): wrapper field, wrapper method, payload field, payload method,
  at each level. The same order holds in callee position, so `w.items(i)`,
  `w.items(i) = v` and a call of a function-typed payload field `w.f(x)`
  forward when the wrapper has no member of that name.
- **Where it hooks in.** Fields: the label-miss arm of
  `evaluate_property_access` (`property_access.yo:1686-1711`) rewrites
  `w.field` to `w.*.field` when `w`'s type implements `Deref`, and
  re-evaluates it, so codegen sees an ordinary chain. Methods:
  `_try_find_receiver_method` (`src/evaluator/calls/function.yo:632`) retries
  with the receiver replaced by `w.*` when the wrapper has no hit. Pointer
  auto-deref already exists in `get_receiver_methods_by_name_from_env`
  (`src/env.yo:4060`); this generalizes it.
- **Places.** The forwarded member is a place: `rc.n = v` and
  `rc.items.push(x)` (an `inout(self)` method) write the shared payload. The
  D3 rule carries over: in a file without the pragma, no write through an
  `Arc` root (`src/evaluator/exprs/assignment.yo`,
  `throw_if_write_through_atomic_root`), mutation inside an `Arc` goes
  through a `Mutex` or an atomic.
- **Writes through `Box`** (superseded by §0: plain writes, the owner is unique) were copy-on-write: before a field write or an
  `inout(self)` call whose root place passes through a `Box`, the evaluator
  inserts `Box.make_unique(inout b)` (clone the cell when `ref_count(cell) > 1`);
  the same uniqueness step `String` S3 adds by hand to its mutators, made
  automatic for the one prelude type that needs it everywhere.

### 3.4 Identity and resources are move-only values

A resource (a lock, a socket, a file, a thread handle) is neither a value
that copies nor a reference that silently aliases. **It is a value that
cannot be copied.**

- **A type is move-only** iff it implements `Dispose`, or declares
  `impl(T, MoveOnly())`, or has a field, variant payload, tuple element,
  array element or closure capture whose type is move-only. `Box(T)` is
  move-only iff `T` is. `Rc(T)` and `Arc(T)` never are: sharing a resource
  is what they are for. `MoveOnly` is an auto-derived marker exactly like
  `Send` and `Acyclic`: computed in `auto_derive_traits_for_struct_type`
  (`src/evaluator/types/utils.yo`), the on-demand step 4b of
  `type_implements_trait` for generic instantiations, the closure capture
  struct (`_captures_offense`, `src/evaluator/types/closure.yo`), and listed
  in `_marker_name_of`.
- **A copy of a move-only value is a compile error** unless it is the last
  use. A copy is `y := x`, `x` as a by-value argument that the callee keeps,
  storing `x` in a field, element or capture, returning it from a function
  that does not own it. The existing machinery is reused: `set_expr_as_consumed`
  (`src/evaluator/utils.yo:531`) is called where `set_expr_as_needs_to_call_dup`
  is called today, the per-variable `consumed_at_token` and the branch/loop
  flow joins (`merge_and_check_envs`, `check_loop_flow`, E0907
  "moved on some paths") already exist, and the use-after-move error is
  E0901 with a new note: "`x` is move-only (it implements Dispose); move it
  (`own(x)`), pass it `inout`, or share it through `Rc`/`Arc`". New pieces:
  reads in identifier and property evaluation check `consumed_at_token`;
  a field projection of move-only type cannot be copied out (no partial
  moves); closure capture of a move-only variable consumes it
  (`consume_captured_variables` is a stub today); the
  `type_contains_rc_type` gate on E0907 in loops does not apply to
  move-only values.
- **Borrowing is free.** A by-value parameter borrows (no dup at the call,
  `plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md`), so
  `use_file(f)` with `f : File` and `with_lock(m, body)` need no move; `own(f)`
  moves.
- **Generic code is checked per instantiation.** A generic body is re-evaluated
  with concrete bindings at each call (`create_specialized_function_inline`,
  `src/evaluator/calls/helper.yo`), so `ArrayList(File).get(i)`, which copies
  an element out, errors at the instantiation with the std note
  (`_reported_at_user_call`). Collections gain non-copying element access
  for move-only elements: `with(i, body : Fn(inout(v) : T) -> R)`,
  `take(i) -> T` (removes), `swap(i, j)`, `pop`, `drain`. There is no
  `Copy` bound to write: the instantiation check is the rule, and the error
  names the copying call inside std.
- To share a resource you spell it out: `Arc(Mutex(T))`, `Rc(Receiver(T))`.
- **`Dispose` requires move-only**, and is the usual way to be move-only. It
  runs once, when the single owner's drop runs. That is the honest form of
  today's `Dispose where(Self <: Rc)`, which exists to stop a copy from
  disposing twice. Rust has the same rule: `Drop` types are not `Copy`.
- **Explicit copies.** A move-only type may implement `Clone`; `x.clone()`
  is then the explicit copy (`Sender.clone` bumps the senders count today
  and keeps doing so). An implicit copy is never allowed.
- **OS handles do not move.** `pthread_mutex_t` and `CRITICAL_SECTION`
  (`__YO_THREAD_SYNC_TYPE`) must stay at one address after init. A resource
  that owns one is `struct(_cell : Box(State))` with `State` move-only, so
  the cell is unique and never copied: the same allocation `atomic(ref(...))`
  gives it today, without the count. RAII guards hold a raw pointer into the
  cell (`pragma(Pragma.AllowUnsafe)` std code), as `__MutexUnlocker` holds
  the mutex today.

Move-only is **not** optional, and it is not "later". Without it, a resource
has no copy-safe home for `Dispose` once `ref(struct)` is gone. A value
wrapping a private `Rc` would be a handle whose copies alias without the type
saying so, the hidden aliasing this plan removes.

### 3.5 The heap cell is the one primitive, and it is private

> **Superseded by §0 (2026-10-05):** the cell primitive backs `Rc` and `Arc` only. `Box`, `String` and collection buffers are plain allocations owned by their value and traversed inline; no uniqueness check exists anywhere.

`Box`, `Rc`, `Arc` and every copy-on-write buffer are implemented on one
heap-cell primitive: one allocation with the RC header (`__yo_ref_header_t`,
`plans/backlog/RC_HEADER_SPLIT.md`), today's `ref(struct(...))` lowering.
The primitive is `__yo_cell(V)` / `__yo_atomic_cell(V)`, a builtin usable
only in a file with `pragma(Pragma.AllowUnsafe)` (§4 Q6); user code has no
way to declare a reference type except by wrapping a value in `Rc`/`Arc`.

There are two primitives, not one per wrapper: the split is the C count
discipline, which codegen must know statically (today's `is_atomic_rc`).
`__yo_cell` (plain `++`/`--`) backs `Box`, `Rc`, the collection and
`String` buffers and `Dyn`; `__yo_atomic_cell` backs `Arc` and `std/imm`.
`Box(V)` and `Rc(V)` are both `struct(_cell : __yo_cell(V))` and still
distinct types, because structs are nominal (a `B(i32)` is E0601 where an
`A(i32)` of the same shape is expected); their different behaviour, `Box`'s
dup-`Clone` plus `make_unique` before a write versus `Rc`'s shared writes,
is in their impls and the evaluator's write rules (§3.3, §3.10), not in the
cell.

**A cell is a cycle-collector node; a value is not.** This is the rule that
makes copy-on-write and the collector agree:

- Values (structs, enums, tuples, arrays) are traversed inline, as today's
  value structs are. They have no header and are never tracked.
- Every cell (an `Rc`, an `Arc`, a `Box`, a collection's buffer) is one node
  with one count and one `traverse_fn`, visited once per collection. Two
  `ArrayList` values sharing one buffer are two edges to one node, so the
  `Rc(Node)` elements inside are counted once, not twice; if the buffer were
  traversed inline from each copy, trial deletion would over-subtract and
  free live cells.
- **A unique cell skips the uniqueness check.** A write through a `Box`
  (or a collection buffer) runs `make_unique` only when the cell may be
  shared. A `Box` the compiler can prove unique is written in place with no
  count test: one just built, one received `own`, or one past its last
  copy. The dup/drop pair optimizer already removes the count traffic of
  moves and last uses.
- A cell is **tracked** (on the collector's list) only if its payload type
  can reach an `Rc`/`Arc` (`can_type_form_rc_cycle`, walking values inline
  and stopping at atomic cells as today). A `Box(i32)` or an
  `ArrayList(String)` buffer is never tracked.
- `Dispose` and `Trace` for the collections move onto their private buffer
  cell type (`_ArrayBuf(T)`, …), which is move-only. The public `ArrayList(T)`
  is a copyable value with neither: its drop releases the buffer's count, and
  the buffer's dispose frees the elements.

### 3.6 Traits: delete `Rc`, re-scope `Dispose` and `Trace`

- **The `Rc` marker trait is deleted.** It is registered for every
  `ref(struct)`/`ref(enum)` (`src/evaluator/types/utils.yo:147`) and has
  three uses:
  - marking reference types: there are none any more;
  - gating `Dispose`: `Dispose` now requires move-only (§3.4);
  - gating `Trace`: a `trace` is a traversal any type may define
    (hand-written for a buffer cell, auto-derived for values); the cell
    primitive wires the payload's `trace` into its header's `traverse_fn`.

  That frees the name for the `Rc(T)` wrapper. The mentions that migrate
  are `where(Self <: Rc)` in the prelude, the prelude's `Box` note, the
  `Rc` arms in `src/evaluator/trait_checking.yo` and
  `src/evaluator/types/utils.yo`, three test files, and DESIGN,
  MEMORY_SAFETY and CYCLE_COLLECTION in both languages.
- **`Acyclic`** keeps its meaning. A type with no `Rc`/`Arc` reachable is
  acyclic by construction, which most types now are.
- **`Send` and `Sync`** (§3.8): `Rc` is neither. `Arc(T)` is both when
  `T` is `Sync`. A value is `Send` iff every field is; copy-on-write cells
  are `Send` (isolated at the transfer) and not `Sync`. A move-only value
  follows the same rules (a `File` is `Send`; a `Mutex(T)` is `Sync` when
  `T` is `Send`; a `Receiver(T)` moves into a thread).
- **`Isolation` / `Iso(T)` / `^v`.** `Iso(T)` requires a non-atomic
  reference OBJECT today (D2). It becomes: `T` is any value that reaches at
  least one non-atomic cell. The deep `ref_count == 1` walk is unchanged, it
  already walks values inline and stops at atomic cells.
- **Reflection** keeps its names and changes its reading: `Type.contains_rc_type`
  is "reaches a non-atomic cell", `Var.is_owning_the_rc_value` and
  `Var.has_other_aliases` are about the handle a value holds, `ref_count(x)` reads
  the count of the cell `x` directly holds and is a compile error on a value
  with no cell. Safe code may read an `Rc` or an `Arc` only (§3.2).

### 3.7 `Dyn`, closures, async

> **Superseded by §0 (2026-10-05):** `Dyn` is a uniquely owned erased cell (explicit-copy with a `Clone` slot, else move-only); a closure capture of an explicit-copy value is a move or an explicit `.clone()`. Async stands.

- **`Dyn(Trait)` is a value**, a copy-on-write cell like `Box` whose payload
  type is erased (Rust's `Box<dyn Trait>`, Swift's existentials). Today a
  copy retains the shared payload (the vtable's retain/release slots,
  `docs/en-US/DYN_DESIGN.md`), which is the hidden aliasing this plan
  removes. A copy of a `Dyn` dups the cell; a call to an `inout(self)`
  method through a shared cell makes it unique first through a `clone` slot
  in the vtable. That slot exists only when the trait has an `inout(self)`
  method, and then `dyn(v)` requires `T <: Clone` (a static rule at the
  `dyn` site, decided by the trait's shape); a read-only trait needs no
  `Clone`, and sharing its cell is unobservable. A `Dyn` over a move-only
  payload is move-only (containment), so it never copies and needs no slot.
  Sharing a trait object is spelled `Rc(Dyn(Trait))` / `Arc(Dyn(Trait,
  Send))`; `Dyn(Fn(...), Send)` keeps its atomic payload for the thread
  boundary. `dyn(v)` moves `v` into the cell (today's `dyn(box(v))`).
- **Closures** capture by copy (a dup per captured variable,
  `generate_captured_variable_dup_expressions`). A captured collection is a
  copy-on-write value, so a closure that mutates its own capture does not
  change the enclosing variable, matching `for(xs, s => s.push_str("!"))`
  in the `String` plan. A closure capturing a move-only variable moves it
  and is itself move-only (the capture struct derives the marker).
- **Async** tasks hold values in their slots, and futures and
  `JoinHandle`s are move-only. A future that borrows its receiver is
  second-class. The runtime stays single-threaded. §3.13 has the design.

### 3.8 Threads: `Send` by move, `Sync` for sharing

> **Superseded by §0 (2026-10-05):** there is no transfer isolation. `Send` is a move of the only owner; a uniquely owned buffer is `Sync` when its elements are, so `Arc(String)` and `Arc(ArrayList(T))` are legal read-only sharing.

Measured today: `Channel(String)` is E0602 "String does not implement Send".
`String`'s buffer is a non-atomic `ArrayList(u8)`, so neither `String` nor
any collection is `Send`; `Arc(T)`, `Mutex(T)`, `Channel(T)` and
`Thread.spawn` all require `T <: Send`, and today's `Send` means "may be
shared across threads" (atomic cells and plain data). Under values this
plan splits the two notions Rust splits, and names them as Rust does:

- **`Send`: the value may be MOVED to another thread.** A value is `Send`
  iff it reaches no `Rc` and no non-atomic `Dyn`; copy-on-write cells
  (`Box`, the collections' buffers, `String`) do not disqualify it. At a
  transfer point (`Channel.send(own(v))`, a `Thread.spawn` capture, a
  `JoinHandle` result, `spawn_blocking`'s return) the runtime **isolates**
  the moved value: the deep walk `__yo_iso_unique` already performs, except
  that a cell with `ref_count > 1` is cloned instead of failing (the sender
  keeps its copy, the receiver gets a private one, which is exactly what
  value semantics promise). A freshly built message is unique and costs
  one walk; a shared one costs the copy it would have needed anyway. No
  atomics, no failure mode. `Rc` cannot be made unique by copying (sharing
  is its meaning), so it stays non-`Send` statically.
- **`Sync`: copies of the value may be READ from several threads at once.**
  Atomic cells (`Arc`, `Atomic*`, `Mutex`, `std/imm`), plain data, and
  values composed of them. `Arc(T)` requires `T <: Sync`; `Mutex(T)`
  requires `T <: Send` (its payload is moved in and out under the lock) and
  is itself `Sync`. A copy-on-write value is **not** `Sync`: two threads
  holding copies of one buffer would race on its count. So `Arc(String)`
  and `Arc(ArrayList(T))` stay rejected, and `Arc(Mutex(ArrayList(T)))` is
  legal: the list lives behind the lock and is moved in.
- `Iso(T)` / `^v` remain as the explicit "fail if shared" transfer
  (`.None` instead of a clone), for code that must not pay a copy; the
  implicit transfer above subsumes most of its uses and it may retire later.
- **`Arc` reads (Q5) need no new mechanism.** Auto-dereference yields a
  borrowed place, as `a.*` does today (`attach_temp_variable_to_expr(expr,
  false, …)`), and the `Sync` bound on `T` is what makes copying a field out
  safe.

This is a rename of today's `Send` to `Sync` at the `Arc`/`Mutex`/`RwLock`
bounds plus a wider `Send` for the transfer points; D1/D2/D4/D9 of
`PARALLELISM_RULES.md` keep their shape with `Send` read as transfer. It is
§4 decision 8, and it lands in V3 with the marker machinery.

### 3.9 `std/imm/` stays

> **Superseded by §0 (2026-10-05):** `std/imm` is no longer the only `Sync` data family (`Arc(ArrayList(T))` covers concurrent reads); it stays for persistence.

`std/imm/` (`string`, `list`, `vec`, `map`, `set`, `sorted_map`,
`sorted_set`; 4,300 lines, used in this repo only by its own tests and
docs) is the atomically counted, immutable, structurally shared family. Its
two roles after this plan:

- **Shared read access from several threads at once.** It is the only
  `Sync` data family: a copy-on-write `ArrayList` is not `Sync` (§3.8), so a
  table that a thread pool reads concurrently is `Arc(imm.Map(K, V))` or an
  `imm.Map` value directly, and nothing else can play that role without
  atomic counts on every buffer (§9 Q11).
- **Persistence.** An update yields a new version sharing structure with the
  old one (undo stacks, snapshots). Copy-on-write gives independent copies,
  not O(log n) versions; this role is independent of threads.

The first draft recommended deleting it in V5; that rested on
`Arc(ArrayList(T))`, which is rejected today and stays rejected under §3.8.
**Recommendation: keep it.** In V5 its types become values over atomic
cells with the same API, and `ImmString`'s `atomic(ref(...))` goes with the
rest. Deletion becomes reasonable only if Q11 adopts atomic counts for every
buffer (then `Arc(ArrayList(T))` covers the sharing role and persistence
alone does not justify 4,300 lines); that is a later decision with numbers.

### 3.10 Exclusivity: no `RefCell`

Rust's `RefCell` does not guard the write; it guards a borrow that is alive
while the write happens (a `&T` into a `Vec` element outliving a `push`).
Safe Yo has no first-class borrow. A borrow exists in two scoped shapes
only: an `inout` argument for the duration of one call, and a `for` over a
container for the duration of the loop. Everything else is a copy or a
counted handle, which cannot dangle. For those two shapes the check already
exists, in both forms:

- **Statically**, `require_valid_ref_argument_places`
  (`src/types/flowability.yo`) rejects an `inout` place whose root another
  argument or a global could reach, and an aliased projection gets a
  caller-owned +1 for the call (Stage 0/1,
  `issues/fixed/borrowed-arg-invalidated-by-aliased-container-mutation.md`).
- **Dynamically**, every cell header carries `borrow_count`. A borrowed
  `for` or an interior `inout` argument takes it, and a method whose
  mutation mask says it may invalidate storage asserts it is zero at entry
  (`__yo_borrow_assert_unborrowed`, the Law of Exclusivity in
  `src/codegen/functions/generation.yo`). That is `RefCell::borrow_mut`'s
  panic with no annotation: Yo has no `mut`, the body is the signature.

So a plain write through `Rc(T)` (§4 decision 4) is sound: either no borrow
into that cell is live, or the write trips the assert. A `RefCell` type
would add a second flag beside the one the header already has, and a guard
object for borrows Yo never hands out. **There is no `RefCell`.**

Two changes under this plan:

- **The assert moves to the write site.** Today it is emitted at function
  entry for every cell-typed parameter the body may mutate, and it is
  skipped for closures and async state machines, whose C prototypes do not
  carry the parameters: a mutation through a captured handle while a borrow
  into it is live is unchecked. Once sharing is only `Rc`/`Arc`/`Dyn`, every
  write that could invalidate a borrow passes through a visible wrapper
  deref, so the assert is emitted at the write through an `Rc` (a field
  store, an `inout(self)` call, an index place) and nowhere else. That
  covers closures and async uniformly.
- **Value-rooted places need no check.** A place rooted in a value local is
  reachable only through that local, so neither the reachability rule nor
  the assert applies to it; most writes in a program are of this kind, and
  they become free. In V5, when the last `ref(struct)` roots are gone,
  `require_valid_ref_argument_places` keeps only its `Rc`/`Arc`/`Dyn`-rooted
  and module-level-root arms.

### 3.11 Explicit allocators

The landed model (`plans/reference/EXPLICIT_ALLOCATORS.md`) carries over
unchanged: an allocator decides where a block lives, reference counting
decides when it dies, and every free routes through the owner prefix. What
changes is what a block is.

- **The scope reaches cells, and only cells.** A value struct, enum, tuple
  or array allocates nothing, so `with_allocator(a, () => Point(...))`
  places nothing once `Point` is a value (today it places a `ref` struct).
  The scope applies wherever a cell is created: `box`/`rc`/`arc`, a
  collection or `String` buffer (already through `current_allocator()`,
  P3c), a `Dyn` cell, an `Iso` value, an async state machine. After V5 the
  six constructor sites that consult the scope today (`ref` struct and
  enum, `box`/`arc`, `dyn`, `Iso`, async) become the one cell primitive
  (§3.5) plus the async frame.
- **A copy-on-write clone lands where its source lives** (§0: read "an explicit clone"; there is no hidden clone), not in the
  current scope. This covers `Box.make_unique`, every collection's and
  `String`'s uniqueness step, `Dyn`'s clone slot (§3.7) and the transfer
  isolation clone (§3.8). Three reasons:
  - it is today's rule for an explicit copy: `ArrayList.clone` places the
    clone through the source's owner (`std/collections/array_list.yo`,
    Rust's `Vec<T, A>: Clone`), and growth reallocates through the owner;
  - following the scope would make placement observe sharing: after
    `q := p; q.push(x)` in a global scope, `q`'s buffer would move to the
    global heap if `p` is still alive and stay in the arena if `p` had died.
    Copy-on-write must be indistinguishable from an eager copy, and an
    eager copy (`clone`) inherits the owner;
  - `Allocator` is `Send` and the arena locks itself, so a clone made on
    another thread (transfer isolation) can use the source's owner.
- **Consequence for arenas.** A value built in an arena and copied out of
  the scope keeps its cells in the arena until every copy dies, and a write
  to a shared copy clones into the arena too. `Arena.deinit` keeps panicking
  while a block is live (unchanged). Moving a value out is explicit:
  `clone_deep()` (V2b) builds fresh cells and so follows the scope it runs
  in: `with_allocator(Allocator.global(), () => v.clone_deep())`.
- **Placing one cell: the constructors' `alloc` parameter** (§3.2):
  `rc(v, alloc : .Some(a))`. A scope is the tool for placing everything a call
  tree creates; a parameter is the tool for one cell. It is not D2's
  rejected `alloc_in` (a keyword or lazy-expression builtin): it is an
  ordinary defaulted parameter. Containers keep `new_in`/`with_capacity_in`
  for now; moving them to the same `alloc` parameter (`ArrayList(T).new(alloc : .Some(a))`)
  so that all of std places blocks one way is a separate decision, not part
  of this plan.
- **`Allocator` moves into the prelude.** The constructors' signatures name
  it, and the prelude cannot import `std/allocator.yo` (which depends on
  the prelude). `Allocator` and `AllocatorVTable` (two small structs) move
  into `std/prelude.yo`; `std/allocator.yo` re-exports them and keeps
  `with_allocator`, `current_allocator` and the global vtable.
- **std internals.** `_ScopeGuard` (`std/allocator.yo`, a `ref` struct with
  `Dispose` today) and `Arena` (`ref(struct(_state : *_ArenaState))`)
  become move-only values in V3. `Allocator` stays a plain two-word value.
- **Owner bits.** The cell header keeps the `__YO_RC_TAG` bit. When V2b moves
  the collections' buffers into private cells, the per-container owner bits
  (capacity word, `_tombstones`, the `imm` length words) can move to that
  header tag; that is a simplification to measure then, not a requirement.

### 3.12 What gets simpler

- **The verifier.** Aliasing exists only through `Rc`/`Arc`, so every other
  value is pure. `requires(distinct(a, b))` (#1107) and the list-alias
  tracking in `src/verifier/vc.yo` (`list_alias_locals`, `distinct_pairs`)
  go away once the collections are values; an `Rc(ArrayList(T))` parameter
  is outside the verifier subset, with the existing "outside-subset" report.
- **The cycle collector.** Only cells whose payload reaches an `Rc`/`Arc` are
  tracked. Values, `Box` trees of values and collections of values are never
  tracked, which is most of a program and all of the compiler's trees.
- **Agent-written code.** Action at a distance needs an `Rc`/`Arc` in a
  type, and the vocabulary (`Box`, `Rc`, `Arc`, `Arc(Mutex(T))`) is the one
  models already know.

### 3.13 Async: futures, handles, and borrowing across an await

**Confirmed by the maintainer 2026-10-03** (PR #1169). The two
language-level choices are decisions 13 and 14 (§4); the rest follows from
§3.4 and §3.7.

Today, async state sits in four shared shapes:

- **A future** (`Impl(Future(T, E))`) is a heap state machine with a
  non-atomic count (`docs/en-US/ASYNC_AWAIT.md`, "Refcount Lifecycle"). A
  copy aliases the same task, and the docs promise that ("Multi-Await"): a
  future can be awaited several times, each await dups the result, and
  several tasks may await one pending future.
- **A `JoinHandle(T)`** is `ref(struct(__future))` with a `Dispose` that
  releases the future. Copies share it, and "awaiting does not consume the
  handle". The combinators in `std/async/index.yo` rely on that:
  - they copy handles out of a list (`h := handles(i)`);
  - `race` and `any` hand back an index and leave every handle with the
    caller;
  - `timeout` promises the handle "can be joined again".
- **`Waker`** is `atomic(ref(struct(_p)))`, documented as "cheap to copy".
  **`Park`**, the async `Mutex`, `Channel`/`Sender`/`Receiver` and the five
  stream adapters are `ref(struct(...))`.
- **An effect bundle** is copied into a future bitwise:
  `__yo_future_set_bundle` (`src/codegen/types/generation.yo`) is a `memcpy`
  with no dup.

One pattern runs through `std/async`: **a method returns a future whose
body mutates the receiver.** Four methods do it:

- `Stream.next(self, io)`: `StreamTake` decrements `self._remaining` inside
  its `io.async` body;
- the async `Mutex.lock(self, io)`, which sets `self._locked`;
- `JoinHandle.join(self, io)`;
- `Park.wait(self, io)`.

That works only because `self` is a reference. Under values, the body would
mutate its captured copy. The obvious fix is unavailable: an `inout` binding
cannot be captured. Measured with `yo check` on v0.2.49:

```text
Cannot capture inout binding 'xs' in a closure. `inout(xs) : T` is a second-class
reference to the caller's storage; a closure that captures it could outlive the call frame.
```

The design:

- **A1. A future is a move-only value.**
  - Every state-machine type and `IoFuture` carry the `MoveOnly` marker.
  - `io.await(f, io)` and `io.spawn(f, io)` consume `f`; `io.state(f)`
    borrows.
  - `io.await` moves the result out of the finished future instead of
    dupping it, so a move-only `T` works (a future resolving to a `File`).
  - The task's cell keeps its count, because the event loop holds a second
    reference as it does today. What goes away is user-visible copies.

  That deletes the special cases built for shared futures:
  - multi-await and the result dup per await;
  - the rule that a second `io.spawn` of a running task keeps its bundle
    (`plans/ASYNC_IO_API_AUDIT.md`, A3);
  - re-awaiting an aborted future (A2's propagation stays, on the one
    await).

  The `__yo_started_child` flag tells a child the awaiting task started
  from one it adopted. V3 re-checks it: with one owner per future,
  `io.await` only ever awaits its own child.

  Sharing a task's result is spelled out: spawn the task and share the
  handle as `Rc(JoinHandle(T))` (the runtime is single-threaded, so `Rc`
  suffices). Rust's futures and `JoinHandle` have this shape. Swift's
  `Task` is a copyable shared handle, which is the hidden aliasing §1
  removes. Decision 13.
- **A2. A future may borrow, and then it is second-class.**
  - **The rule.** A function may return a future whose body captures one of
    its `inout` parameters, or one of its by-value parameters of move-only
    type (which borrow, §3.4). The call's result then borrows those
    arguments.
  - **What the caller can do with it.** It may be:
    - the direct operand of `io.await` (`io.await(s.next(io), io)`);
    - the direct operand of a future-taking combinator (A4), whose own
      future is then second-class under the same rule
      (`io.await(timeout(rx.recv(io), d, io), io)`);
    - returned to the function's own caller under the same rule.

    It cannot be bound to a local, stored, captured or spawned.
  - **No exclusive borrow through `Rc`/`Arc`.** An `inout` argument of a
    borrowing future whose place passes through an `Rc` or `Arc` deref
    (auto-dereference included) is a compile error.
    - Why: the borrow is live across the suspension. Another task can then
      write through the same `Rc`, which is §3.10's runtime exclusivity
      panic. Code that compiles would panic in ordinary concurrent use.
    - The fixes the error names: own the value in the task, or put it behind
      a lock (`Rc(Mutex(S))`, then `with_lock`).
    - Swift's exclusivity enforcement flags the same access.

    A shared borrow is allowed: a move-only receiver taken by value, like
    `shared.m.lock(io)` on an `Rc(Mutex(T))`. Those types keep their mutable
    state in their own cell (§3.4), so their methods never write the
    borrowed place. A concurrent write that replaces the borrowed field
    through the `Rc` is §3.10's panic, the same rule `for` over an `Rc`'d
    list follows.
  - **Precedent.** This is the second-class rule `inout` already follows,
    extended to the future that carries the borrow. It is also Swift's
    shape: `mutating func next() async` holds the `inout` access across
    the suspension.
  - **What it enables.** `Stream.next(inout(self), io)`; the async
    `Mutex.lock(self, io)` borrowing a move-only mutex;
    `Receiver.recv(self, io)`.
  - **The alternatives are worse.** Threading the state
    (`next(own(self), io)` resolving to `Tuple(Option(Self.Item), Self)`) makes every
    stream loop rebind its stream. Keeping the state in a private cell
    captured by pointer makes every adapter a hidden shared handle again.
    Decision 14.
- **A3. `JoinHandle(T)` is a move-only value struct over a raw future
  pointer**: `struct(__future : *(void))` with a `Dispose` that releases the
  task's count, so it is move-only (§3.4) and one allocation per spawn goes
  away (today's `ref` handle is a second cell around the future).
  - **Not `struct(__future : Impl(Future(T)))`.** That shape was built and
    measured (2026-10-04, branch `async-handle-genb` built by a compiler
    carrying `async-handle-gena`). An `Impl` field resolves to ONE concrete
    state-machine type per `JoinHandle(T)` instantiation, so two spawn
    sites with the same `T` and different bodies produced C that clang
    rejects (`incompatible pointer types initializing '__yo_t_…*' with an
    expression of type '__yo_t_…*'`). A handle must erase the future's
    type, so its field is a pointer, and a pointer needs `Dispose`, which
    needs move-only. That is why the change waits for V3.
  - A handle dropped without an await still detaches its task.
  - Consuming: `join(own(self), io)` and `timeout(own(handle), …)`.
  - Borrowing: `state`, `is_finished`, `abort` and `as_ptr`.
  - The blocking `h.await(own(self), io)` consumes the handle too, so
    both await paths have one owner and move the result out, and a
    move-only `T` works with either. A caller that blocks on a list of
    handles takes them out (`take`, `drain`), as `_execute_batch` would.

  Generation A, the codegen that lowers a value handle at the spawn and
  await sites, is written on branch `async-handle-gena`. It builds the
  struct with a cast to the field's C type, so it serves the pointer field
  unchanged. It lands with V3's compiler PR, and the prelude switch with
  V3's std PR.
- **A4. The combinators take handles by `own`, and two also take futures.**
  - **Future operands.** `timeout` and a two-way race (`select`) also
    accept futures, so a deadline or a race can wrap a borrowing future
    (A2): `s.next(io)`, `rx.recv(io)`, `m.lock(io)`. This is the
    select-with-timeout loop most servers need.
  - **Scoped children.** Such a combinator starts each operand as a child
    of its own task. On a deadline or a loss it aborts the child and waits
    for it to end before resolving, so no borrow outlives the combinator.
  - **This reverses an earlier decision.** The async audit's Q3 said
    "handles only" (`plans/ASYNC_IO_API_AUDIT.md`). The handle forms below
    stay. Decision 14 records the reversal.
  - `join_all`, `race_first` and `any_first` drain it.
  - `race` and `any` leave the handles alive. They resolve to the index
    together with the list handed back:
    `Tuple(usize, ArrayList(JoinHandle(T)))` and
    `Tuple(Option(usize), ArrayList(JoinHandle(T)))`, as Rust's `select_all`
    returns the remaining futures.
  - `_wait_any` takes the handles' raw pointers (`as_ptr`), so `any`'s
    pending list holds indices, not copied handles.
  - Element access uses §3.4's non-copying set (`take`, `with`, `pop`,
    `drain`).
- **A5. Wakers, parks, channels, mutexes, streams.**
  - **`Waker`** is move-only with `Clone`, like `Sender` (decision 3). A
    clone registers one more token, which is what a copy does today: the
    runtime counts live tokens (`std/async/waker.yo`). Its cell keeps the
    atomic count, because a cross-thread wake (`spawn_blocking`) releases it
    on the worker thread.
  - **Waiter lists** (`Mutex._waiters`, the channel queues) move wakers in
    and `pop` them out to wake.
  - **`Park`** is move-only. A park is waited on once, so `wait(own(self),
    io)` consumes it. That also makes the documented rule "call `waker()`
    before `wait`" static: a consumed park has no `waker()`.
  - **The async `Channel(T)`** is single-threaded, so its state goes behind
    `Rc` where the sync channel's goes behind `Arc` (V3). `Sender` and
    `Receiver` are move-only, and `Sender` has `Clone`.
  - **The async `Mutex(T)`** is move-only. Tasks share it as
    `Rc(Mutex(T))`.
  - **The five stream adapters** hold no resource. They become plain value
    structs with `next(inout(self), io)` under A2, and are move-only only
    when their inner stream is.
- **A6. The bundle copy is a typed copy.** `io.spawn` and a cold `io.await`
  copy the bundle into the future.
  - Today a bundle holds `Io` and handler functions. A field holding a cell
    (a `String`, a collection, an `Rc`) would be copied bitwise with no dup.
  - The copy becomes the bundle type's generated dup, with the matching
    drop in the future's dispose.
  - A move-only bundle field is an error at the `io.spawn`/`io.await` site,
    because one bundle starts many futures.

**Unchanged:**

- the single-threaded runtime;
- the bundle model and `Future(T, E)`'s two parameters;
- abort propagation;
- `IoFuture` as a raw `i32` future (now move-only);
- the join-wait primitive (`__yo_join_wait_new`/`__yo_join_wait_add`);
- `JoinHandle` and `Io` stay `!Send`;
- `spawn_blocking`'s result still crosses through a `Channel(T)`, where
  §3.8's transfer isolation applies.

§3.10 (the exclusivity assert at the write) and §3.11 (an async frame is a
cell the allocator scope places) already cover async bodies.

**Captures in async bodies (V2).** An `io.async` body is a closure and
captures by copy (§3.7). After V2b, a body that writes a captured
collection writes its own copy. `_execute_batch` (`src/build_runner.yo`)
does exactly that: it takes `results : HashMap(String, StepResult)` by
value, calls `results.insert(...)` inside its `io.async` body, and expects
the caller to see the insert. Its only caller awaits the returned future
directly (`execute_dag`, `src/build_runner.yo`), so under A2 the smallest
fix is `inout(results)`. A2 is in place by then (V3 precedes V2). Returning
the value from the future, or sharing an `Rc`, is the fix for a future that
is bound or spawned.

**Shared flags in async tests (V1).** The async tests share flags between a
task and its spawner through `Box` (`ran := Box(bool)(false)`, then
`ran.* = true` in the task). V1's mechanical rename of every `Box` to `Rc`
keeps them aliasing, so they need nothing beyond V1.

## 4. Decisions (V0)

The first draft's §7 questions, answered, plus three raised in review.
**Confirmed by the maintainer 2026-10-03 as written (V0).** Changing one
of them later is a plan amendment with a dated note here, not a silent
edit.

1. **Names: `Box` (value indirection), `Rc`, `Arc`.** *(Amended by §0: `Box` is uniquely owned and uncounted, with a deep `clone()`.)* Rust's `Box` is
   uniquely owned, which a copy-on-write `Box` matches observably. A new
   name (`Indirect(T)`) would avoid a silent meaning change at today's 729
   `Box` sites, but V1 removes that hazard by ordering: every current `Box`
   is renamed to `Rc` first, mechanically, and the value `Box` is introduced
   only afterwards, so no site keeps compiling with a different meaning.
2. **Move-only spelling: an auto-derived marker.** `Dispose` implies it,
   `impl(T, MoveOnly())` opts a type in without `Dispose`, structure
   propagates it (§3.4). No type modifier: a modifier would have to
   propagate through generics anyway, and the marker machinery already does.
3. **Explicit copies: `Clone`.** A move-only type that implements `Clone`
   is copied with `x.clone()`, nothing else. `Sender` keeps `clone`;
   `Receiver` stays uncloneable.
4. **Mutation through `Rc`: plain writes.** `rc.n = v` writes the shared
   object, as every `ref(struct)` field write does today (Swift classes).
   No `RefCell` (§3.10): the cell header's `borrow_count` and the
   exclusivity assert already guard the only borrows safe code has, and D3
   forbids writes through an `Arc` root in safe code.
5. **`Arc` reads: a borrowed place, plus the `Sync` bound.** §3.8.
6. **The heap cell is usable in `pragma(Pragma.AllowUnsafe)` files**, not
   only the prelude. A pragma'd file is already outside the safety claim,
   and intrusive data structures need the cell. Safe code cannot name it.
7. *(Amended by §0: `Dyn` is uniquely owned, explicit-copy or move-only.)* **`Dyn(Trait)` is a copy-on-write value** (§3.7), not a sharing wrapper;
   sharing a trait object is `Rc(Dyn(Trait))`. Raised in review by the
   plan's author: an `Rc`-like `Dyn` would keep the hidden aliasing the plan
   removes.
8. *(Amended by §0: no isolation walk; `Send` is a move.)* **`Send` is transfer, `Sync` is sharing; transfer isolates by cloning
   shared cells** (§3.8). Raised in review: without it `Channel(String)`
   stays E0602 and no copy-on-write data could cross a thread except through
   `^v`.
9. **`std/imm/` stays** (§3.9).
10. **Phase order: V1, V3, V2, V4, V5.** Move-only (V3) comes before the
   collections (V2) because V2's private buffer cell implements `Dispose`,
   which by then requires move-only, and because V3's surface (`std/sync`,
   `fs`, `net`, `process`, `thread`) is the smallest place to mature the
   marker.

Added by amendment, 2026-10-03, with the maintainer:

11. **Constructors `box(v)`, `rc(v)`, `arc(v)` in the prelude; the count
   reader is `ref_count(x)`** (§3.2). Each constructor is an ordinary
   prelude function taking `own(v)` and an optional `alloc : Option(Allocator)`
   (default `.None`, the current scope); there is no `new_in`. `Box`/`Rc`/
   `Arc` are types only: `Box(T)(v)` is not a public spelling. `ref_count`
   stays a builtin (it reads the header of whatever cell a value holds). `rc`
   stops naming the count builtin; with no shadowing, the prelude `rc`
   claims the name in every module.
12. **Explicit allocators: the scope places cells; a copy-on-write clone
   inherits its source's owner** *(amended by §0: an explicit clone inherits its source's owner)* (§3.11).

Added by amendment, 2026-10-03, with the maintainer (async, §3.13; PR
#1169, after review):

13. **A future is move-only** (§3.13 A1). `io.await` and `io.spawn`
   consume it, the result moves out, and a shared result is
   `Rc(JoinHandle(T))`. Rust has the same shape. Rejected: Swift's copyable
   `Task` handle, awaitable any number of times. It would keep today's
   multi-await, but also a type whose copies alias without saying so, and
   the special cases that exist only because a future may be shared (the
   result dup per await, the second-spawn rule, the started-child flag).
14. **A future may borrow, and is then second-class** (§3.13 A2). A future
   that captures an `inout` or a borrowed move-only argument may only be
   the direct operand of `io.await` or of `timeout`/`select`, or be
   returned under the same rule. It includes two parts:
   - `timeout` and a two-way `select` take futures as well as handles, and
     run a future operand as a scoped child (§3.13 A4). This reverses the
     async audit's Q3 ("handles only", `plans/ASYNC_IO_API_AUDIT.md`) for
     those two combinators.
   - An `inout` argument reached through `Rc`/`Arc` is a compile error, not
     a §3.10 panic at run time. Shared borrows of move-only receivers stay
     allowed.

   Rejected:
   - threading the state (`next(own(self), io)` handing `Self` back),
     which makes every stream loop rebind its stream;
   - a private cell captured by pointer, which makes each adapter, mutex
     and receiver an implicitly shared handle;
   - per-type `recv_timeout`/`next_timeout`/`lock_timeout`, which
     multiplies the timeout API.

## 5. Order and prerequisites

1. **`STRING_VALUE_SEMANTICS` S1–S3 (in progress).** They build the shared
   machinery:
   - E0908 on `inout` writes through a borrowed value, judged by the callee's
     mutation mask (S1), and its audit mode that lists every site;
   - the count-accuracy guarantee and its tests (S2);
   - the copy-on-write uniqueness step (S3).
   S4 (docs) may overlap with V1.

   Amended 2026-10-04: V1's Generation-A compiler pieces that do not use
   the uniqueness step land before S3: the `Deref` trait and the
   auto-dereference hooks, the `Rc` marker's deletion, the build enum's
   rename to `build.AllocatorKind`, and the Generation-A half of the
   prelude `Allocator` move. What needs S3 waits for it: the value `Box`,
   `make_unique`, and the `Box` → `Rc` rename of V1 step 1.
2. **This plan's phases (§6).** Each phase is one PR, or a stack with one
   battery (AGENTS.md).

**Gates for every phase:** `yo check ./src`, `yo check ./std --std-path ./std`,
`yo compile src/main.yo --skip-c-compiler`, `yo build --std-path ./std`, the
fixpoint, `gates_fast`, the fast language suite, `yo test ./std`, the hollow
sweep, `fmt --check` with the tree's stage-1. A phase that changes a hot type
also records `check ./src` time and stage-2 RSS (`--optimize 2`, no
`--emit-c`) before and after, and re-baselines the memory ratchet past ±10 %.

**Seed gate, per phase.** The seed compiles `src/` against the tree's `std/`,
so `std/` may rely on a new compiler behaviour only once `SEED_VERSION`
carries it (Generation A: the compiler change plus tests; Generation B: the
std use, one release later; `plans/backlog/SEED_VERSION_AUTOMATION.md`). The
phases below mark each item A or B. Until V5, the wrappers and buffers are
defined over `ref(struct(...))`, which every seed lowers, so most std work is
Generation A.

## 6. Phases

### V0: decisions — DONE 2026-10-03

§4 confirmed as written by the maintainer; this document amended. Nothing
else.

### V1: `Rc`, `Box`, `Arc`, auto-dereference, no `Rc` marker trait

**Step 0, the `rc` → `ref_count` rename (decision 11).** The evaluator
(`src/evaluator/exprs/_expr.yo`, the `BF_RC` arm) and codegen
(`src/codegen/exprs/generation.yo`, `generate_rc_call`) recognise `rc(...)`
by name, so any seed that still has the builtin turns a call of a prelude
`rc` function into a count read. It goes through the seed in two releases:

- **0a, Generation A (one release before V1 step 1; v0.2.50 if it is ready
  in time).** Add `BF_REF_COUNT :: "ref_count"` with the `rc` builtin's
  evaluator and codegen paths. Make the `rc` arms give way to a binding:
  when `rc` resolves to a variable in scope, evaluate an ordinary call (the
  `_evaluate_exists_or_call` pattern), in both the evaluator and codegen.
  Tests: `ref_count(x)` matches `rc(x)` on a `ref` struct, a `Box`, an
  `Arc`, a collection; a module that binds `rc` to a function calls it.
- **0b, Generation B (seed = 0a's release).** Rename every count call to
  `ref_count` (about 180: 152 in tests, 11 in `std/`, 2 in `src/`, plus docs,
  instruction files, skills, the pack), rename the 29 locals and parameters
  named `rc`, delete `BF_RC`, and add the prelude `rc` constructor. The seed
  now calls the prelude's `rc` (0a's give-way), so step 1 below can rename
  `box(` to `rc(` in `std/` and `src/` in the same cycle. Skill edits move
  the seven skill-tree CLI goldens.

Without 0a's give-way arm, step 1 waits for a seed with no `rc` builtin at
all: one more release.

Compiler (`src/`), Generation A:

- Delete the `Rc` marker: the registration in
  `auto_derive_traits_for_struct_type`, the `Rc` arm of `_marker_name_of`
  and `type_implements_trait` step 4b (`src/evaluator/trait_checking.yo`),
  the `where(Self <: Rc)` reads in `Dispose`/`Trace` checking. Until V3,
  `Dispose` is gated by "is a cell type" (today's `is_reference_struct_type`
  / `is_reference_enum_type`) at the impl site, so behaviour is unchanged.
- `Deref`: the trait check plus the two hooks of §3.3 (field label-miss
  rewrite; receiver retry) and the `.*` rule (`w.*` on a `Deref` type is
  its payload place, decided by the trait rather than the `*` field label).
  Codegen needs nothing new: the rewritten chain is `w.*.field`, which
  already lowers to `w->value.field`.
- The exclusivity assert moves from function entry to the write-through-`Rc`
  site (§3.10): `__yo_borrow_assert_unborrowed` is emitted where a field
  store, an `inout(self)` call or an index place goes through an `Rc`
  deref, including inside closures and async bodies; the entry-time emission
  in `_maybe_emit_method_entry_borrow_assert` stays until V5 for the
  remaining `ref(struct)` parameters. Tests: a closure and an async fn that
  mutate a captured `Rc(ArrayList(T))` while a `for` borrows it panic
  deterministically (today they do not).
- *(Deleted by §0: the unique `Box` needs no `make_unique`.)* `Box.make_unique` insertion before a write or an `inout(self)` call whose
  root place passes through a `Box` (the root walk is
  `get_root_expr_of_place`, `src/evaluator/exprs/assignment.yo:295`, the one
  D3 uses). Emitted as an ordinary call; the uniqueness helper is the
  `String` S3 one.
- Diagnostics registry: E0406/E0610 messages learn "`w` is a `Box(P)`; its
  payload `P` has no field `x` either" when auto-deref also misses.

std, Generation A (all over `ref(struct((*) : V))`, lowerable by the seed):

- Move `Allocator` and `AllocatorVTable` into the prelude (§3.11);
  `std/allocator.yo` re-exports them. Generation A: a type moving between
  std modules is plain std code to the seed.
- `Rc(V)` = today's `Box` definition and impls, renamed; `rc(own(v), alloc)`
  its constructor (step 0b).
- `Box(V)` = a new `ref(struct((*) : V))` whose `Clone` is a dup, with
  `make_unique(inout(self))`, `Eq`/`Hash`/`Default` by payload, and
  `box(own(v), alloc)` its constructor. `make_unique` clones through the
  source cell's owner (§3.11).
- `arc` gains the `alloc` parameter.
- `Arc(V)` unchanged.
- `Dispose`/`Trace` lose `where(Self <: Rc)`.
- `impl(Box(T), Deref(...))`, `Rc`, `Arc` likewise. std code itself keeps
  writing `.*` until the seed auto-derefs (Generation B, cosmetic).

Migration, in this order inside the PR stack so that no `Box` site silently
changes meaning:

1. Rename every `Box(`→`Rc(` and `box(`→`rc(` in `src/`, `std/`, `tests/`,
   docs and skills (mechanical; 56 + 8 + ~665 sites plus docs). Gates green:
   nothing has changed semantically.
2. Introduce the value `Box`. Move the recursion/size-only sites back to
   `Box`: in `src/` that is `Option(Box(Self))`
   (`is_owning_the_same_rc_value_as` on `Variable`, `CapturedVariable`,
   `SuspensionCapturedVariable`, `EffectCapturedVariable`),
   `Option(Box(Token))` (`consumed_at_token`, write-once), `Box(FuncMeta)`,
   `ArrayList(Box(Self))` in `src/doc/model.yo`, and the verifier's local
   cells (`src/verifier/vc.yo`). `Box(FuncValData)` stays `Rc`:
   `strip_proved_ensures_asserts` (`src/evaluator/builtins/contracts.yo:2482`)
   writes the body through it and every holder must see the write.
3. In tests, a `Box` test that asserts sharing stays on `Rc`; `tests/rc.test.yo`
   gains the value-`Box` cases (independent copy, make-unique on write,
   `ref_count(b)` before and after a write (the file is pragma'd, §3.2), a `Box` tree copied and edited on one
   side).

Tests: auto-deref for field, method, nested wrapper, wrapper-member
precedence, place write through `Rc`, copy-on-write through `Box`, D3 through
`Arc`; `box`/`rc`/`arc` with `alloc : .Some(a)` place the cell in `a` (the owner
read back with `Allocator.owner_of`) and without it follow the current
scope, and a `make_unique` clone of an arena cell stays in the arena. Exit:
gates green, the `Rc` marker trait absent from the tree.

### V3: move-only, `Dispose`, resources

Compiler, Generation A:

- The `MoveOnly` marker (§3.4): derivation, step 4b, `_marker_name_of`,
  the closure capture rule; the move points (`:=`, `=`, by-value argument
  the callee keeps, field/element store, return, capture) call
  `set_expr_as_consumed` for a move-only operand; identifier and property
  reads check `consumed_at_token`; no partial moves; E0901's note; E0907's
  loop gate lifted for move-only values.
- `Dispose` requires move-only (an impl on a copyable type is an error
  naming the copyable field).
- Codegen: a move-only value's `___drop` calls `dispose` first, then drops
  its fields; the dup/drop pair optimizer never sees a dup for a move-only
  value (there are none), and the "move into a struct field is not a
  consumption in the evaluator" rule (AGENTS.md pitfall) becomes a real
  consumption for move-only values. ASan + the leak canaries gate this.
- Async (§3.13):
  - the marker on every state-machine type and on `IoFuture` (A1);
  - `io.await`/`io.spawn` consume their future, and `io.await` moves the
    result out instead of dupping it;
  - second-class borrowing futures (A2): the evaluator marks a call's
    future as borrowing its `inout` and move-only arguments, and rejects
    any use other than an `io.await` operand, a future-taking combinator
    operand or a return; an `inout` argument reached through `Rc`/`Arc` is
    an error;
  - the scoped-child start, abort and drain that `timeout` and `select`
    need for future operands (A4);
  - the bundle's typed copy and drop, and the error for a move-only bundle
    field (A6);
  - a re-check of `__yo_started_child`.
- `Iso(T)`'s bound (§3.6) widens from "reference object" to "reaches a
  non-atomic cell".
- `Send`/`Sync` (§3.8): today's `Send` derivation becomes `Sync`; the new
  `Send` is "reaches no `Rc` and no non-atomic `Dyn`"; `Arc`, `Mutex`,
  `RwLock`, `Channel`, `Thread.spawn` and the `Impl(Fn, Send)` boundaries
  take the bound §3.8 gives each. The transfer isolation
  (`__yo_transfer_isolate_<T>`, generated beside `__yo_iso_unique_<T>` in
  `src/codegen/functions/constructors.yo`, cloning a shared cell instead of
  failing) is emitted at `Channel.send`, the spawn capture copy and the
  join-result hand-off. Tests: `Channel(String)` and `Channel(ArrayList(T))`
  round-trip under TSan; a shared buffer is cloned once; an `Rc` payload is
  E0602.

std (over `ref(struct)` still, Generation A for the type shapes;
Generation B for any method that needs the compiler to enforce move-only):

- Each resource of §2 job 3 becomes a value `struct` whose state lives in a
  move-only cell: `Mutex(T) :: struct(_cell : Box(_MutexState(T)))`,
  `_MutexState` implements `Dispose`; same for `RawMutex`, `RwLock`, `Cond`,
  `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `Arena`, `File`, `TempDir`,
  `TempFile`, `Watcher`, the sockets, `TlsStream`, `HttpClient`, `Child*`,
  `Thread`, `ThreadPool`, the RAII guards (which hold `*(_State)` into the
  cell).
- `std/async` follows §3.13 instead (Generation B: it needs A1 and A2
  enforced by the seed):
  - `JoinHandle` as a value struct around its future (A3);
  - the combinators taking `own` lists, with `race`/`any` handing the list
    back (A4);
  - `Waker` move-only with `Clone`; `Park` move-only (A5);
  - the async `Channel` over `Rc`, and the async `Mutex` move-only (A5);
  - the stream adapters as plain values with `next(inout(self), io)` (A5);
  - `docs/{en-US,zh-CN}/ASYNC_AWAIT.md`'s "Multi-Await" and handle sections
    rewritten for consuming awaits.
- Channels: `_ChannelState(T)` behind `Arc`; `Sender(T) :: struct(_ch :
  Arc(_ChannelState(T)))` move-only (Dispose decrements `_senders`) with
  `Clone`; `Receiver(T)` move-only without `Clone`; `Channel(T)` itself
  (the fused MPMC handle) is `Arc(_ChannelState(T))`-backed and copyable,
  as today's `atomic(ref(...))` is.
- `Stdin`/`Stdout`/`Stderr`, `Rng`, `HeaderMap`, `Path`, `Url`, `Regex`,
  the parsers: plain value structs, mutators `inout(self)`.
- `Mutex.with_lock(self, body : Fn(inout(v) : T) -> R)` keeps its shape;
  `body` writes through the cell.

Migration: every call site that copied a resource handle (`m2 := m;`, a
`Mutex` stored in two structs, a `Sender` captured by two closures) is an
E0901 after this phase; the fix is `Arc(Mutex(T))` / `clone()` / `inout`,
and the error text says which. Tests: `tests/sync*.test.yo`,
`tests/thread*.test.yo`, `tests/parallelism_soundness.test.yo`,
`tests/async*.test.yo`, `tests/fs*.test.yo`, `tests/process*.test.yo`,
`tests/http/*.test.yo`. New: a move-only test file (every move point, every
rejected copy with `comptime_expect_error`, flow joins, closures, generic
instantiation error text, `Dispose` runs exactly once under ASan).
New for async:
- a second `io.await` of one future and a copied `JoinHandle` are E0901;
- a borrowing future bound to a local, spawned or captured is an error;
- `Stream.next(inout(self), io)` advances the caller's stream;
- a bundle with a `String` field survives its spawner's scope under ASan;
- `race` hands back the losers and `race_first` aborts them.

### V2: the collections become values

V2a, under today's semantics (no behaviour change; every fix is correct
before and after the flip):

- Every mutator of `ArrayList`, `HashMap`, `HashSet`, `Deque`, `BTreeMap`,
  `LinkedList`, `PriorityQueue`, `HeaderMap`, `StringBuilder` takes
  `inout(self)`. Methods that hand out the buffer (`as_slice`, raw pointers)
  become `pragma`-only or `to_`/`into_` forms, as `String` S3 did for
  `as_bytes`.
- Run the E0908 audit mode (S1) over `src/`, `std/`, `tests/`: every write
  to a collection through a by-value parameter, `match`/`for` binding or
  struct copy is listed. Fix each site: `inout`, return the value, or an
  explicit `Rc(ArrayList(T))` where one list is held in two places on
  purpose. Known `src/` shapes: `out.push(...)` out-parameters
  (`inout(out)`), `Emitter.declared_ref`/`scope_ref` (aliases of the current
  function's sets, `src/emitter.yo:290-299`: `Rc`), the comptime-place model
  (`ComptimeRef`, `PtrVal.target_value`, `Variable.value : ArrayList(EvalValue)`,
  `src/value.yo:156`, `src/evaluator/exprs/assignment.yo:1041`: `Rc`),
  `update_module_cache_slot` (`src/evaluator/module_loader.yo:322-385`:
  `Rc` or rebuild), `__yo_ptr_eq(hit.cap_vals, cap_vals)` (`src/env.yo:2716`:
  identity of an `Rc`). Only ~259 `inout(` exist in `src/` today, so expect
  hundreds of sites; the audit mode's count is the phase's progress bar.
  The audit judges a site by the callee's per-parameter mutation mask
  (`src/evaluator/effects/mutation_summary.yo`) and skips a callee whose
  mask is unresolved (`all`) to avoid false errors; S1's first run flagged
  `self.clear()` but not the adjacent `self.push_string(...)` for that
  reason. V2a therefore (i) prints the unresolved-mask sites too
  (`YO_AUDIT_INOUT_BORROW`'s `[inout-borrow-unresolved]` lines), and (ii)
  teaches the mask analysis the collections' raw-pointer writes
  (`_ptr` stores through `unsafe(...)`), so that the audit is complete
  before the flip is trusted.
- The audit also lists, as their own items:
  - writes to a captured variable inside a closure or an `io.async` body
    (§3.13, "Captures in async bodies");
  - writes to a by-value parameter, `self` included, that a returned
    `io.async` body captures (§3.13's `Stream.next` pattern).

  The fix is `inout` when the caller awaits the future directly (A2).
  Otherwise the future returns the value or shares an `Rc`. V3 runs the
  same audit over the `std/async` types it turns into values, before V2.
- `yo fmt` and the LSP learn nothing new here.

> **Superseded by §0 (2026-10-05):** V2b makes the buffers uniquely owned plain allocations with a deep `clone()`, and switches on the explicit-copy kind for `String` and the collections, with the migration §0.4 measures. The copy-on-write flip below is the design it replaces.

V2b, the flip (Generation A for the compiler, the std shapes are plain
structs the seed lowers; the `Dispose` on the buffer cell is V3's rule):

- `ArrayList(T) :: struct(_buf : Option(Box(_ArrayBuf(T))))` (or the cell
  directly once V5 lands), `_ArrayBuf` move-only with `Dispose` (free) and
  `Trace` (visit each slot). Same for the other collections. `Clone`
  becomes a dup; `clone_deep()` is the element-wise copy where one is
  wanted.
- Every mutator calls the uniqueness step first (`String` S3's helper),
  whose clone goes through the source buffer's owner (§3.11). Tests: a
  list built under `with_allocator(arena, …)`, copied out and written
  outside the scope, clones into the arena; `clone_deep()` under
  `with_allocator(Allocator.global(), …)` moves it out, after which `Arena.deinit` succeeds.
- The `Index` split (§3.1): the evaluator resolves `xs(i)` to `get` in read
  position and to the place form (make-unique, then the pointer) on the
  left of `=` or as an `inout` receiver; `plans/reference/INDEX_TRAIT.md`
  gets the amendment. `String` S3 applies the same split to byte indexing.
- Codegen: `Option(struct(one cell field))` keeps the one-pointer niche
  (today the niche covers a handle payload; it must cover a one-field value
  struct around a handle, or `Option(ArrayList(T))` fields in `src/` grow by
  a word).
- E0908 now covers the collections as value aggregates (they are).
- The verifier drops `distinct` and the list-alias tracking; `Rc(ArrayList)`
  parameters are outside-subset.
- Tests: the `Bag` program of §1 prints the value result; count-accuracy
  cases from S2 for every collection; the collector test with two list
  copies sharing a buffer of `Rc` nodes (the §3.5 over-subtraction
  canary); `tests/collections*.test.yo`, `tests/cycle_collector.test.yo`,
  `tests/iso.test.yo`.
- Measure: `check ./src` time and stage-2 RSS before and after; the
  uniqueness check is a load and a compare per mutation, the first-write
  clone is the cost to watch.

### V4: the compiler's trees

Per type, in this order, each its own PR, measured:

- **`TypeValue`** (near value-ready: `clone` returns `self`, no pointer
  cycles, recursion goes through `__self_shell` and id-keyed registries):
  `ref(enum)` → `enum` with `Box(Self)` children. Replace the three
  `__yo_ptr_eq` memo and cycle-path checks (`src/types/hierarchy.yo:86-104`,
  `src/types/utils.yo:1955-1990`) with key-based ones; rebuild the module
  type in `update_module_cache_slot` instead of patching it. `clone` stays
  O(1) (a `Box` dup).
- **`AstExpr`**: the `ExprInfo` table is keyed by the `id` field, not an
  address, so copies are fine. The in-place rewrites of a node's `args`
  (`src/evaluator/exprs/_expr.yo:1289`, `src/evaluator/values/dyn.yo:668`
  and `:975`, `initialization_assignment.yo:614`, `assignment.yo:626`) go
  through `ExprInfo.macro_expansion`, the side table every tree walk already
  follows (AGENTS.md pitfall), or `args` becomes `Rc(ArrayList(Self))`.
  `FuncValData` stays behind `Rc`.
- **`Pattern`, `VcSort`, `VcTerm`, `Z3Sexpr`**: small, no aliasing found;
  `Box` children.
- **`EvalValue`**: the comptime-place model aliases on purpose (V2a made
  those cells `Rc`). The enum itself becomes a value with `Box` children;
  its `ArrayList(Self)` fields that are places stay `Rc(ArrayList(Self))`.
  Last, because it is the one where the plan's "value with Box children"
  does not hold without the explicit cells.
- Tests: `tests/internal/*` as the differential; the fixpoint; the memory
  ratchet. Variant constructions (~750 `TypeValue.`, ~430 `EvalValue.`, ~90
  `AstExpr.`) and ~3,500 destructuring arms must not need a `Box` spelled in
  every pattern: `match` sees through `Box` in a pattern position the way
  it sees through a `ref(enum)` handle today (one evaluator rule, one
  codegen rule, in `pattern_compile.yo` and `codegen/exprs/match.yo`).

### V5: remove `ref(...)` and `atomic(...)`

- **Generation A**: the parser accepts both, the evaluator warns on each
  use ("`ref(struct(...))` is removed in the next seed; use a value struct,
  `Rc(...)`, or `Box(...)`"). `std/` and `src/` stop using `ref`/`atomic`:
  the ~60 context objects become `Rc(struct(...))` (`Environment`, `Frame`,
  `Variable`, `ExprInfo`, `EvalContext`, `CodeGenContext`,
  `FunctionGenerationContext`, `Emitter`, the caches, `VcCtx`,
  `BuildRegistry`, …); the ~135 result records become plain structs; the
  wrappers and buffer cells move onto `__yo_cell`/`__yo_atomic_cell`
  (each wrapper's only field becomes the private `_cell`, so `Box(T)(…)`
  outside the prelude is E0405, and `w.*` resolves through the `Deref` rule
  of §3.3);
  `std/imm` moves onto atomic cells. Tests migrate (~150 declarations in 68
  files; `tests/ref_struct.test.yo`, `tests/ref_enum.test.yo`,
  `tests/atomic_object.test.yo` become the `Rc`/`Box`/`Arc` test files).
- **Generation B** (once `SEED_VERSION` carries a std without `ref`): the
  parser drops `ref(...)`/`atomic(...)` as type constructors; `is_reference_semantics`
  / `is_atomic_rc` on `Struct`/`EnumT` become "is a cell payload" flags set
  only by the primitive; the 527 sites in 73 files that test them
  (`src/types/guards.yo` 35, `src/evaluator/utils.yo` 30, `src/env.yo` 23,
  `src/types/utils.yo` 22, `src/codegen/functions/constructors.yo` 22,
  `src/codegen/exprs/drop_dup.yo` 22, …) are read against the new meaning,
  most unchanged, the `Rc`-trait and `is_reference_enum_type` arms deleted.
- Docs (en-US and zh-CN): DESIGN (§Types, §Type inference, §Reference-
  Semantics Types and Memory Management, §Closures with Reference-Semantics
  Types, §Testing with Reference-Semantics Types), MEMORY_SAFETY,
  COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS, CYCLE_COLLECTION, ISOLATED, ARC,
  THREAD_SAFETY, PARALLELISM, IMMUTABLE_COLLECTIONS, DYN_DESIGN, STRINGS,
  TYPE_REFLECTION, DERIVE_TRAITS; the instruction files
  (`yo-syntax`, `yo-design`, `c-codegen`); the three skills (re-record the
  seven skill-tree CLI goldens); the pack (`yo context`). Banner
  `REF_REFERENCE_SEMANTICS.md`, amend `ARC_TYPE.md`, `PARALLELISM_RULES.md`
  D2/D3 wording, `MEMORY_SAFETY.md`'s "RC-managed types" list.

## 7. Migration recipes

| Today | After | Found by |
| --- | --- | --- |
| `T :: ref(struct(...))` mutated through one handle only | `T :: struct(...)`, mutators `inout(self)` | E0908 audit |
| `T :: ref(struct(...))` held in two places on purpose | `struct(...)` + `Rc(T)` at the sharing site | E0908 audit, `__yo_ptr_eq` sites |
| `T :: atomic(ref(struct(...)))` shared across threads | `Arc(T)` over a value `T` (requires `T <: Sync`) | E0602 at the `Arc` |
| `T :: ref(enum(... Self ...))` | `enum(... Box(Self) ...)` | V4 list |
| `Box(T)` whose copies must alias | `Rc(T)` | V1 step 1 renames all, step 2 moves recursion back |
| `Dispose where(Self <: Rc)` | `Dispose` on a move-only value, or on the private cell | V3 impl check |
| A resource copied (`m2 := m`) | `Arc(Mutex(T))`, `clone()`, or `inout` | E0901 + note |
| `Iso(T)` of a `ref(struct)` | `Iso(T)` of a value reaching a cell | unchanged call sites |
| `Box(T)(v)` / `Arc(T)(v)` in user code | `box(v)` / `arc(v)`; with an allocator, `box(v, alloc : .Some(a))` | docs and skills teach only the functions; E0405 after V5 |
| `with_allocator(a, () => box(v))` for one cell | `box(v, alloc : .Some(a))` | review |
| `rc(x)` (the count) | `ref_count(x)` on an `Rc`/`Arc` in safe code; std and pragma'd code may also read a `Box`, collection or `Dyn` cell; a compile error on a value with no cell | V1 step 0 rename |
| A future awaited twice, or awaited by two tasks | await once; share the result as `Rc(JoinHandle(T))` | E0901 at the second use |
| A `JoinHandle` copied, or joined twice | one owner; `join(own(h), io)` consumes it | E0901 |
| `race(handles, io)` then reusing `handles` | `match(io.await(race(handles, io), io), (w, rest) => …)` | E0901 at the reuse |
| A method whose returned future mutates `self` | `inout(self)`, awaited at the call (§3.13 A2) | the capture audit (V2a, run from V3 on `std/async`) |
| An `io.async` body writing a captured collection | `inout` if the future is awaited directly; otherwise return it from the future, or `Rc(...)` | V2a capture audit |
| A borrowing future through an `Rc` (`shared.s.next(io)`) | own the value in the task, or `Rc(Mutex(S))` | the A2 compile error |
| A deadline on a borrowing future | `timeout(rx.recv(io), d, io)`, awaited directly | — |
| `rc` as a local or parameter name | another name (`code`, `status`); the prelude's `rc` constructor owns the name | the no-shadowing error at the definition |

## 8. Risks

> **Superseded by §0 (2026-10-05):** the copy-on-write risks (uniqueness checks, count accuracy, collector over-subtraction, transfer isolation, `Sync` usability) are gone; §0.7 lists the risks of unique ownership.

- **Performance.** A uniqueness check on every mutation of a `String`,
  collection or `Box`; a clone on the first write to a shared buffer; the
  compiler's trees moving from handles to `Box` children. Measured per
  phase; a phase stops if `check ./src` regresses past the ratchet.
- **Count accuracy is semantic.** A count that reads 1 with two live
  handles turns a copy-on-write write into a leak into a supposedly
  independent copy. `STRING_VALUE_SEMANTICS` S2 is the guard, extended to
  every copy-on-write type, and the dup/drop pair optimizer's cancellation
  rule (AGENTS.md pitfalls) is the known hazard.
- **Collector over-subtraction.** §3.5's rule (cells are nodes, values are
  inline) is load-bearing; V2b carries its canary.
- **Migration size.** ~195 `src/`, ~68 `std/` and ~150 test declarations,
  plus every `Box` and resource use site and hundreds of `inout` conversions
  in `src/`. Phased so each step is reviewable, with the E0908 audit mode
  and the E0901 note as the tools that find sites.
- **Auto-dereference precedence.** Wrapper members win silently; a payload
  method shadowed by a wrapper method (`clone` on `Rc(T)` vs `T.clone`) is
  reached with `w.*.clone()`. Documented, tested.
- **Move-only in generic std code.** Instantiation-time errors inside std
  must read well: `_reported_at_user_call` already anchors them at the user
  call; V3 adds the move-only note.
- **Transfer isolation cost.** A shared buffer sent through a channel is
  cloned at the boundary (§3.8). That is the copy value semantics owes
  anyway, but it is O(n) and hidden; the unique case (one walk, no copy) is
  the common one and the TSan/perf tests of V3 measure both.
- **`Sync` usability.** Copy-on-write data cannot sit in an `Arc` (§3.8).
  `Arc(Mutex(T))` and `std/imm` cover the shared cases; Q11 decides whether
  to pay for atomic counts to lift it.

## 9. Open questions

11. **Resolved by §0: no buffer has a count.** *(Original question:)* **Atomically counted copy-on-write buffers?** (§3.8, §3.9) Measure the
   self-compile with the cell primitive's count made atomic (one `#define`
   in the emitted runtime, `RC_HEADER_SPLIT.md`'s shim pipeline for tracked
   live bytes and wall time). If the cost is within the memory ratchet and a
   few percent of wall time, `String` and the collections become `Sync`,
   `Arc(ArrayList(T))` becomes legal and the transfer isolation walk is
   no longer needed; `std/imm` then becomes optional. Decide after V2b,
   with numbers.

   **Maintainer's position (2026-10-04): keep the count non-atomic**, so
   `String` and the collections keep the best single-thread performance.
   The measurement above still runs once V2b exists. It confirms or
   reopens this, and the default going into V2b is non-atomic (copy-on-write
   buffers are not `Sync`; they cross threads through the §3.8 transfer
   isolation).
12. **`Box` in patterns.** V4 needs `match` to see through `Box` in pattern
   position. Spelled implicitly (a `Box(Expr)` scrutinee matches `Expr`
   patterns) or explicitly (`Box(p)`)? Implicit is what `ref(enum)` gives
   today and what 3,500 arms assume; explicit is what Rust does. Decide in
   V4's first PR, with the `TypeValue` conversion as the test.
