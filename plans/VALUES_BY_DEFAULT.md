# Values by default: sharing is visible in the type

**Status: ACTIVE. Direction approved by the maintainer 2026-10-03. Reviewed
2026-10-03 (PR #1153): the inventory was re-measured, the design gaps in §3
were filled, and §6 is the implementation and migration plan. V0 is done:
the maintainer confirmed the ten decisions of §4 as written on 2026-10-03
(#1155 added §3.10). Amended 2026-10-03 with the maintainer: the wrapper
constructors `box`/`rc`/`arc` and the count reader's rename to `ref_count`
(§3.2, decision 11, V1 step 0), explicit allocators (§3.11, decision 12),
and the constructors' `alloc` parameter in place of `new_in` (the types are
not callable). V1 starts once `plans/STRING_VALUE_SEMANTICS.md` S1–S3 have landed.**

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
  c := rc(node, alloc : arena.allocator()); // placed in the arena
  ```

  - `T` is inferred from the argument, so a call never spells it; this is
    what the ~1,300 tree-node constructions V4 rewrites rely on. A value
    whose own type is not known spells it at the argument
    (`box(Option(i32).None)`).
  - `alloc : .None` (the default; defaults must be compile-time values)
    means the current `with_allocator` scope, else the global allocator;
    `.Some(a)` places the cell in `a` (§3.11). There is no `new_in` and no
    `box_in`: one function per wrapper.
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
    `box(v, alloc : a)` pays no scope save/restore, no `_ScopeGuard`
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
  **`ref_count(x)`**: it reads any cell (`Box`, `Rc`, `Arc`, a collection
  buffer, a `Dyn`), so a name tied to `Rc` would mislead, and `ref_count` is
  the header field it reads. Yo has no shadowing, so a prelude `rc` claims
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
  the three known cells.
- **Resolution order.** The wrapper's own members come first (`rc.clone()`
  is the wrapper's; a field named `*` is the wrapper's), then the payload's
  members, recursively through nested wrappers (`Rc(Box(T))` reaches `T`).
  `w.*` still names the payload explicitly. A name the wrapper and the
  payload both have resolves to the wrapper's, silently, the way an
  inherent method beats a trait method today; the ambiguity error E0616
  applies only among traits at one level, unchanged.
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
- **Writes through `Box`** are copy-on-write: before a field write or an
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

`Box`, `Rc`, `Arc` and every copy-on-write buffer are implemented on one
heap-cell primitive: one allocation with the RC header (`__yo_ref_header_t`,
`plans/backlog/RC_HEADER_SPLIT.md`), today's `ref(struct(...))` lowering.
The primitive is `__yo_cell(V)` / `__yo_atomic_cell(V)`, a builtin usable
only in a file with `pragma(Pragma.AllowUnsafe)` (§4 Q6); user code has no
way to declare a reference type except by wrapping a value in `Rc`/`Arc`.

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
  the count of the cell `x` directly holds (a `Box`, an `Rc`, an `Arc`, a
  collection's buffer) and is a compile error on a value with no cell.

### 3.7 `Dyn`, closures, async

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
- **Async** tasks hold values in their slots; a `JoinHandle` is move-only
  (owning `JoinHandle`, #1093 step 2, already heads that way); the
  single-threaded runtime shares nothing across threads.

### 3.8 Threads: `Send` by move, `Sync` for sharing

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
- **A copy-on-write clone lands where its source lives**, not in the
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
  `rc(v, alloc : a)`. A scope is the tool for placing everything a call
  tree creates; a parameter is the tool for one cell. It is not D2's
  rejected `alloc_in` (a keyword or lazy-expression builtin): it is an
  ordinary defaulted parameter. Containers keep `new_in`/`with_capacity_in`
  for now; moving them to the same `alloc` parameter (`ArrayList(T).new(alloc : a)`)
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

## 4. Decisions (V0)

The first draft's §7 questions, answered, plus three raised in review.
**Confirmed by the maintainer 2026-10-03 as written (V0).** Changing one
of them later is a plan amendment with a dated note here, not a silent
edit.

1. **Names: `Box` (value indirection), `Rc`, `Arc`.** Rust's `Box` is
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
7. **`Dyn(Trait)` is a copy-on-write value** (§3.7), not a sharing wrapper;
   sharing a trait object is `Rc(Dyn(Trait))`. Raised in review by the
   plan's author: an `Rc`-like `Dyn` would keep the hidden aliasing the plan
   removes.
8. **`Send` is transfer, `Sync` is sharing; transfer isolates by cloning
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
   inherits its source's owner** (§3.11).

## 5. Order and prerequisites

1. **`STRING_VALUE_SEMANTICS` S1–S3 (in progress).** They build the shared
   machinery:
   - E0908 on `inout` writes through a borrowed value, judged by the callee's
     mutation mask (S1), and its audit mode that lists every site;
   - the count-accuracy guarantee and its tests (S2);
   - the copy-on-write uniqueness step (S3).
   S4 (docs) may overlap with V1.
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
- `Box.make_unique` insertion before a write or an `inout(self)` call whose
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
   `ref_count(b)` before and after a write, a `Box` tree copied and edited on one
   side).

Tests: auto-deref for field, method, nested wrapper, wrapper-member
precedence, place write through `Rc`, copy-on-write through `Box`, D3 through
`Arc`; `box`/`rc`/`arc` with `alloc : a` place the cell in `a` (the owner
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
  `Thread`, `JoinHandle`, `ThreadPool`, `Waker`, `Park`, the async stream
  adapters, the RAII guards (which hold `*(_State)` into the cell).
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
- `yo fmt` and the LSP learn nothing new here.

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
| `Box(T)(v)` / `Arc(T)(v)` in user code | `box(v)` / `arc(v)`; with an allocator, `box(v, alloc : a)` | docs and skills teach only the functions; E0405 after V5 |
| `with_allocator(a, () => box(v))` for one cell | `box(v, alloc : a)` | review |
| `rc(x)` (the count) | `ref_count(x)` on a `Box`/`Rc`/`Arc`/collection/`Dyn`; a compile error on a value with no cell | V1 step 0 rename |
| `rc` as a local or parameter name | another name (`code`, `status`); the prelude's `rc` constructor owns the name | the no-shadowing error at the definition |

## 8. Risks

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

11. **Atomically counted copy-on-write buffers?** (§3.8, §3.9) Measure the
   self-compile with the cell primitive's count made atomic (one `#define`
   in the emitted runtime, `RC_HEADER_SPLIT.md`'s shim pipeline for tracked
   live bytes and wall time). If the cost is within the memory ratchet and a
   few percent of wall time, `String` and the collections become `Sync`,
   `Arc(ArrayList(T))` becomes legal and the transfer isolation walk is
   no longer needed; `std/imm` then becomes optional. Decide after V2b,
   with numbers.
12. **`Box` in patterns.** V4 needs `match` to see through `Box` in pattern
   position. Spelled implicitly (a `Box(Expr)` scrutinee matches `Expr`
   patterns) or explicitly (`Box(p)`)? Implicit is what `ref(enum)` gives
   today and what 3,500 arms assume; explicit is what Rust does. Decide in
   V4's first PR, with the `TypeValue` conversion as the test.
