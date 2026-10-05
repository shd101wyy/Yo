# Values by default: sharing is visible in the type

**Status: ACTIVE.**
- **Direction:** approved by the maintainer on 2026-10-03.
- **Pivot:** on 2026-10-05, unique ownership (Hylo's model, Mojo's
  spelling) replaced the first draft's copy-on-write design.
- **Decisions:** all 34 in §4 are confirmed. No design question is open;
  the sub-decisions parked with the phase that settles them are listed in
  §9.

Consolidated 2026-10-05: this document states the current design only. The
copy-on-write design, the superseded decision texts and the analyses of
rejected alternatives are in git history (this file at commit 7e0efc70f, and PRs
#1153–#1212).

Progress:
- **Landed:**
  - V1 Generation A (#1186, #1188, #1191, #1207);
  - V2a (#1204);
  - V3's compiler Generation A (#1217);
  - the §6 measurement (#1220). Its call-site pass is deferred.
- **In progress:**
  - V1 step 1, Generation A: the compiler learns the `Rc` names;
  - V3b Generation A;
  - V3's remaining compiler work: async, `Iso`, `Send`/`Sync`, and
    `imm(y) :=` (see V3).

- Builds on [`plans/STRING_VALUE_SEMANTICS.md`](STRING_VALUE_SEMANTICS.md):
  S1 and S2 have landed, S3a is PR #1190, and S3b is dropped (§0 below).
- Absorbs `issues/retired/collections-value-or-reference-semantics.md`.
- No backward compatibility is kept (AGENTS.md): every user, `std/` and
  `src/` site migrates.
- **Supersedes:**
  - once V5 lands, `plans/reference/REF_REFERENCE_SEMANTICS.md` (the
    `ref(...)`/`atomic(...)` constructors) and the Rust-`Rc` note in
    `std/prelude.yo`'s `Box` docs;
  - `plans/reference/ARC_TYPE.md` stays true in substance and gets a banner.

---

## 0. The model

### 0.1 Why unique ownership

A value that owns a buffer (`String`, a collection, a `Box`) has exactly one
owner. So its buffer needs no reference count, a copy is explicit and eager
(`x.clone()`), and the last use of a value moves it. Sharing exists only
where `Rc` or `Arc` is spelled, and those are the only counted things in the
language.

The first draft's copy-on-write design put a count on every buffer. Two
problems followed from it:
- **The count had no good answer.** An atomic count made every buffer pay
  an atomic increment. A non-atomic one needed a transfer-isolation walk at
  every thread boundary.
- **It hid costs:** a uniqueness test in every mutator, and an O(n) clone
  inside the first write to a shared buffer.

Unique ownership removes the question instead of answering it.

### 0.2 Three kinds of type

| Kind | Which types | A copy is | Example |
| --- | --- | --- | --- |
| **implicitly copyable** | owns no heap memory and has no `Dispose`: integers, floats, `bool`, `rune`, raw pointers, `str` views, and structs, enums, tuples and arrays made only of these | a bitwise copy | `p2 := p` for `p : Point` |
| **explicit-copy** | owns a buffer: `String`, the collections, `Box(T)`, `Dyn(Trait)`, `Rc(T)`/`Arc(T)` handles (decision 17), and any type containing one (unless it is move-only) | an error unless it is the value's last use (then a move); an independent copy is `x.clone()` | `t := s.clone()` |
| **move-only** (§3.4) | implements `Dispose` or `MoveOnly`, or has a move-only field | an error unless it is the last use; `clone()` exists only if the type implements `Clone` (`Sender`) | `f2 := f` moves the `File` |

- **Moves are implicit at the last use, and copies are never implicit**
  except for the first kind.
  - The move points: `y := x`, passing `x` by value, storing it in a field,
    element or capture, and returning it. Each moves `x` when `x` is not
    used afterwards.
  - A later use is E0901, with a note naming `x.clone()` for an
    explicit-copy type, or `Rc`/`Arc`/`mut` for a move-only one.
  - "Last use" is the move checker: a copy point moves, and a later use is
    the error. No forward liveness analysis is involved.
- **Parameters are by value, and borrows are spelled** (decision 30):

  | Yo | Meaning | C |
  | --- | --- | --- |
  | `x : T` | by value: a copy for the first kind, a move otherwise | `T x` |
  | `imm(x) : T` | read-only borrow | `const T* x` |
  | `mut(x) : T` | exclusive read-write borrow | `T* x` |
  | an `extern` C parameter | exactly the declared C type | as declared |

  - Receivers are written the same way: `imm(self)`, `mut(self)`, and a
    plain `self` that consumes.
  - **At the call site, the borrow is marked too** (decision 33): `f(&x)`
    lends `x` to an `imm` parameter, `f(&mut x)` to a `mut` one, and a bare
    `f(x)` passes by value. A mismatch is an error. Method receivers and
    temporaries are exempt (`s.len()`, `show(make_name())`).
  - **Operators borrow their operands with no marker** (decision 34):
    `a == b` and `a + b` keep both operands, because each operator's trait
    declares them `imm`.
  - The same two words spell:
    - local borrows: `imm(y) := place` and `mut(y) := place`;
    - re-pointing a borrow: `imm(cur) = place`;
    - projection results: `-> imm(T)` and `-> mut(T)`;
    - function types: `Fn(imm(String)) -> usize`.
  - Borrows are second-class: they cannot be stored, returned, captured by
    an escaping closure or spawned. So every check is intraprocedural, and
    no lifetimes appear in the language.
- **No buffer is shared, so no buffer is counted.** The buffers of `String`
  and the collections are plain allocations owned by their value, like
  Rust's `Vec` and `String`. A mutator writes in place with no uniqueness
  test.
- **The wrappers:**

  | Wrapper | Meaning | A copy | Threads |
  | --- | --- | --- | --- |
  | **`Box(T)`** | uniquely owned heap cell, no count (Rust's `Box`); used for recursion and stable addresses | `b.clone()`, deep | as `T` |
  | **`Rc(T)`** | shared and mutable, one thread | `r.clone()`: a new handle to the same object | not `Send` |
  | **`Arc(T)`** | shared across threads, atomically counted; mutation through `Mutex`/atomics (D3) | `a.clone()` | `Send` and `Sync` when `T <: Sync` |

- **`Dyn(Trait)`** is a uniquely owned, type-erased cell (decision 7).
  - It is explicit-copy when the trait or the payload provides `Clone`
    (through a `clone` vtable slot), and move-only otherwise.
  - Sharing a trait object is `Rc(Dyn(Trait))`.
- **Threads** (§3.8).
  - `Send` means "may be moved to another thread". A `String`, a collection
    or a `Box` of `Send` values is `Send`: the move hands over the only
    owner.
  - `Sync` means "copies may be read from several threads". A uniquely
    owned buffer is `Sync` when its elements are, so `Arc(String)` and
    `Arc(ArrayList(T))` are legal read-only sharing.
- **The cycle collector tracks `Rc` cells only.** It is thread-local and
  non-atomic (`docs/en-US/CYCLE_COLLECTION.md`).
  - An `Arc` is never tracked: its payload must be `Acyclic` (`arc`'s bound),
    so an `Arc` cannot close a cycle.
  - `Box`, `String` and collection buffers are part of their owner's value
    and are traversed inline.
  - An `Rc` cell is tracked only if its payload can reach an `Rc`.
- **Allocators** (§3.11). An explicit `clone()` lands where its source
  lives, through the source's owner. The allocator scope places new cells
  and buffers.

Yo differs from Hylo in one deliberate place. Hylo makes every type
non-copyable by default, even `Int`, with `@implicitcopy` regions
(`hylo-lang/Documentation`, `val-for-swift-users.md`). Yo copies the first
kind implicitly (decision 16). The parameter spelling is Mojo 1.0's
(`imm`/`mut`), with by-value instead of Mojo's read-only default.

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

After this plan, `q := p` is a move. A later use of `p` is E0901, with a
note naming `p.clone()`.

## 2. What `ref` does today

Declarations were measured on develop on 2026-10-03, with a multi-line
aware grep (`grep -Pzo 'ref\(\s*(struct|enum)\('`) checked by hand:

| Construct | std | src | tests (language) |
| --- | --- | --- | --- |
| `ref(struct(...))`, non-atomic | 45 | ~195 | ~126 |
| `atomic(ref(struct(...)))` | 22 | 0 | 13 |
| `ref(enum(...))` | 1 (`RegexNode`) | 7 | 10 |
| `atomic(ref(enum(...)))` | 0 | 0 | 1 |
| files touched | 64 | 88 | 68 of 180 (plus 10 cli-case fixtures) |

- **The seven `ref(enum)` types in `src/`:**
  - `TypeValue` (`src/types/definitions.yo`);
  - `AstExpr` (`src/expr.yo`);
  - `EvalValue` (`src/value.yo`);
  - `Pattern` (`src/pattern.yo`);
  - `VcSort` and `VcTerm` (`src/verifier/terms.yo`);
  - `Z3Sexpr` (`src/verifier/z3.yo`).
- **The ~195 `ref(struct)` declarations.** About 60 are context objects
  mutated through shared handles: `Environment`, `Frame`, `Variable`,
  `ExprInfo`, `EvalContext`, `CodeGenContext`, `FunctionGenerationContext`,
  `Emitter`, the specialization and comptime-fn caches, `VcCtx`,
  `BuildRegistry`, …. The rest are result records, options and report rows
  that are never aliased.
- **`Box(`** appears at 56 code sites in `src/` (plus 59 `box(`), 8 in
  `std/`, and about 665 in tests.

`ref` does three jobs, and each gets its own replacement:

1. **Data containers:** `ArrayList`, `HashMap`, `HashSet`, `Deque`,
   `BTreeMap`, `LinkedList`, `PriorityQueue`, `HeaderMap`, `StringBuilder`,
   `OrderedMap`, `ImmString`. They become uniquely owned values (V2).
2. **Indirection for recursion:** the seven `ref(enum)` trees in `src/`, and
   mostly `ref(enum)` in tests. They become `Box`/`Rc` children (V4).
3. **Identity and resources:** these become move-only values (§3.4, V3). A
   copy of a mutex must not be a second mutex.
   - `Mutex`, `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`,
     `WaitGroup`, `Once`, and `Channel`/`Sender`/`Receiver`, sync and async;
   - `Thread`, `JoinHandle`, `ThreadPool`, `Waker`, `Park`, `Arena`;
   - `File`, `TempDir`/`TempFile`, `Watcher`, `TcpStream`/`TcpListener`/
     `UdpSocket`/`UnixStream`/`UnixListener`, `TlsStream`, `HttpClient`,
     and `Child`/`ChildStdin`/`ChildStdout`/`ChildStderr`;
   - the RAII guards (`__MutexUnlocker`, `__RwLock*Unlocker`,
     `__SemaphoreReleaser`, `__BorrowGuard`, `_ScopeGuard`);
   - the five `std/async` stream adapters.

   Some handles in this family are not resources. `Stdin`/`Stdout`/`Stderr`,
   `Rng`, `Atomic*`, `HeaderMap`, `Path`, `Url`, `Regex` and the
   parser/compiler scratch objects have identity today only because
   `ref(struct)` was the only way to get in-place mutation. They become
   plain values.

## 3. The design

### 3.1 Every declared type is a value

`struct(...)`, `enum(...)` and `newtype(...)` declare values, and nothing
else does. A value's kind follows from what it owns (§0.2).
- **Mutators take `mut(self)`.** V2a did this for every collection.
- **A write through an `imm` borrow is E0908.**
- **A by-value parameter is the callee's own value,** so writing it is
  legal and changes nothing in the caller.
- **Element access is by place** (decisions 20 and 24). `xs(i)` borrows in
  read position and writes on the left of `=` or as a `mut` receiver, with
  no uniqueness step.
- **`String`'s byte index stays read-only:** S3 removes the byte place,
  which closes the UTF-8 hole.

### 3.2 `Box`, `Rc` and `Arc`

**`Box` changes meaning.** Today's `Box` is a shared cell, and V1 step 1
renames every use of it to `Rc`. The new `Box` is the unique, uncounted
indirection:
- A recursive type uses it: `Expr :: enum(Num(i32), Add(Box(Expr),
  Box(Expr)))`.
- So does a resource that needs a stable address: an OS handle that must
  not move lives in a `Box` of a move-only state.
- `Box(T)` is move-only iff `T` is.

**Layout.** `Rc(V)` and `Arc(V)` are each one heap allocation holding `V`
inline behind the count header: the layout a `ref(struct)` has today.
- `Box(V)` is one allocation with no header.
- `Option(Box(T))`, `Option(Rc(T))` and `Option(Arc(T))` keep the
  one-pointer niche.

**Constructors.** `Box`, `Rc` and `Arc` are types, and `box`, `rc` and `arc`
are their only constructors. They are ordinary prelude functions written in
Yo. Each moves its argument into a new cell, with an optional explicit
allocator:

```rust
box :: (fn(generic(T : Type), v : T, (alloc : Option(Allocator)) ?= .None) -> Box(T))(...);
rc :: (fn(generic(T : Type), v : T, (alloc : Option(Allocator)) ?= .None) -> Rc(T))(...);
arc :: (fn(generic(T : Type), v : T, (alloc : Option(Allocator)) ?= .None, where(T <: (Sync, Acyclic))) -> Arc(T))(...);

e := Expr.Add(box(l), box(r));                   // T inferred from the argument
c := rc(node, alloc : .Some(arena.allocator()));  // placed in the arena
```

- **`T` is inferred** from the argument, which the ~1,300 tree-node
  constructions of V4 rely on.
- **`alloc`.** `alloc : .None`, the default, means the current
  `with_allocator` scope, else the global allocator. `.Some(a)` places the
  cell in `a`.
  - There is no `new_in` and no `box_in`.
  - The caller writes `.Some(...)`, because Yo does not wrap a `T` into
    `Option(T)` (E0601).
  - A default must be a compile-time value (E1105), so it cannot be
    `Allocator.global()`.
- **`Allocator` lives in the prelude** (done, #1188 and #1207), so these
  signatures can name it.
- **The types are not callable outside the prelude.** After V5 each
  wrapper's only field is a private `_cell`, so `Box(T)(…)` in user code is
  E0405, and `__yo_cell` needs `pragma(Pragma.AllowUnsafe)` (decision 6).
  - Until then the wrappers are still `ref(struct((*) : V))`, so the rule is
    documentation only: docs, skills and tests teach `box(...)`.
- **The primitive takes the allocator.** `__yo_cell(T)(v, .None)` is today's
  `__yo_rc_alloc_scoped`, and `.Some(a)` gives the same helper an explicit
  scope. So `box(v)` costs one load of `__yo_scopes_ever_entered` in a
  program that never entered a scope, and `box(v, alloc : .Some(a))` pays
  no scope save/restore and no closure.
  - Until V5 the explicit path goes through `with_allocator`. That cost is
    confined to `alloc : .Some(a)` calls, and a construct-with-scope
    intrinsic can land if a benchmark asks for it.

**`ref_count(x)`** reads the count of the cell `x` holds (decision 11, which
renamed the builtin from `rc`, #1186).
- It accepts only `Rc` and `Arc`, the only counted types, and is a compile
  error on anything else.
- It is a debugging read: decision 27's clone elision may make it report
  fewer handles than the source text creates.
- The prelude's `rc` constructor claims the name `rc` in every module (no
  shadowing).

### 3.3 Auto-dereference

Explicit sharing must not mean writing `.*` everywhere.
- **`Deref` marker.** `Deref :: trait(Target : Type)` is a prelude marker,
  implemented by `Box`, `Rc` and `Arc` with `Target := V`.
  - It says "this type forwards members to its payload". Nothing is called
    at run time.
  - User types cannot implement it. The check identifies the trait by the
    prelude `Deref`'s key and accepts an impl only in the prelude and in
    compiler-generated code.
  - Landed in #1191.
- **`w.*` on a `Deref` type names its payload place** (`w->value` in C). On
  a raw pointer it stays the pointer dereference. In V5 this becomes the
  only reading, and `is_box_type` and the `*`-label tests move to the
  `Deref` check.
- **Resolution.** A member is looked up on the wrapper and on its
  payload, recursively through nested wrappers (`Rc(Box(T))` reaches `T`).
  - A name only one of them has resolves to that one.
  - A name both have is an error (decision 32). The error names
    `Rc.clone(w)` for the wrapper's member and `w.*.clone()` for the
    payload's.
  - So no order between the wrapper and the payload is ever needed to
    choose.
  - **The commonest clash is `clone`.** Every wrapper has it, and so does
    every cloneable payload. So `w.clone()` on an `Rc(ArrayList(T))` or an
    `Rc(String)` is the error, and the diagnostic and `yo fix` must offer
    both spellings.
  - The same rule holds in callee position: `w.items(i)`,
    `w.items(i) = v`, and `w.f(x)` for a function-typed payload field.
- **Hooks:**
  - fields: the label-miss arm of `evaluate_property_access`
    (`src/evaluator/exprs/property_access.yo`) rewrites `w.field` to
    `w.*.field`;
  - methods: `_try_find_receiver_method` (`src/evaluator/calls/function.yo`)
    retries with the receiver replaced by `w.*`.

  Codegen sees an ordinary chain.
- **Places.** `rc.n = v` and `rc.items.push(x)` write the shared payload.
  D3 carries over: in a file without the pragma, no write goes through an
  `Arc` root (`throw_if_write_through_atomic_root`).
- **Writes through a `Box`** are plain writes, because the owner is unique.

### 3.4 Identity and resources are move-only values

A resource (a lock, a socket, a file, a thread handle) is a value that
cannot be copied.

- **What is move-only.** A type is move-only iff it implements `Dispose`,
  or declares `impl(T, MoveOnly())`, or holds a move-only value in a field,
  variant payload, tuple element, array element or closure capture.
  - `Box(T)` is move-only iff `T` is. `Rc(T)` and `Arc(T)` never are:
    sharing a resource is what they are for.
  - `type_is_move_only` (`src/types/utils.yo`) derives it on demand. The
    hook `nominal_declares_move_only` is memoized per type key, generic
    impls match through `try_match_generic_impl`, and unforced pending
    impls are forced on first query. `type_implements_trait` answers
    `MoveOnly` from the same walk, and `_marker_name_of` knows the name.
- **One predicate.** Every move point, use-after-move, flow join, partial
  move and capture move keys on one predicate, `type_requires_explicit_copy`.
  V3 makes it true for move-only types, V2b widens it to the explicit-copy
  kind, and V2c adds `Rc`/`Arc`.
- **A copy is an error unless it is the last use.** The use-after-move
  error is E0901, and its note says why the type is move-only ("`Holder`
  holds a move-only value in its field `fd` (`Fd`): `Fd` implements
  Dispose"). E0907 ("moved on some paths") and the loop rule apply. The
  machinery already existed for owned arguments: `set_expr_as_consumed`
  (`src/evaluator/utils.yo`), the per-variable `consumed_at_token`, and the
  flow joins `merge_and_check_envs` and `check_loop_flow`.
- **Borrowing is free:** `imm(f) : File` and `mut(m) : Mutex(T)` need no
  move.
- **Generic code is checked per instantiation.** A generic body is
  re-evaluated with concrete bindings at each call
  (`create_specialized_function_inline`, `src/evaluator/calls/helper.yo`).
  So `ArrayList(File).get(i)`
  errors at the instantiation, with the std note anchored at the user's
  call (`_reported_at_user_call`). Collections give non-copying element
  access (decision 20).
- **To share a resource, spell it out:** `Arc(Mutex(T))`, `Rc(Receiver(T))`.
- **`Dispose` implies move-only.** It runs once, when the single owner's
  drop runs: the drop calls `dispose` first, then drops the fields. Rust
  has the same rule: `Drop` types are not `Copy`.
- **Explicit copies.** A move-only type may implement `Clone`, and then
  `x.clone()` is the copy (`Sender.clone`).
- **OS handles do not move.** A resource that owns a `pthread_mutex_t` or a
  `CRITICAL_SECTION` (`__YO_THREAD_SYNC_TYPE`) is `struct(_cell : Box(State))` with `State`
  move-only. RAII guards hold a raw pointer into that cell, in std code
  under `pragma(Pragma.AllowUnsafe)`.
  - **This is the unique `Box` of V1 step 2.** An `Rc` cell cannot stand in
    for it, because `Rc(T)` is never move-only, so the resource would not
    derive move-only. That is why V3's std half follows V1 step 2 (§6).

### 3.5 The cell primitive is private

- **The primitives.** `Rc` and `Arc` are implemented on one heap-cell
  primitive: one allocation with the count header (`__yo_ref_header_t`,
  `plans/backlog/RC_HEADER_SPLIT.md`), which is today's `ref(struct(...))`
  lowering. There are two variants, because codegen must know the count
  discipline statically:
  - `__yo_cell(V)`, with plain `++`/`--`, backs `Rc`;
  - `__yo_atomic_cell(V)` backs `Arc` and `std/imm`.
- **Who may use them.** Both are builtins usable only in a file with
  `pragma(Pragma.AllowUnsafe)` (decision 6). Safe code gets a reference
  type only by writing `Rc`/`Arc`.
- **`Box` and buffers are plain allocations, not cells.** `Box`, `String`
  and collection buffers are owned by their value: no header, no count.
- **A cell is a cycle-collector node; a value is not.**
  - Values are traversed inline, buffers and `Box` included.
  - An `Rc` cell is one node with one count and one `traverse_fn`.
  - A cell is tracked only if its payload can reach an `Rc`
    (`can_type_form_rc_cycle`, which walks values inline and stops at
    atomic cells).
- **`Dispose` and `Trace` for a collection** live on its private buffer
  type, which is move-only. The public value drops the buffer, which frees
  the elements.

### 3.6 Traits

- **The `Rc` marker trait is deleted** (#1188), and the name now belongs to
  the `Rc(T)` wrapper. `Dispose` implies move-only. `Trace` is a traversal
  that any type may define.
- **`Acyclic`** keeps its meaning. A type that reaches no `Rc`/`Arc` is
  acyclic by construction.
- **`Send` and `Sync`** (§3.8). `Rc` is neither. `Arc(T)` is both when `T`
  is `Sync`. A value is `Send` iff every field is. A move-only value follows
  the same rules: a `File` is `Send`, and a `Mutex(T)` is `Sync` when `T` is
  `Send`.
- **`Iso(T)` / `^v`.** `T` is any value that reaches at least one non-atomic
  cell. The deep `ref_count == 1` walk is unchanged.
- **Reflection** keeps its names and changes its reading:
  - `Type.contains_rc_type` means "reaches a non-atomic cell";
  - `Var.is_owning_the_rc_value` and `Var.has_other_aliases` are about the
    handle a value holds.

### 3.7 `Dyn`, closures, async

- **`Dyn(Trait)`** is a uniquely owned erased cell (decision 7).
  - `dyn(v)` moves `v` in. It is explicit-copy with a `clone` vtable slot,
    and move-only otherwise. Today's retain/release slots
    (`docs/en-US/DYN_DESIGN.md`) are what makes a copy alias; V2b removes
    them.
  - Sharing a trait object is `Rc(Dyn(Trait))` or
    `Arc(Dyn(Trait, Send))`.
  - Each impl method is reached through a wrapper defined with the vtable
    slot's signature: `void* self_ptr` plus the trait's parameter types
    (`_wrapper_params` and `generate_dyn_wrapper_functions` in
    `src/codegen/functions/dyn.yo`). So parameter conventions never change
    a slot's shape.
- **Closures** (decisions 22 and 23).
  - A closure's kind follows its captures.
  - A closure literal passed to an `imm(f)` parameter cannot escape, so it
    borrows its captures.
  - An escaping closure (by-value parameter, local, store, return, spawn)
    owns them: a captured explicit-copy variable is moved in at its last
    use, and otherwise needs an explicit `.clone()` first.
  - A closure body may not write or move out of its captures. State that
    changes goes through an `Rc` capture or a `mut` parameter.
- **Async** (§3.13). Futures and `JoinHandle`s are move-only, and a future
  that borrows is second-class. The runtime stays single-threaded.

### 3.8 Threads: `Send` by move, `Sync` for sharing

Today `Channel(String)` is E0602 ("String does not implement Send"), because
today's `Send` means "may be shared across threads". The plan splits the two
notions, as Rust does:

- **`Send`: the value may be moved to another thread.** A value is `Send`
  iff it reaches no `Rc`. Moving a `String` or a collection hands over its
  only owner, so `Channel(String)` and `Channel(ArrayList(T))` work, with
  no isolation walk and no copy.
- **`Sync`: copies of the value may be read from several threads at once.**
  This covers atomic cells (`Arc`, `Atomic*`, `Mutex`, `std/imm`), plain
  data, uniquely owned buffers whose elements are `Sync`, and values
  composed of them.
  - `Arc(T)` requires `T <: Sync`.
  - `Mutex(T)` requires `T <: Send` and is itself `Sync`.
  - `Arc(String)` and `Arc(ArrayList(T))` are legal read-only sharing.
- **`Iso(T)` / `^v`** remain the explicit "fail if shared" transfer.
- **`Arc` reads** need no new mechanism: auto-dereference yields a borrowed
  place, and the `Sync` bound makes copying a field out safe.

This renames today's `Send` to `Sync` at the `Arc`/`Mutex`/`RwLock`
bounds, plus a wider `Send` for the transfer points. D1, D2, D4 and D9 of
`PARALLELISM_RULES.md` keep their shape (decision 8, V3).

### 3.9 `std/imm/` becomes a separate package

`std/imm/` (`string`, `list`, `vec`, `map`, `set`, `sorted_map`,
`sorted_set`; 4,300 lines) is the atomically counted, immutable,
structurally shared family.
- **Its only remaining role is persistence:** an update yields a new
  version that shares structure with the old one (undo stacks, snapshots).
  Concurrent reads no longer need it, since `Arc(ArrayList(T))` covers
  them.
- **Nothing depends on it.** No `src/` or other `std/` module imports it;
  only its own tests, the docs and a few `src/` comments mention it.
- **So it leaves std at V5** (decision 9, revised 2026-10-05) and becomes a
  standalone package.
  - Its types are rewritten as values over atomic cells at that point
    anyway, so it moves once, already in the final language. A package may
    use the cell primitive in a `pragma(Pragma.AllowUnsafe)` file
    (decision 6).
  - **It stays in CI** as a vendored package, built and tested like
    `vendor/markdown_yo`. It has been a useful compiler stress test:
    generic recursion, cache keys and atomic counts. Several fixed issues
    and `src/` comments trace bugs to `std/imm/map.yo` and `sorted_map.yo`.

### 3.10 Exclusivity: no `RefCell`

Rust's `RefCell` guards a borrow that is alive while a write happens. Safe
Yo's borrows are all second-class:
- an `imm`/`mut` argument for one call;
- a local `imm`/`mut` binding for its live range;
- a projection for its expression;
- a borrowed `for` for the loop.

Each kind of root gets its own check:

- **Value-rooted places are checked statically and completely.** Under
  unique ownership, a place rooted in a value local is reachable only
  through that local. So decision 18's rules and decision 28's argument
  exclusivity are enough, and these writes need no run-time check.
- **Places reached through an `Rc`/`Arc` keep a run-time flag.**
  - The cell header carries the borrow marks. Decision 28 needs both shared
    and exclusive marks, which a single `borrow_count` cannot express.
  - A write through the cell, or an exclusive acquire whose path crosses
    it, asserts that no conflicting mark is held
    (`__yo_borrow_assert_unborrowed`).
  - That is `RefCell::borrow_mut`'s panic with no annotation, so a plain
    write through `Rc(T)` is sound (decision 4). The assert and the
    mutation mask behind it are the Law of Exclusivity in
    `src/codegen/functions/generation.yo`.
- **The assert moves to the write site.**
  - **Today:** it is emitted at function entry for every cell-typed
    parameter the body may mutate, and skipped for closures and async
    state machines.
  - **V1:** it is emitted at each write through an `Rc` (a field store, a
    `mut(self)` call, an index place), which covers closures and async
    uniformly. The entry-time emission (`_maybe_emit_method_entry_borrow_assert`)
    stays for `ref(struct)` parameters until V5.
- **Module-level roots** have no header. They keep the static arm of
  `require_valid_ref_argument_places` (`src/types/flowability.yo`), which
  rejects a `mut` argument into a module-level container, whatever the
  callee. A local borrow of a module-level root is rejected if its live
  range contains any call or `await` (decision 18, rule 3).
- **The borrowed-`for` guard splits by path.** `__borrow_guard` in
  `std/prelude.yo` calls `__yo_borrow_acquire` unconditionally today, and
  after V2b a value collection has no header. So:
  - a place reached through an `Rc` deref keeps the guard on that cell;
  - a purely value-rooted place needs no guard;
  - a module-level root follows rule 3 above.
- **What V2b removes.** The automatic assert before `realloc`/`free` in an
  object method (`_maybe_emit_auto_borrow_assert`) goes with the
  collections' headers. `pragma(Pragma.StrictBorrow)` is deleted, or kept
  for `Rc` roots.
- **At V5** `require_valid_ref_argument_places` keeps only its `Rc`/`Arc`
  and module-level arms.

**There is no `RefCell`.**

### 3.11 Explicit allocators

The landed model (`plans/reference/EXPLICIT_ALLOCATORS.md`) carries over:
an allocator decides where a block lives, ownership decides when it dies,
and every free routes through the owner prefix.

- **The scope places cells and buffers, and only those.** A plain struct,
  enum, tuple or array allocates nothing. The scope applies wherever a block
  is created:
  - `box`/`rc`/`arc`;
  - a collection or `String` buffer (through `current_allocator()`);
  - a `Dyn` cell, an `Iso` value, or an async state machine.
- **An explicit `clone()` lands where its source lives**, not in the
  current scope. This is today's `ArrayList.clone` rule
  (`std/collections/array_list.yo`), as in Rust's `Vec<T, A>: Clone`, and
  growth also reallocates through the owner. It is decision 12.
- **Arenas.** A value built in an arena keeps its blocks there until it
  dies. Moving it out is explicit:
  `with_allocator(Allocator.global(), () => v.clone())`.
  `Arena.deinit` keeps panicking while a block is live.
- **Placing one cell** uses the constructors' `alloc` parameter (§3.2), an
  ordinary defaulted parameter rather than D2's rejected `alloc_in`
  keyword.
  Containers keep `new_in`/`with_capacity_in` for now; moving them to the
  same `alloc` parameter is a separate decision.
- **`Allocator` and `AllocatorVTable` live in the prelude** (done in two
  generations, #1188 and #1207). `std/allocator.yo` keeps the methods,
  `with_allocator`, `current_allocator` and the global vtable.
- **std internals.** `_ScopeGuard` and `Arena` become move-only values in
  V3. `Allocator` stays a plain two-word value.
- **Owner bits.** Cell headers keep the `__YO_RC_TAG` bit. When V2b gives
  the collections private buffers, the
  per-container owner bits (the capacity word, `_tombstones`, the `imm`
  length words) may move to the buffer. That is a simplification to
  measure then.

### 3.12 What gets simpler

- **The verifier.** Aliasing exists only through `Rc`/`Arc`, so every other
  value is pure.
  - `requires(distinct(a, b))` (#1107) and the list-alias tracking in
    `src/verifier/vc.yo` (`list_alias_locals`, `distinct_pairs`) go away
    once the collections are values.
  - An `Rc(ArrayList(T))` parameter is outside the verifier subset.
- **The cycle collector.** Only `Rc` cells whose payload reaches an `Rc` are
  tracked, and values, `Box` trees and collections are never tracked.
  - The compiler's trees have `Rc` children (decision 21), so V4 makes
    `can_type_form_rc_cycle` honour a declared `Acyclic`. Trees with no
    back edges then stay untracked.
  - Its codegen callers have no `Environment`, so the impl is recorded as a
    flag on the type when it is checked.
- **Agent-written code.** Action at a distance needs an `Rc`/`Arc` in a
  type, and every borrow is written in the signature.

### 3.13 Async: futures, handles, and borrowing across an await

Confirmed by the maintainer 2026-10-03 (#1169): decisions 13 and 14.

Today four async shapes are shared:
- **A future** is a heap state machine with a non-atomic count, and may be
  awaited several times ("Multi-Await", `docs/en-US/ASYNC_AWAIT.md`).
- **A `JoinHandle(T)`** is `ref(struct(__future))`, and copies share it.
- **`Waker`** is an `atomic(ref(...))`. **`Park`**, the async `Mutex`,
  `Channel`/`Sender`/`Receiver` and the five stream adapters are
  `ref(struct(...))`.
- **An effect bundle** is copied into a future bitwise
  (`__yo_future_set_bundle`, `src/codegen/types/generation.yo`).

Four std methods return a future whose body mutates the receiver:
`Stream.next`, the async `Mutex.lock`, `JoinHandle.join` and `Park.wait`.
Today that works only because `self` is a reference. A `mut` binding cannot
be captured, so the design below gives these futures a second-class form
instead.

- **A1. A future is a move-only value.**
  - Every state-machine type and `IoFuture` carry `MoveOnly`.
  - `io.await(f, io)` and `io.spawn(f, io)` consume `f`, and `io.state(f)`
    borrows.
  - `io.await` moves the result out, so a move-only `T` works.
  - This deletes multi-await, the per-await result dup, and the
    second-spawn bundle rule (`plans/ASYNC_IO_API_AUDIT.md`, A3). V3
    re-checks `__yo_started_child`.
  - A shared result is `Rc(JoinHandle(T))`.
- **A2. A future may borrow, and is then second-class.**
  - **When it borrows.** A function returns a future whose body captures one
    of its `mut` or `imm` parameters of a non-implicitly-copyable type. A
    by-value argument is moved or copied into the frame, which leaves the
    future first-class.
  - **Where a borrowing future may appear:**
    - as the direct operand of `io.await`;
    - as the operand of a future-taking combinator (A4), whose own future
      is then second-class too;
    - returned under the same rule.

    It cannot be bound to a local, stored, captured or spawned.
  - **No exclusive borrow through an `Rc`/`Arc`.** A `mut` argument whose
    place passes through an `Rc`/`Arc` deref is a compile error, because
    the borrow is live across the suspension, and another task writing
    through the same `Rc` would hit §3.10's panic.
    - The fix the error names: own the value in the task, or use
      `Rc(Mutex(S))`.
    - A shared (`imm`) borrow of a move-only receiver stays allowed.
  - **Precedent.** This is the second-class rule `mut` already follows,
    extended to the future that carries the borrow. It is Swift's
    `mutating func next() async`.
  - **It enables** `Stream.next(mut(self), io)`, the async
    `Mutex.lock(imm(self), io)`, and `Receiver.recv(imm(self), io)`.
- **A3. `JoinHandle(T)` is a move-only value struct over a raw future
  pointer:** `struct(__future : *(void))` with a `Dispose` that releases the
  task's count.
  - **Why a pointer field.** `struct(__future : Impl(Future(T)))` was built
    and measured on 2026-10-04. An `Impl` field resolves to one concrete
    state-machine type per instantiation, so two spawn sites with one `T`
    produced C that clang rejects. A handle must erase the type, so its
    field is a pointer, which needs `Dispose`, which needs move-only.
  - A dropped handle detaches its task.
  - **Consuming:** `join(self, io)`, `timeout(handle, …)` and the blocking
    `h.await(self, io)`.
  - **Borrowing:** `state`, `is_finished`, `abort` and `as_ptr`
    (`imm(self)`).
  - **Status (2026-10-05).** Not landed. V3's compiler PR (#1217) did not
    carry it.
    - Generation A codegen is on branch `async-handle-gena` (2026-10-03,
      no PR). It lands in V3's async PR, rebased onto #1217's move-only
      machinery.
    - The prelude switch lands with V3's std half
      (`issues/an-owning-join-handle-costs-an-allocation-per-spawn.md`).
    - Branch `async-handle-genb` holds the `Impl(Future(T))` shape that
      "Why a pointer field" rejects. It is a record, not a candidate.
- **A4. Combinators (`std/async/index.yo`) take handles by value, and two
  also take futures.**
  - **Future operands.** `timeout` and a two-way `select` accept futures, so
    they can wrap a borrowing future. They run the operand as a scoped
    child, then abort it and wait for it on a deadline or a loss. This
    reverses the async audit's Q3 for those two (decision 14).
  - **Handle lists.** `join_all`, `race_first` and `any_first` drain the
    list. `race` and `any` hand it back:
    `Tuple(usize, ArrayList(JoinHandle(T)))` and
    `Tuple(Option(usize), ArrayList(JoinHandle(T)))`.
  - `_wait_any` takes raw pointers (`as_ptr`).
- **A5. Wakers, parks, channels, mutexes and streams.**
  - **`Waker`** is move-only with `Clone`. A clone registers one more token
    (the runtime counts live tokens, `std/async/waker.yo`), and its cell
    keeps the atomic count, because a cross-thread wake releases it on the
    worker.
  - **Waiter lists** (`Mutex._waiters`, the channel queues) move wakers in
    and pop them out.
  - **`Park`** is move-only, and `wait(self, io)` consumes it.
  - **The async `Channel(T)`** keeps its state behind `Rc`. `Sender` and
    `Receiver` are move-only, and `Sender` has `Clone`.
  - **The async `Mutex(T)`** is move-only, and tasks share it as
    `Rc(Mutex(T))`.
  - **The five stream adapters** become plain values with
    `next(mut(self), io)`.
- **A6. The bundle copy.** `io.spawn` and a cold `io.await` copy the bundle
  into the future, because one bundle starts many futures.
  - An explicit-copy or move-only bundle field is an error at the site. A
    generated deep clone would be a hidden copy.
  - Shared state goes in an `Rc` field.
  - **Open, decided in V2c:** what copying an `Rc` field means once `Rc`
    copies are explicit. Either the bundle copy clones its `Rc`/`Arc`
    fields, or bundles become explicit-copy (`io.spawn(b.clone(), …)`).
- **Unchanged:** the single-threaded runtime, the bundle model,
  `Future(T, E)`, abort propagation, `IoFuture` as a raw `i32` future, the
  join-wait primitive (`__yo_join_wait_new`/`__yo_join_wait_add`), and
  `JoinHandle`/`Io` staying `!Send`.
  `spawn_blocking`'s result crosses through a `Channel(T)` by move.
- **Captures.** An `io.async` body escapes, so it owns its captures.
  - `_execute_batch` (`src/build_runner.yo`) writes a captured `results`
    map. Its only caller awaits the future directly, so the fix is
    `mut(results)`.
  - Async tests that share flags through today's `Box` stay aliasing,
    because V1 step 1 renames them to `Rc`.

### 3.14 What happens to the compile-time RC machinery

Reviewed 2026-10-05 against develop's code.
`docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md` describes today's
machinery.

- **Gone with the hidden copies:**
  - the rule "every assignment, constructor argument, return and block tail
    inserts `___dup`" (the dup branch of `set_expr_as_needs_to_call_dup`);
  - the dup/drop pair optimizer (`_optimize_dup_drop_pairs`);
  - the alias-binding dup elision;
  - the optimizer's `io.async` rules.

  The owning-temp transfer branch is already a move, and stays. Each kind
  drops out at the phase that makes it explicit-copy: `Box` at V1 step 2;
  `String`, the collections and `Dyn` at V2b; `Rc`/`Arc` at V2c; `ref(...)`
  types at V5.
- **Survives, re-keyed:**
  - **The mechanisms:** scope-end drops, early-return-only drops, the
    reassignment old-value drop, `consumed_at_token`, E0901/E0907 and the
    flow joins.
  - **What they key on:** "not implicitly copyable" instead of
    `type_contains_rc_type`.
  - **What a drop does:** it frees a buffer, disposes a move-only value, or
    decrements an `Rc`/`Arc`.
  - **E0908** survives as "an `imm` borrow is read-only".
- **Shrinks to places reached through an `Rc`/`Arc`:**
  - Stage 0's caller-owned +1 is replaced by decision 28's shared mark.
  - Stage 1's mutation summaries (`src/evaluator/effects/mutation_summary.yo`)
    survive to skip that mark for read-only callees. The design and its
    measurements are in
    `issues/fixed/borrowed-arg-invalidated-by-aliased-container-mutation.md`.
  - The runtime borrow flag, the borrowed-`for` guard and interior-`mut`
    acquires narrow (§3.10).
- **Already gone.** The loop traversal borrow-chain optimization was never
  ported from the retired TypeScript compiler (see the note in
  `src/evaluator/exprs/begin.yo`). Decision 25 replaces it in the language.
- **The RC runtime survives** for `Rc`/`Arc` cells, for the cycle collector
  (`Rc` only), for the compiler's trees, and for the futures' own counts
  until A1.
- **The doc** is rescoped into an "ownership and moves" doc. It is edited at
  each phase that changes it, and rewritten at V5. The same edits reach
  `README.md`, `docs/zh-CN/README.md` and the debugging and c-codegen
  instruction files.

## 4. Decisions

All 34 are confirmed by the maintainer. A change is a dated amendment here
and in git, not a silent edit.

**V0, 2026-10-03:**

1. **Names: `Box` (unique indirection), `Rc`, `Arc`.**
   - Today's `Box` sites are renamed to `Rc` first, mechanically (V1 step
     1). The unique `Box` arrives only afterwards, so no site keeps
     compiling with a different meaning.
   - Rejected: a new name such as `Indirect(T)`.
2. **Move-only is an auto-derived marker.**
   - `Dispose` implies it, `impl(T, MoveOnly())` opts a type in, and the
     type's structure propagates it.
   - Rejected: a type modifier.
3. **Explicit copies are `Clone`.** `Sender` keeps `clone`, and `Receiver`
   stays uncloneable.
4. **A write through `Rc` is a plain write**, guarded by §3.10's assert. No
   `RefCell`. D3 forbids writes through an `Arc` root in safe code.
5. **`Arc` reads are a borrowed place, plus the `Sync` bound** (§3.8).
6. **The heap cell is usable in `pragma(Pragma.AllowUnsafe)` files.** Safe
   code cannot name it.
7. **`Dyn(Trait)` is uniquely owned:** explicit-copy with a `clone` slot,
   move-only otherwise. Sharing is `Rc(Dyn(Trait))`.
8. **`Send` is a move; `Sync` is sharing** (§3.8). There is no isolation
   walk.
9. **`std/imm/` becomes a separate package at V5** (§3.9). Revised
   2026-10-05 by the maintainer: its role is persistence alone, and nothing
   in std or the compiler depends on it.
10. **Phase order:** V1, V3, V3b, V2, V4, V5. V3 comes before V2 so
    that the move-only machinery is mature before the collections need
    the general predicate.
    - **Amended 2026-10-05:** V1 is split around V3.
      - Generation A and step 1 (the `Rc` rename) come first.
      - Step 2 (the unique `Box`) comes after V3's compiler work and V3b,
        and before V3's std half, which needs that `Box` for its
        resource cells.
      - §6 gives the full order.

**Amendments, 2026-10-03:**

11. **Constructors and the count read.** The prelude constructors are
    `box(v)`, `rc(v)` and `arc(v)`, with an optional `alloc`, and there is
    no `new_in`. The count reader is `ref_count(x)` (§3.2).
12. **Allocators.** The scope places cells and buffers, and an explicit
    clone inherits its source's owner (§3.11).
13. **A future is move-only** (§3.13 A1).
    - Rejected: Swift's copyable `Task` handle, a type whose copies alias
      without saying so.
14. **A future that borrows is second-class** (§3.13 A2).
    - `timeout` and a two-way `select` take futures (A4), which reverses the
      async audit's Q3.
    - A `mut` argument reached through an `Rc`/`Arc` is a compile error.
    - Rejected:
      - threading the state (`next` handing `Self` back);
      - a private cell captured by pointer;
      - per-type `*_timeout` methods.

**Unique ownership, 2026-10-05:**

15. *(Superseded by decision 30.)* `own(x)` was renamed `sink(x)`. The V3
    branch accepts `sink` as the interim spelling, and both are deleted at
    the V3b flip.
16. **Implicitly copyable types copy implicitly, and every owning value's
    copy is explicit.** The rule is structural (no heap, no `Dispose`), so
    no annotation is needed. Requiring `.clone()` on `i32`, as Hylo does,
    buys nothing.
17. **Copying an `Rc`/`Arc` needs `.clone()`,** as in Rust: a new handle is a
    new owner, and sharing is visible where it is created.
    - Enforced at V2c and sized by the §6 measurement.
    - **No fallback** (the maintainer, 2026-10-05). The first version kept
      implicit `Rc` copies as a fallback in case the count proved
      prohibitive. The measurement found about 3,500 copies in `src/` once
      V5's `ref` objects are `Rc`, and the maintainer chose the explicit rule
      regardless: migration cost does not decide the design.
18. **Local borrows: `imm(y) := place` and `mut(y) := place`.** This is
    Hylo's model: its spec's immutable and mutable projections, with
    exclusivity for the projection's lifetime. Yo's local default is owned,
    so the borrow is spelled. The conditions:
    1. **Second-class:** no store, return, escaping capture or spawn.
    2. **Exclusivity, by place** (amended 2026-10-05 by the maintainer, so
       that it matches decision 28's overlap rule).
       - **What is frozen.** While `imm(y)` is live, the borrowed place is
         neither written nor moved, and neither is any place it contains or
         any place that contains it. While `mut(y)` is live, none of those
         places is accessed.
       - **Siblings stay free.** `mut(a) := s.left; mut(b) := s.right` is
         accepted. Rust accepts it, and so does Swift for the stored
         properties of a local struct.
       - **Below an `Rc`/`Arc` deref, the cell is the unit,** because the
         run-time flag is per cell. Two `mut` borrows of fields of one `Rc`
         payload trip §3.10's assert.
    3. **Aliases:**
       - A value root has none, so rule 2 is checked statically.
       - A place reached through an `Rc`/`Arc` keeps the run-time flag on
         that cell.
       - A module-level root has no cell. A local borrow of one is
         rejected if its live range contains a call or an `await`.
    4. **`await`:** a borrow is an error across a suspension if its
       declaration or any re-point passes through an `Rc`/`Arc` deref or a
       module-level place. It is allowed when the whole path stays in
       task-local values.

    - **Live ranges end at the last use, not the scope end** (Hylo's rule).
      Today's `mut` locals are scope-based, and last-use ranges land with
      `imm(y) :=`.
    - `mut(e) := xs(i)` accepts element places once projections land (V2b).
    - `y := s.items` is a move (an error under decision 19) or an explicit
      clone. The borrow is `imm(items) := s.items`.
    - Precedent: `plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md` (2026-09-07)
      implemented today's `inout(y) :=`.
19. **No partial moves.** A field of explicit-copy or move-only type cannot
    be moved out of a value that stays alive. The alternatives:
    - `x.field.clone()`;
    - a whole-value destructuring (`{ a, b } := x`);
    - `take(mut(x.field))`, which leaves `Default`;
    - `replace(mut(x.field), v)`.
20. **Collection element access is by place.**
    - `xs(i)` borrows in read position and writes as a place.
    - `get(i) -> Option(T)` exists only for implicitly copyable `T`.
      Otherwise the per-instantiation error names `xs(i)` or
      `get_cloned(i)`.
    - Non-copying access: `with(i, body : Fn(mut(v) : T) -> R)`, `take(i)`,
      `swap(i, j)`, `pop` and `drain`.
21. **The compiler's large trees use `Rc` children.** `TypeValue.clone()` is
    O(1) today and called throughout `src/`. `TypeValue` and `AstExpr` are
    immutable after construction, so `Rc` shares them honestly. The small
    trees (`Pattern`, `VcSort`, `VcTerm`, `Z3Sexpr`) take `Box`. `EvalValue`
    is decided and measured in its own V4 PR.
22. **Non-escaping closures borrow, escaping closures own, and a closure's
    kind follows its captures** (the structural rule of §0.2 applied to the
    capture struct).
    - A literal passed to an `imm(f)` parameter cannot outlive the call, so
      it borrows its captures with no copy or move: `xs.for_each(x =>
      print(s))`, `m.with_lock(v => …)`, a `for` body. This is Swift's
      non-escaping closure.
    - An escaping closure moves its captures in at their last use, and
      otherwise needs an explicit copy: `s2 := s.clone(); h := () =>
      log(s2)`. No capture-list syntax is added.
    - `mut` captures stay forbidden, and writing through a borrowed capture
      is E0908.
    - **Hooks:** `generate_captured_variable_dup_expressions` and
      `consume_captured_variables`. The latter is a stub today, which V3
      fills for move-only captures.
23. **No new closure types; `Fn` stays the one call trait.**
    - Escaping is the parameter's mode: `imm(f)` for non-escaping, a
      by-value `f` for escaping. This is Swift's non-escaping/`@escaping`
      split.
    - **`Impl(Fn(...))`** is static, and its kind is checked per
      instantiation. A generic that copies writes `Impl(Fn(...), Clone)`.
    - **`Dyn(Fn(...))`** is move-only. `Dyn(Fn(...), Clone)` is
      explicit-copy, with a `clone` slot.
    - **No `FnMut`/`FnOnce`.** A closure body never writes or moves its
      captures. State goes through an `Rc` capture or a `mut` parameter.
24. **Projections (Hylo's subscripts), first cut.**
    - A function whose result is `mut(T)` is a mutable projection, and one
      whose result is `imm(T)` a read projection.
    - It yields one place and ends, with no code after the yield, so it
      lowers to today's pointer-returning `index` plus the second-class
      check.
    - The yielded place may be a receiver, an argument, an operand, the left
      of `=`, or a `for` source. It may not be bound, stored, captured or
      returned.
    - While a `mut` projection is live, its base is exclusively borrowed.
    - `Index.index` becomes `fn(mut(self), idx) -> mut(Self.Output)`
      (today `-> *(Self.Output)`, `plans/reference/INDEX_TRAIT.md`), with an
      `imm` form for reads.
    - `with(i, body)` and `get_cloned` remain only where a projection cannot
      express the access.
    - Rejected: inferring the projection's mutability from the receiver.
    - Phase: V2b's first PR.
25. **A local borrow can be re-pointed to a place reached from itself.**
    This is the cursor walk over a linked structure.
    - **Spelling.** `imm(cur) = place` and `mut(cur) = place`, the binding
      form on the left of `=`. Plain `cur = v` writes through (for `mut`)
      or is rejected (for `imm`).
    - **"Reached from `cur`"** means through:
      - field steps;
      - a `Box` deref or an `Rc` deref (an `Arc` only for `imm`, with an
        atomic pin);
      - a pattern binding of a `match` over `cur`;
      - a projection, if its yielded place is rooted at its `self` and its
        other place arguments are reached from `cur`. The body check
        records whether the path crosses an `Rc`/`Arc`.

      Any other place is rejected: a sibling root, a module-level place, or
      a projection that yields an argument.
    - **Frozen.** The declared place stays frozen for `cur`'s whole live
      range, and only the target moves, so `list.head = .None` mid-walk is
      an error. A pattern binding that a re-point went through is frozen
      while the new target is live.
    - **Through an `Rc`.** The declaration path's cells stay flagged.
      - A step into a further `Rc` cell pins it (+1) and flags it, and
        releases the cell an earlier step entered.
      - The held cell is run-time state that every exit releases: `break`,
        `return`, `unwind`, scope end, and `cur`'s last use.
      - So an `Rc` walk costs one increment and one decrement per step, and
        a `Box` walk nothing.
    - **Example:**
      ```rust
      append :: (fn(mut(list) : List, v : i32) -> unit)({
        mut(cur) := list.head;               // Option(Box(Node))
        while(cur.is_some(), {
          match(cur, .Some(n) => { mut(cur) = n.next; }, .None => ());
        });
        cur = .Some(box(Node(value : v, next : .None)));   // writes the tail slot
      });
      ```
    - **Phase.** It lands with `imm(y) :=` and last-use live ranges, before
      the unique `Box`. The projection step lands with V2b.
26. **A `match` takes its scrutinee by value, the way a parameter does; a
    borrowed scrutinee is matched through its borrow.** Revised 2026-10-05
    by the maintainer ("we need to do it right"). This replaces a first
    version that borrowed by default and consumed with `match(move(x), …)`.

    | Scrutinee | Bindings |
    | --- | --- |
    | an owned value or a temporary | consumed; the selected arm's bindings own their parts |
    | an `imm` binding (an `imm` parameter, a local `imm(y)`) | `imm` borrows |
    | a `mut` binding | `mut` places |
    | `match(&x, …)` / `match(&mut x, …)` on an owned local (decision 33) | borrows, and `x` stays usable |
    | implicitly copyable data | a copy |

    - **Why by value.** A bare `x` means by value in every position
      (decision 30), and a scrutinee is no exception. It also removes two
      special cases: a `move` keyword, and the rule that a temporary is
      consumed without one. `match(make_opt(), .Some(v) => v, …)` and
      `match(x, .Some(v) => v, …)` behave alike.
    - **Why a borrow is matched through.** Nothing can be moved out of a
      borrow, so the match follows the scrutinee's mode. This is Rust's
      default binding modes. Most of the compiler's ~3,500 tree-matching
      arms are on parameters, which V3b makes `imm`, so they need no
      annotation. The explicit `&x`/`&mut x` is needed only to keep using an
      owned local after the match, which is where E0901 points.
    - **Rules for a consuming match:**
      - Guards see the bindings as borrows, and the move happens when an
        arm is selected (Rust's rule). A guard that consumed a binding would
        otherwise leave the next arm a moved payload.
      - Parts the pattern does not bind (`_`, unbound fields) are dropped
        when the arm is entered.
      - Below the first `Rc`/`Arc` deref, bindings borrow, because other
        handles may share the cell. The consumed handle lives until the
        `match` ends.
    - **`mut` scrutinees** bind `mut` places, which decision 25's cursor
      walk needs.
    - **Phase.** V3 for move-only payloads, then V3b, which makes plain
      scrutinees by value together with plain parameters, and V2b for the
      explicit-copy kind. Until V3b, a plain scrutinee borrows, as today.

27. **The compiler may elide a `.clone()` whose source is dead, as an
    optimization, never as semantics.**
    - **When.** Only where the move checker would accept the move instead:
      `x` is an owner, nothing borrows it (no local borrow, re-pointed
      borrow, borrowing future or non-escaping closure), and this holds on
      every path.
    - **Only for compiler-known `Clone`:** `Rc`/`Arc` count bumps, and `Box`,
      std buffers and derived `Clone` whose parts are compiler-known.
    - **Only when the type reaches no `Dispose`.** Otherwise eliding would
      move or drop a dispose.
    - **Lint.** A redundant-clone lint with a `yo fix` repair removes such
      clones from the source.
    - **Phase:** V2b. The lint lands in the same PR as the first `yo fix`
      sweep that inserts `.clone()`, so that the sweep's output is linted as
      soon as it exists (amended 2026-10-05). §6 estimates that about 73% of
      the sites want a real clone, so the sweep will insert some clones
      where a move or a borrow was meant, and the lint is what catches
      them.
28. **Call arguments are exclusive.**
    - **Overlap.** Two places overlap when one is a prefix of the other.
      Decision 18's local borrows use the same rule.
      Index and projection places on one root overlap conservatively. A
      non-escaping closure argument overlaps everything it captures, which
      refines today's rule that any closure argument reaches the container
      (`_reject_if_container_reachable`, `src/types/flowability.yo`).
    - **Value roots.** A `mut` argument, or a by-value argument of a
      non-implicitly-copyable type (a move), that overlaps any other
      argument is a compile error. Two `imm` arguments may overlap.
      - This reverses TYPE_SYSTEM_SOUNDNESS Phase 5.2's forced +1
        (`src/types/flowability.yo`, `docs/*/FLOWABILITY.md`), which would
        be a hidden deep copy.
    - **Through an `Rc`/`Arc`.** An `imm` argument projected through `Rc`
      cells (`f(imm(node), imm(node.name))`, where `f` writes `name` through
      the other handle) marks every cell on its path shared-borrowed for the
      call.
      - A write through those cells trips §3.10's assert, and so does an
        exclusive acquire whose path crosses them, such as
        `mut(s) := node.name; s.push_str(…)`.
      - This replaces Stage 0's +1.
      - Stage 1's summaries may skip the mark for a read-only callee, but
        only if they also count writes to uncounted buffers reached through
        an `Rc`.
    - **Phase.** The value-root rule lands with V2b. The `Rc` arm is its own
      PR after V1 step 1.
29. *(Superseded by decision 30, which needs no lowering rule.)* It
    recorded two facts that still hold:
    - **Hylo passes every parameter and result by pointer**, adding only
      LLVM attributes (`noalias`, `nofree`, `nocapture`, and `readonly` for
      `let`; `hylo-lang/hylo`, `Sources/CodeGen/LLVM/Transpilation.swift`),
      and keeps C calls separate (`CallFFI`).
    - **Rejected lowerings,** each decided by the compiler instead of
      written:
      - a byte threshold, which differs by target ABI;
      - a scalar-pair rule;
      - a per-type marker.
30. **Parameters are by value by default, and `imm(x)`/`mut(x)` spell the
    borrows** (§0.2).
    - **Why.** A parameter's C representation must be readable from its Yo
      signature (the maintainer, 2026-10-05).
    - **`sink`, `own` and `inout` are deleted** (`mut` replaces `inout`).
    - **Receivers are explicit:** `imm(self)`, `mut(self)`, and `self` for
      consuming. This was chosen over defaulting `self` to `imm`.
    - **The same words in every position**, so every position owns by
      default and spells a borrow.
    - **Why `imm`/`mut`.**
      - They are exact opposites, and short.
      - Mojo 1.0 uses the same pair: it renamed `read` to `imm` to match
        its `Imm` prefix, after renaming `inout` to `mut` in 24.6.
      - They collide with no std method name, unlike `read`/`write`.
      - Rejected:
        - `borrow`: long;
        - `read`/`write`: `write` suggests write-only, like C#'s `out` or
          Hylo's `set`;
        - `&`/`&!`: `&x` is address-of in Yo, and `!` means "not";
        - `in`.
    - **Writes.** A by-value parameter is the callee's own value, so writing
      it is legal. A write through `imm` is E0908.
    - **Callbacks.** std's `for_each`, `map`, `filter` and `with_lock` take
      `imm(f)`.
    - **Async.** A future capturing `imm`/`mut` arguments of owning types is
      second-class (A2).
    - **The cost:**
      - `imm(...)` appears on most `String`, collection, `Rc` and generic
        parameters, and on every reading receiver.
      - A forgotten `imm` on an owning type shows up at the caller as E0901,
        and the note names `imm(x)` in the callee before `x.clone()` at the
        call.
      - Borrow-by-default (Hylo, Swift, Mojo) was the alternative, rejected
        for its hidden lowering.
    - **Migration is mechanical**, because today's plain parameter already
      means a read-only borrow. See V3b.
31. **A pattern spells the wrapper it looks through, as in Rust.**
    Confirmed 2026-10-05 by the maintainer; it resolves the former §9 Q12.
    - **The rule.** A `Box(Expr)` or `Rc(Expr)` scrutinee does not match
      `Expr` patterns implicitly. The pattern names the wrapper: `Box(p)`
      matches the payload of a `Box` against `p`, and `Rc(p)` and `Arc(p)`
      do the same for their cells.
      - Example: `match(e, .Add(Box(.Num(a)), Box(.Num(b))) => a + b, …)`.
    - **Bindings inside `Rc(p)`/`Arc(p)` borrow** (decision 26), because
      other handles may share the cell. Bindings inside `Box(p)` follow the
      scrutinee's mode.
    - **Why explicit.** It keeps every indirection visible where it is
      crossed, which is the point of this plan. A pattern written against a
      `Box` child is also not silently re-read when a type changes `Rc` to
      `Box` or back.
    - **Rejected: implicit see-through,** which is what `ref(enum)` gives
      today and what the ~3,500 tree arms assume.
    - **Cost.** V4 rewrites the arms that destructure children. The rewrite
      is mechanical: each pattern position whose type is a wrapper gains
      the wrapper's constructor.

32. **A member name both the wrapper and its payload have is an error;
    the wrapper's is spelled `Rc.clone(w)`.** Confirmed 2026-10-05 by the
    maintainer ("whenever we could be explicit, lets do explicit").
    - **The rule.** If `w : Rc(T)` (or `Box(T)`, `Arc(T)`) and both the
      wrapper and `T` have a member `m`, then `w.m` is an error. It names
      both spellings:
      - `Rc.clone(w)` for the wrapper's member (`Box.clone(b)`,
        `Arc.clone(a)`);
      - `w.*.clone()` for the payload's.

      A name only one of them has forwards (§3.3).
    - **This is Rust's convention, made a rule.** Rust's `w.clone()` on an
      `Rc` compiles and means the handle copy. The Rust book recommends
      `Rc::clone(&w)`, and clippy's `clone_on_ref_ptr` lint enforces it, so
      that a cheap handle copy reads differently from a deep clone. Yo
      rejects the ambiguous form outright.
    - **The spelling needs one small feature:** calling a method through an
      unapplied generic type constructor, with its arguments inferred from
      the receiver (`Rc.clone(w)`, as Rust infers `Rc::clone`'s `T`).
      Today `Rc(T).clone(w)` works and `Rc.clone(w)` is E0610.
    - **Phase.** V1 Generation A; the call sites migrate with V1 step 1's
      rename.

33. **A borrow is marked at the call site too: `&x` lends to an `imm`
    parameter, `&mut x` to a `mut` one, and a bare `x` passes by value.**
    Confirmed 2026-10-05 by the maintainer.
    - **Why.** Without it, `show(s)` (a borrow) and `take(s)` (a move) look
      the same at the call, although one keeps `s` and the other consumes
      it. Decision 30 made the declaration readable, and this makes the
      call readable too. It is Rust's spelling and reading (`&s`,
      `&mut s`).
      - Swift and Hylo mark only the mutable case (`&x` for `inout`);
        marking both follows "explicit whenever possible".
    - **Examples:**
      ```rust
      swap(&mut x, &mut y);
      show(&s);               // s stays usable
      take(s);                // moved
      match(&opt, .Some(v) => print(v), .None => ());   // decision 26
      ```
    - **A mismatch is an error, never a conversion.** A bare `s` passed to
      an `imm` parameter is an error naming `&s`. A `&s` passed to a
      by-value parameter is an error naming `s` or `s.clone()`. So the
      marker always tells the truth.
    - **Exempt, because nothing is left to keep:**
      - method receivers: `s.len()`, not `(&s).len()`, because the method's
        `imm(self)`/`mut(self)` spells it. Rust exempts receivers the same
        way;
      - temporaries, literals and closure literals passed to an `imm`
        parameter: `show(make_name())`, `xs.map(x => x + 1)`. A temporary
        cannot go to a `mut` parameter, which needs a place;
      - operator operands, which each operator's trait declares `imm`
        (decision 34).
    - **Address-of becomes `addr_of(x)`.** Today `&x` makes a raw pointer
      `*(T)` usable only in `pragma(Pragma.AllowUnsafe)` code. A word makes
      unsafe pointer creation searchable and frees the sigil for safe code.
      - `addr` was rejected because it has 558 uses as an identifier
        (socket addresses), and Yo has no shadowing.
      - `addr_of` is Rust's `ptr::addr_of!`, and it is unused in the tree.
    - **`&mut` is one prefix token**, like `^` in `^v`. So `&mut s.items`
      borrows `s.items`, and `&&` (logical and) is unaffected.
    - **Vocabulary.** Declarations keep the words (`imm(s) : String`,
      `mut(self)`, `imm(y) := place`), and arguments and scrutinees use the
      sigils, which map one-to-one onto them.
    - **Phase.** V3b, with decision 30: Generation A accepts both forms, and
      Generation B sweeps and turns the mismatch error on.

34. **An operator borrows its operands, and its trait spells the mode
    once.** Confirmed 2026-10-05 by the maintainer; an audit raised it,
    because decision 33 did not cover an operator's operands.
    - **The rule.** The prelude's operator traits declare their operands
      `imm`, for example `Eq`'s `(==) : fn(imm(lhs) : Self, imm(rhs) : Rhs)
      -> bool`.
      - It covers `Eq`, `Ord`, `Add`, `Sub`, `Mul`, `Div`, `Mod`, `BitAnd`,
        `BitOr`, `BitXor`, `BitNot`, `BitLeftShift`, `BitRightShift`,
        `Negate` and `LogicalNot`.
      - The range traits (`RangeOp`, `RangeInclusiveOp`) are the exception.
        A range stores its endpoints, so like a constructor it takes them by
        value.
      - Every impl matches its trait, so the mode is the same for every
        type.
    - **No marker at the operator.** `a == b` and `a + b` borrow both
      operands, and no operator consumes or writes an operand.
      - The operator itself is the marker, as `.` is for a receiver
        (decision 33), because each operator has one mode for every impl.
      - A `&` on an operand is an error.
      - Implicitly copyable operands are unaffected.
    - **Why.** On `String`, `==` is the most frequent call in the compiler:
      the comment on `std/string/string.yo`'s `Eq` measures it at ~38% of a
      stage-2 emit.
      - By-value operands would move the right operand of every comparison.
      - Markers would put two sigils on it (`&a == &b`) to say what every
        operator means.
    - **Arithmetic builds a new value.** `first + last` on `String` leaves
      both operands usable. A consuming concatenation is a named method
      (`s.append(t)`). Yo has no compound assignment, so `buf = buf + t` is
      an ordinary assignment.
    - **Rejected:**
      - markers on operands;
      - Rust's split, where comparisons borrow and arithmetic consumes,
        because `+` on an owning type would then consume silently.
    - **Indexing is not covered:** `xs(i)` is a projection (decision 24).
    - **Phase.** V3b.
      - Generation A adds `imm` to the traits' operands. Today's plain
        parameters already borrow, so no program changes behaviour.
      - The Generation B sweep rewrites every operator impl's operands to
        `imm`, plain-data types included, because an impl matches its trait.

**Considered and kept implicit** (2026-10-05, the maintainer):
- **Moves at a last use.** `f(s)` moves `s` with no marker, and a later use
  is E0901, which points at the move. A marker such as Mojo's `s^` on every
  by-value pass was rejected.
- **Copies of plain data** (decision 16). The copy is free and has no
  observable effect.
- **Allocator placement.** The `alloc` parameter is the explicit form, and
  `with_allocator` places everything a call tree creates (§3.11). Both
  stay.
- **A closure's capture mode** follows the parameter it is passed to
  (`imm(f)` or a by-value `f`, decision 22), which the callee's signature
  spells.
  - A capture list was deferred. `[imm(s), t] () => …` does not fit Yo's
    syntax, and no Yo-shaped spelling has been proposed.
  - This is to be revisited if one is.

## 5. Prerequisites, gates and the seed

- **`STRING_VALUE_SEMANTICS`.** S1 (E0908 on `mut` writes through a
  borrowed value) and S2 (count accuracy) have landed. S3a, the
  model-independent part, is PR #1190, and S4 (docs) is #1175. S3b (the
  uniqueness step) is dropped (`plans/STRING_VALUE_SEMANTICS.md` §0).
- **Each phase is one PR, or a stack with one battery** (AGENTS.md).
- **Gates for every phase:**
  - `yo check ./src` and `yo check ./std --std-path ./std`;
  - `yo compile src/main.yo --skip-c-compiler` and `yo build --std-path
    ./std`;
  - the fixpoint and `gates_fast`;
  - the fast language suite, `yo test ./std` and the hollow sweep;
  - `fmt --check` with the tree's stage-1.

  A phase that changes a hot type also records `check ./src` time and
  stage-2 RSS before and after, and re-baselines the memory ratchet past
  ±10%.
- **The seed gate.** The seed compiles `src/` against the tree's `std/`, so
  `std/` may rely on a new compiler behaviour only once `SEED_VERSION`
  carries it.
  - Generation A is the compiler change plus its tests. Generation B is the
    std use, one release later (`plans/backlog/SEED_VERSION_AUTOMATION.md`).
  - Until V5 the wrappers and buffers are defined over `ref(struct(...))`,
    which every seed lowers, so most std work is Generation A.

## 6. Phases

**Order.** Each item notes its status.

1. **First gate: measure the migration** (measured 2026-10-05, on develop
   `d342d58bb` plus the audit). `YO_AUDIT_IMPLICIT_COPY=1 yo check <path>`
   prints one line per dup the evaluator inserts for a value of the
   explicit-copy kind whose source is used again: the copies the new rule
   turns into errors.
   - **Counted.** A source that cannot be moved from is listed at once: a
     plain (borrowed) parameter, a field or index read (no partial moves,
     decision 19), a `match` binding of a parameter or field, a `for`
     element, a module-level value. An owning local is listed only if it is
     read again after the site, judged at its block's end (another arm of
     the same branch does not count, an arm that returns ends the path, a
     loop counts unless it reassigns the local).
   - **Run as** `check ./src`, `check ./std --std-path ./std`, and
     `check ./tests --exclude tests/internal --exclude tests/cli-cases --std-path ./std`
     with a tree-built compiler. Each set keeps its own directory's lines,
     one per site and instantiated type.

   | Category (with aggregates holding it) | `src/` | `std/` | `tests/` |
   | --- | ---: | ---: | ---: |
   | `String` | 1,614 | 210 | 101 |
   | `ArrayList` | 1,303 | 80 | 105 |
   | other collections | 76 | 21 | 6 |
   | `Dyn` | 9 | 6 | 8 |
   | `Box` (today's: V1 step 1's `Rc`) | 63 | 3 | 187 |
   | `Arc` | 0 | 133 | 453 |
   | `ref` objects with owning fields (V5's `Rc`) | 3,049 | 219 | 113 |
   | `ref` objects of plain fields | 436 | 65 | 129 |
   | other | 1 | 1 | 8 |
   | **Copies** | **6,551** | **738** | **1,110** |
   | Not counted: call sites of a parameter the callee stores (estimate) | ~1,000 | | |
   | Not counted: a `match` binding of an owned temporary | 3,314 | 183 | 52 |

   - **By path, in `src/`:** 2,461 returns or block tails, 2,441 field
     stores, 1,064 `y := x` bindings, 432 assignments, 143 captures. The
     remaining 10 (of 6,551) take the audit's smaller paths: element
     stores, `Dyn` coercions and owning-parameter copies.
   - **By source, in `src/`:** 2,689 field reads, 1,710 plain parameters,
     1,229 `match` bindings of a parameter or field, 839 locals used again.
     The remaining 84 are the smaller sources: `for` elements, module-level
     values, `inout` bindings, closure state, and sites the audit could not
     attribute.
   - **What the sites want.** In a sample of 30 counted `src/` lines, 22
     want a real `.clone()`, 16 of them of an `Rc`-to-be handle (`TypeValue`,
     `AstExpr`, `Environment`, `EvalValue`, `Token`). 4 want a borrow
     (`imm(y) :=`, or a read-only `match` binding), 2 a move by
     `take`/`replace`, 1 a by-value parameter (decision 30), and 1 an
     explicit `Rc` (`ComptimeRef.ArrayRef` in `evaluator/calls/index_trait.yo`
     shares a list on purpose). So about 73% clones, 13% borrows, 10% moves.
   - **The parameters.** A plain parameter that the callee stores
     (`ArrayList.push(value : T)`, `HashMap.insert`) copies inside the callee
     today, once per element type. Once it is by value (decision 30), the
     copy moves to each call site whose argument lives on. `src/` has 4,103
     `.push(`/`.insert(` calls; 7 of a sample of 28 pass a live value, hence
     the ~1,000 estimate. Counting them needs a pass from a callee's stored
     parameter to its call sites (deferred). The 1,710 plain-parameter sites
     above are each a `.clone()` in the callee or a by-value parameter.
   - **The `match` binding of an owned temporary**
     (`match(xs.get(i), .Some(x) => x, …)`) owns its payload, so it is not a
     copy there. 7 of a sample of 11 unwrap an accessor that copies (`get`,
     `last`, a map lookup): decision 20's migration, at the accessor.
   - **`Rc`/`Arc` handles, sizing V2c (decision 17).** Today's `Box` and
     `Arc` copies: 63 in `src/`, 136 in `std/`, 640 in `tests/` (most of
     `tests/`' are handles captured by a spawned closure and used again).
     V5 makes the `ref` objects `Rc` and adds 3,049 in `src/`, 219 in
     `std/`, 113 in `tests/`. Of the 3,485 `ref` copies in `src/`, 1,910 are
     `TypeValue` or `AstExpr` (decision 21's trees) and 791 return a plain
     `ref` parameter unchanged (`return(expr)` across the evaluator).
   - **Field writes through a plain parameter of plain data**, measured
     before decision 30 made them legal: 0 in `src/`, 0 in `std/`, 1 in
     `tests/`.
   - **Precision.** Over: a read after a reassignment still counts (except in
     a loop), a `break` arm is treated as staying in the function, every
     capture counts (decision 22's non-escaping literals borrow; 143 in
     `src/`, 154 in `std/`, 744 in `tests/`). Under: the call sites above;
     destructuring, `Dyn` downcasts and spawn handles, whose dups are
     emitted by codegen, which `check` never reaches; an owning parameter
     stored in a single-expression body (no block end to judge it at). The
     aliasing guard on a field passed to a borrowing parameter is not
     listed, because that argument stays a borrow.
2. **V1 step 1:** rename every `Box` to `Rc`, mechanically. Decision 28's
   `Rc` arm follows as its own PR.
3. **V3, compiler:** move-only values and the general predicate.
   - Generation A landed in #1217. It also brings decision 26 for move-only
     payloads.
   - Still to come: the async rules (§3.13), `Iso`, `Send`/`Sync`, then
     `imm(y) :=`, last-use live ranges, and decision 25's re-pointing
     without the projection step.
4. **V3b:** the parameter conventions (decisions 30, 33 and 34).
5. **V1 step 2:** the unique `Box`, explicit-copy from its first commit.
   - **V3, std:** the resources become move-only values. Their cells are
     the unique `Box` (§3.4), so this half follows step 2. It is Generation
     B in any case, because it needs a seed that enforces move-only.
6. **V2b:** projections, unique buffers, and the explicit-copy kind for
   `String`, the collections and `Dyn`. **V2c:** decision 17 for `Rc`/`Arc`.
7. **V4** (the compiler's trees), then **V5** (remove `ref`/`atomic`).

### V0: decisions — DONE 2026-10-03

### V1: `Rc`, `Box`, `Arc`, auto-dereference, no `Rc` marker trait

**Done (Generation A and its follow-ups):**
- step 0, the `rc` → `ref_count` rename and the prelude `rc` constructor
  (#1186);
- the `Rc` marker trait's deletion, with `Dispose`/`Trace` gated on
  reference types at the impl site until V3 (#1188);
- the `build.AllocatorKind` rename (#1188);
- `Deref` and auto-dereference (#1191);
- `Allocator` in the prelude (#1188, #1207).

**Remaining, Generation A:**
- **Decision 32.**
  - The wrapper/payload name clash becomes an error, in
    `evaluate_property_access` and `_try_find_receiver_method`.
  - A method can be called through an unapplied generic type constructor
    (`Rc.clone(w)`), with the arguments inferred from the receiver.
  - Tests: the clash error with both suggested spellings; `Rc.clone(w)`,
    `Box.clone(b)` and `Arc.clone(a)` inferring `T`; and forwarding of
    unclashed names unchanged.
  - Measured 2026-10-05: `Box(i32).clone(b)` and `String.len(s)` compile
    today, and `Box.clone(b)` is E0610.
- **The exclusivity assert moves to the write-through-`Rc` site** (§3.10).
  Tests: a closure and an async fn that mutate a captured
  `Rc(ArrayList(T))` while a `for` borrows it panic deterministically.
  Today they do not.
- **Diagnostics:** E0406/E0610 learn "`w` is a `Box(P)`; its payload `P`
  has no field `x` either" when auto-deref also misses.
- **`arc` gains the `alloc` parameter.**

**Step 1: rename every `Box(` to `Rc(` and `box(` to `rc(`** in `src/`,
`std/`, `tests/`, docs and skills (56 + 8 + about 665 sites, plus docs).
- It is mechanical; the gates stay green because nothing changes
  semantically.
- `Rc(V)` is today's `Box` definition and impls, renamed.

**Step 2: the unique `Box`** (after V3 and decision 25).
- **The type.** `Box(V)` is a uniquely owned cell with no count, a deep
  `Clone`, `Eq`/`Hash`/`Default` by payload, and `box(v, alloc)`. It is
  explicit-copy from its first commit, and decision 26's consuming match
  applies to its payloads.
- **Sites that move back to `Box`** (recursion and size only):
  - `Option(Box(Self))`: `is_owning_the_same_rc_value_as` on `Variable`,
    `CapturedVariable`, `SuspensionCapturedVariable` and
    `EffectCapturedVariable`;
  - `Option(Box(Token))`: `consumed_at_token`;
  - `Box(FuncMeta)`;
  - `ArrayList(Box(Self))` in `src/doc/model.yo`;
  - the verifier's local cells (`src/verifier/vc.yo`).

  `Box(FuncValData)` stays `Rc`, because `strip_proved_ensures_asserts`
  (`src/evaluator/builtins/contracts.yo`) writes the body through it.
- **Non-last-use copies.** These copy the fields above where the source is
  used again: `src/env.yo`, `evaluator/exprs/assignment.yo`,
  `evaluator/builtins/va_start.yo`, `codegen/exprs/async.yo`, and
  `evaluator/types/synthesizer.yo`. Each gets a `.clone()` or a move. The
  hop loop in `evaluator/exprs/runtime.yo` gets a re-pointed borrow.
- **Tests.** Today's `Box` tests that assert sharing stay on `Rc`.
  `tests/rc.test.yo` gains the unique-`Box` cases: an independent copy by
  `.clone()`, a tree copied and edited on one side, and E0901 on an
  implicit copy.
- **Exit:** auto-deref tests (field, method, nested wrapper, wrapper-member
  precedence, place write through `Rc`, D3 through `Arc`). `alloc :
  .Some(a)` places the cell in `a`, read back with `Allocator.owner_of`.
  An explicit `clone()` of an arena `Box` stays in the arena.

### V3: move-only, `Dispose`, resources

**Compiler, Generation A, landed in #1217:**
- **The marker, derived on demand.** `type_is_move_only`
  (`src/types/utils.yo`) holds for a value `struct`/`enum`/`newtype` covered
  by a `Dispose` or `MoveOnly` impl. It also holds for a value aggregate with
  a move-only component (field, payload, tuple or array element, closure
  capture). A reference type is never move-only and is not looked into.
  - Impls are matched per instantiation (`nominal_declares_move_only`,
    `src/evaluator/values/impl.yo`, memoized per `type_key`).
  - A pending impl naming either trait is forced the first time its type is
    asked about (`force_pending_move_only_impls`), so it may follow the
    type's first use.
  - `Type.impls(T, MoveOnly)` answers from the same walk.
  - `impl(T, !(MoveOnly))` is rejected.
  - `type_contains_rc_type` is true for a move-only type, which gives it
    owning temps, drops and joins. std containers drop and dispose their
    elements through `Type.contains_rc_type`.
- **One predicate, `type_requires_explicit_copy`.** The move points,
  use-after-move, flow joins, no partial moves and capture moves key on
  it, and only cloning and the `Dispose` rule key on `MoveOnly`. Today it
  equals `type_is_move_only`, and decision 16's explicit-copy kind widens
  that one function.
- **Move points.** `set_expr_as_needs_to_call_dup` routes such an operand
  through `transfer_explicit_copy_value` (`src/evaluator/utils.yo`): `:=`,
  `=`, a `sink` argument, field and element stores, constructor and literal
  arguments, returns, escaping captures.
  - An owning temp transfers, and an owning local is consumed.
  - A copy out of a borrow, an `inout` or module-level binding, a field
    (no partial moves), an element or a dereference is E0901. The note names
    why the type is move-only.
  - E0907 applies unchanged.
  - A generic body that copies is E0901 at the user's instantiation, e.g.
    `ArrayList(Fd).get`, and `push`, which still borrows `value`.
- **Reads.** A read of a consumed user-named variable is E0901 for every
  type, raised through the flow-violation channel so a closure or `io.async`
  body re-raises it. A move the dup/drop pair optimizer makes is not a read
  after a move. This fixes
  `issues/fixed/a-reference-value-read-after-a-sink-move-reads-freed-memory.md`
  (S1: a `ref` value read after a `sink` move read freed memory). Measured:
  `check ./src` 0 errors, 308 of 309 test files, the 309th changed.
- **`Dispose`.**
  - On a value type, `Dispose` implies `MoveOnly`, so the old "error naming
    the copyable field" has no referent.
  - `MoveOnly` is accepted on value nominal types only, and `Trace` stays
    reference-only (`receiver_kind_trait_violation_msg`,
    `src/evaluator/trait_checking.yo`).
  - Staged: `Dispose` on a reference type stays allowed. In the PR that
    converts std's and the tests' last reference-type `Dispose`, delete
    that arm.
  - std may add a value-type `Dispose`/`MoveOnly` only once `SEED_VERSION`
    carries this compiler (Generation B).
- **Codegen.**
  - A move-only value's drop calls its `___dispose` first (a synthesized
    `self.dispose()`, `_synthesize_and_register_value_dispose`), then drops
    its fields.
  - No dup is ever built for one, so a move into a field is a real
    consumption.
- **Decision 22, partly.**
  - An escaping closure moves a move-only capture in.
  - A closure literal passed straight to a borrowing parameter borrows its
    captures when one requires an explicit copy: no dup, no move
    (`note_borrowing_argument`, `closure_literal_is_borrowed`).
  - Borrowing for closures with only copyable captures is its own measured
    step.
- **The interim `sink(x)`** (decision 15; decision 30 replaces it in V3b).
  It is the same flag as `own(x)`, so the two spell one function type.
  Printing, messages, the registry and DESIGN say `sink`.
- **Known limits.**
  - The old value of `x = y` is disposed at block end
    (`issues/questions/the-old-value-of-an-assignment-to-a-move-only-variable-is-disposed-at-the-end-of-the-block.md`).
  - The `Box(_MoFd)` assertion in `tests/move_only.test.yo` flips with the
    value `Box`.
**Compiler, remaining** (none of it is in #1217):
- **Async (§3.13):**
  - `MoveOnly` on state machines and `IoFuture`, and consuming
    `io.await`/`io.spawn` that move the result out (A1);
  - second-class borrowing futures (A2);
  - scoped children for `timeout`/`select` (A4);
  - the bundle rule (A6);
  - a re-check of `__yo_started_child`.
- **`Iso(T)`'s bound** widens to "reaches a non-atomic cell".
- **`Send`/`Sync`** (§3.8). Today's `Send` derivation becomes `Sync`, and
  the new `Send` is "reaches no `Rc`". `Arc`, `Mutex`, `RwLock`, `Channel`,
  `Thread.spawn` and the `Impl(Fn, Send)` boundaries take their bounds.
  Tests: `Channel(String)` and `Channel(ArrayList(T))` move under TSan, and
  an `Rc` payload is E0602.
- **Local borrows:** `imm(y) := place`, last-use live ranges, decision 18's
  place-based exclusivity, and decision 25's re-pointing (without the
  projection step).

**std** (over `ref(struct)` still; Generation A for the type shapes,
Generation B for methods that need the seed to enforce move-only). This half
lands after V1 step 2, because its resource cells are the unique `Box`
(§3.4, §6):
- **Resources become move-only values.** Each resource of §2's third job
  becomes a value `struct` whose state lives in a move-only cell:
  `Mutex(T) :: struct(_cell : Box(_MutexState(T)))`, where `_MutexState`
  implements `Dispose`.
  - The same goes for `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`,
    `WaitGroup`, `Once`, `Arena`, `File`, `TempDir`, `TempFile` and
    `Watcher`;
  - and for the sockets, `TlsStream`, `HttpClient`, `Child*`, `Thread`,
    `ThreadPool`, and the RAII guards (which hold `*(_State)` into the
    cell).
- **Channels.** `_ChannelState(T)` sits behind `Arc`.
  - `Sender(T)` is move-only with `Clone`; its `Dispose` decrements
    `_senders`.
  - `Receiver(T)` is move-only without `Clone`.
  - `Channel(T)`, the fused MPMC handle, stays copyable through its `Arc`.
- **`std/async`** follows §3.13 (Generation B: it needs A1 and A2 enforced
  by the seed):
  - `JoinHandle` (A3);
  - the combinators (A4);
  - `Waker`, `Park`, the async `Channel`, the async `Mutex` and the streams
    (A5);
  - `ASYNC_AWAIT.md`'s "Multi-Await" and handle sections, rewritten in both
    languages.
- **Plain values.** `Stdin`/`Stdout`/`Stderr`, `Rng`, `HeaderMap`, `Path`,
  `Url`, `Regex` and the parsers become plain value structs, with `mut(self)`
  mutators.
- **`with_lock`.** `Mutex.with_lock(imm(self), imm(body) : Fn(mut(v) : T)
  -> R)` keeps its shape.
- **Moving an element out.** std adds `push` by value, `take` and the
  consuming `match`, so an `Option(Fd)` payload or an `ArrayList(Fd)`
  element can be moved out.

**Migration.** Every call site that copied a resource handle (`m2 := m;`, a
`Mutex` stored twice, a `Sender` captured by two closures) is E0901. The fix
is `Arc(Mutex(T))`, `clone()` or `mut`, and the error says which.

**Tests:**
- **Existing suites:** `tests/sync*`, `tests/thread*`,
  `tests/parallelism_soundness`, `tests/async*`, `tests/fs*`,
  `tests/process*` and `tests/http/*`.
- **`tests/move_only.test.yo`:** every move point, every rejected copy
  (`comptime_expect_error`),
  flow joins, closures, generic instantiation text, and `Dispose` exactly
  once.
- **Async:**
  - a second `io.await` and a copied `JoinHandle` are E0901;
  - a bound, spawned or captured borrowing future is an error;
  - `Stream.next(mut(self), io)` advances the caller's stream;
  - `race` hands back the losers.

### V3b: parameter conventions (decision 30)

- **Generation A.** The compiler accepts `imm(x)`/`mut(x)` in parameters
  and receivers, in local bindings (renaming `inout(y) :=`), in re-points,
  in projection results and in function types. `mut` is `inout`'s synonym,
  and plain parameters still borrow.
  - It also adds decision 33's call-site forms, `&x` and the `&mut` token,
    and the `addr_of(x)` builtin for raw pointers.
  - While `&x` still means address-of, the new meaning is selected by the
    parameter's mode: an `imm`/`mut` parameter receives a borrow, and a
    raw-pointer parameter keeps receiving a pointer.
  - The mismatch error waits for Generation B.
  - It adds `imm` to the operator traits' operands (decision 34).
  - **Name collisions** (grep, 2026-10-05). `imm` and `mut` name no
    function, local or field in `src/` or `std/`. Three uses must keep
    working, and Generation A carries a test for each:
    - `std/imm`'s module values in type position (`imm.Map`) next to
      `imm(x)` in parameter position, until V5 moves the package out;
    - inline asm's register class `imm` (`in(imm, v)`,
      `src/evaluator/builtins/asm.yo`);
    - asm's `inout` operand kind, a name matched inside `asm(...)`. It
      stays valid after `inout` is deleted as a parameter mode.
  - **Sizing the marker sweep.** Generation A also counts the borrowed
    arguments that are named places, the sites Generation B rewrites to
    `&x`/`&mut x`. It uses an audit flag like §6's, and the count goes in
    this section before the sweep PR is opened. The edit changes no
    behaviour, but its size sets how the review is split.
- **Generation B,** once `SEED_VERSION` carries Generation A:
  1. **The `yo fix` sweep** over `src/`, `std/`, `tests/`, docs and skills:
     - every plain parameter and receiver of a type that is not implicitly
       copyable becomes `imm(...)`;
     - `inout` becomes `mut`;
     - `own(x)` and `sink(x)` become plain `x`.

     Plain parameters of implicitly copyable types stay plain: their
     meaning (a copy) and their C (`T x`) are unchanged. So the sweep
     changes no program's behaviour.
  2. **The flip:** a plain parameter is by value, and so is a plain `match`
     scrutinee (decision 26). The sweep first rewrites each `match` on an
     owned local that is used after the match to `match(&x, …)`, and marks
     every borrowed argument that is a named place `&x` or `&mut x`
     (decision 33).
  3. **Deleting** `own`, `sink` and `inout`, and `&x` as address-of: the
     sweep rewrites every raw-pointer `&x` in std, `src/` and tests to
     `addr_of(x)`, then `&x` means only a borrow. Decision 33's mismatch
     error turns on.
- **Callbacks:** std's `for_each`, `map`, `filter` and `with_lock` take
  `imm(f)`.
- **Diagnostics:** E0901 at a caller names `imm(x)` in the callee before
  `x.clone()` at the call.
- **Docs, instruction files, skills and the context pack** are rewritten.
  The seven skill-tree goldens move.
- **Measured:** `check ./src` time and stage-2 RSS.
- **The C-style builtins become snake_case, in the same release** (the
  maintainer, 2026-10-05). Every other builtin is snake_case already
  (`ref_count`, `comptime_eval`, `thread_local`, `va_start`, `macro_expand`,
  `c_include`, `str_bytes`), and decision 33 adds `addr_of`. Rust spells
  these the same way.

  | Today | After | `.yo` uses | Collision to resolve first |
  | --- | --- | ---: | --- |
  | `sizeof` | `size_of` | 653 | `std/term.yo`'s function `size_of` (the terminal size) is renamed, e.g. `term_size`, because Yo has no shadowing |
  | `alignof` | `align_of` | 39 | none |
  | `typeof` | `type_of` | 62 | none |
  | `typeid` | `type_id` | 37 | about 119 lines in `src/` use `type_id` as a local or a field. Locals are renamed (e.g. `tid`); fields are checked in the PR |

  - **Generation A:** the compiler accepts both spellings
    (`src/expr.yo`'s builtin constants and every place that matches them,
    the diagnostics registry, the LSP and `yo context`).
  - **Generation B:** the sweep over `src/`, `std/`, `tests/`, docs and
    skills, then the old names are deleted, with no alias.

### V2: the collections become values

**V2a — DONE 2026-10-05 (#1204).**
- **Mutators.** Every mutator of `ArrayList`, `HashMap`, `HashSet`,
  `Deque`, `BTreeMap`, `LinkedList`, `PriorityQueue`, `HeaderMap`,
  `StringBuilder` and `OrderedMap` takes `inout(self)` (`mut(self)` after
  V3b).
  - `StringBuilder.to_string` is one of them: it detaches the buffer.
  - `spare_capacity`, `assume_init`, `extend_from_ptr` and `get_entry_ptr`
    take `inout(self)`.
  - `ptr()` and `iter()` stay read pointers; V2b needs an
    `iter_mut(mut(self))` split.
  - `Dispose.dispose` receivers are exempt.
- **The audit** (`YO_AUDIT_INOUT_BORROW=1`, `src/evaluator/exprs/assignment.yo`)
  lists collection writes through borrowed places, with
  `[inout-borrow-unresolved]` and `[inout-borrow-capture]` tags. The
  `audit-inout-borrow-lists-collection-writes` cli-case pins it.
  - An unresolved mask (`all`) counts as a write (`d3_check_pending`).
  - Raw-pointer stores through `unsafe(...)` are followed.
  - In `src/` and `std/` the sites went from 957 to 20. The 20 write the
    payload lists of the compiler's `ref(enum)` trees, which belong to V4.
- **Shared on purpose.** Lists held twice on purpose became explicit
  handles: `ExprInfoTable`'s data, the `CodeGenContext`/`Emitter`
  declared-name sets, the http carry, and the await and effect-analysis
  side maps.

**V2b: unique buffers and the explicit-copy kind** (Generation A for the
compiler; the std shapes are plain structs the seed lowers):
- **Projections first** (decision 24), with decision 25's projection step
  and `Index` re-expressed.
  - `String`'s byte index stays read-only.
  - `plans/reference/INDEX_TRAIT.md` gets the amendment.
- **Unique buffers.**
  - `ArrayList(T)` owns a plain buffer, with `Dispose` (free) and `Trace`
    (visit each slot) on its private buffer type. The same goes for every
    collection and `String`.
  - `clone()` is deep and goes through the source's owner (§3.11).
  - Tests: a list built in an arena, cloned out under the global allocator,
    after which `Arena.deinit` succeeds.
- **The explicit-copy kind is switched on** for `String`, the collections
  and `Dyn` (decision 7), with the migration that the §6 measurement sized:
  - `yo fix` inserts `.clone()` where a copy is wanted, and the diagnostics
    name a move or a borrow where one fits;
  - decision 26 for this kind;
  - decision 27's elision and lint;
  - decision 28's value-root rule;
  - the borrowed-`for` guard split by path (§3.10).
- **Codegen.** `Option(struct(one buffer field))` keeps the one-pointer
  niche, or `Option(ArrayList(T))` fields in `src/` grow by a word.
- **E0908** covers the collections as value aggregates.
- **The verifier** drops `distinct` and the list-alias tracking, and
  `Rc(ArrayList)` parameters are outside-subset.
- **Blockers found by V2a that its audit cannot reach:**
  - **Tree payload lists written in place.** `TypeValue.SomeT`/`TraitT`
    constraint lists, `AstExpr` call arguments, the comptime-place model
    (`ComptimeRef`/`PtrVal`/`Variable.value`) and `module_loader`'s cached
    `StructVal`/`Struct` arrays. Each becomes `Rc(ArrayList(...))` or is
    rebuilt, with V4.
  - **`EvalContext`'s eight collection fields** copied by
    `copy_eval_context`/`create_function_body_evaluation_context`
    (`captured_variables`, `own_consumed_captures`,
    `function_return_impl_concrete_type`,
    `currently_specializing_function_stack`, `doc_comment_lookup`,
    `comptime_fn_caches`, `current_impl_trait_field_labels/_types`). Each
    becomes an `Rc`, or is decided to be a snapshot.
  - **`__yo_ptr_eq(hit.cap_vals, cap_vals)`** (`src/env.yo`) compares handle
    identity.
  - **A write through a local copied out of a map** (`l := m(k);
    l.push(x)`) is E0901 under the kind unless it is a borrow
    (`mut(l) := m(k)`), so it needs no separate audit.
- **Tests:**
  - the `Bag` program of §1;
  - every collection's copy, move and clone;
  - the collector with `Rc` nodes in a list;
  - `tests/collections*`, `tests/cycle_collector` and `tests/iso`.
- **Measured:** `check ./src` time and stage-2 RSS.

**V2c: decision 17.**
- **The rule.** Implicit `Rc`/`Arc` handle copies become E0901, with
  `.clone()` inserted by `yo fix`.
- **Sizing** (§6 measurement). Today's handle copies are 63 in `src/`, 136
  in `std/` and 640 in `tests/`: today's `Box`, which V1 step 1 renames
  `Rc`, plus `Arc`. Most of the `tests/` copies are handles captured by a
  spawned closure.
- **V5 inherits the rule.** V2c lands before V5, so V5's `ref` objects
  become `Rc` with explicit clones from the start. That is the larger half:
  3,049 copies in `src/`, 1,910 of them `TypeValue`/`AstExpr` (decision
  21's trees) and 791 a `return(expr)` of a plain `ref` parameter. `yo fix`
  inserts the clones, and many become borrows or moves under decision 30.
- **Bundles.** It also decides A6's `Rc` bundle fields.
- **No fallback** (decision 17). Once V5 lands, the dup/drop pair optimizer
  has no implicit copy left to cancel.

### V4: the compiler's trees

Per type, in this order, each its own measured PR (`check ./src` time,
stage-2 RSS):

- **`TypeValue`:** `ref(enum)` → `enum` with `Rc(Self)` children (decision
  21). It is near value-ready: `clone` returns `self`, there are no pointer
  cycles, and recursion goes through `__self_shell` and id-keyed
  registries.
  - Replace the three `__yo_ptr_eq` memo and cycle-path checks
    (`src/types/hierarchy.yo`, `src/types/utils.yo`) with key-based ones.
  - Rebuild the module type in `update_module_cache_slot`
    (`src/evaluator/module_loader.yo`) instead of patching it.
  - `clone` stays O(1), as an `Rc` count bump.
  - Add `can_type_form_rc_cycle`'s `Acyclic` short-circuit (§3.12).
- **`AstExpr`:** `Rc(Self)` children.
  - The `ExprInfo` table is keyed by `id`.
  - In-place rewrites of a node's `args` (`_expr.yo`, `values/dyn.yo`,
    `initialization_assignment.yo`, `assignment.yo`) go through
    `ExprInfo.macro_expansion`, or `args` becomes `Rc(ArrayList(Self))`.
  - `FuncValData` stays behind `Rc`.
- **`Pattern`, `VcSort`, `VcTerm`, `Z3Sexpr`:** `Box` children.
- **`EvalValue`:** last. The comptime-place model aliases on purpose, so its
  place fields stay `Rc(ArrayList(Self))`. Its children are `Rc` or a
  unique `Box`, decided by measurement.
- **Tests.** `tests/internal/*` as the differential, the fixpoint, and the
  memory ratchet.
  - **Wrapper patterns** (decision 31). `Box(p)`, `Rc(p)` and `Arc(p)`
    patterns are one evaluator rule and one codegen rule, in
    `pattern_compile.yo` and `codegen/exprs/match.yo`. They land in V4's
    first PR, with the `TypeValue` conversion as the test.
  - **Constructions and arms.** About 750 `TypeValue.`, 430 `EvalValue.` and
    90 `AstExpr.` constructions are rewritten. So is each of the ~3,500
    destructuring arms that reaches through a child, which a `yo fix`
    repair inserts mechanically from the pattern position's type.

### V5: remove `ref(...)` and `atomic(...)`

- **Generation A.** The parser accepts both, and the evaluator warns on each
  use. `std/` and `src/` stop using them:
  - the ~60 context objects become `Rc(struct(...))`, and the ~135 result
    records become plain structs;
  - the wrappers and buffer cells move onto `__yo_cell`/`__yo_atomic_cell`
    (each wrapper's only field becomes the private `_cell`, so
    `Box(T)(…)` outside the prelude is E0405);
  - `std/imm` moves onto atomic cells and out of std, into its own
    repository (§3.9), vendored under `vendor/` and built and tested in CI
    like `vendor/markdown_yo`. Its `tests/imm_*` files and
    `docs/*/IMMUTABLE_COLLECTIONS.md` go with it, and DESIGN, STRINGS,
    ARC, CYCLE_COLLECTION, MEMORY_SAFETY and the syntax cheatsheet point to
    the package;
  - the tests migrate (~150 declarations in 68 files):
    `tests/ref_struct.test.yo`, `tests/ref_enum.test.yo` and
    `tests/atomic_object.test.yo` become the `Rc`/`Box`/`Arc` test files.
- **Generation B** (once `SEED_VERSION` carries a std without `ref`).
  - The parser drops the constructors.
  - `is_reference_semantics`/`is_atomic_rc` become "is a cell payload"
    flags, set only by the primitive.
  - The 527 sites in 73 files that test them are read against the new
    meaning (`src/types/guards.yo` 35, `src/evaluator/utils.yo` 30,
    `src/env.yo` 23, `src/types/utils.yo` 22,
    `src/codegen/functions/constructors.yo` 22,
    `src/codegen/exprs/drop_dup.yo` 22, …).
- **Docs, en-US and zh-CN:**
  - DESIGN (§Types, §Type inference, §Reference-Semantics Types and Memory
    Management, §Closures with Reference-Semantics Types, §Testing with
    Reference-Semantics Types);
  - MEMORY_SAFETY, COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS (rescoped,
    §3.14), CYCLE_COLLECTION, ISOLATED, ARC, THREAD_SAFETY, PARALLELISM,
    IMMUTABLE_COLLECTIONS (moves to the package), DYN_DESIGN, STRINGS, TYPE_REFLECTION and
    DERIVE_TRAITS;
  - the instruction files, the three skills (re-record the seven skill-tree
    goldens) and the pack (`yo context`);
  - a banner on `REF_REFERENCE_SEMANTICS.md`, and amendments to
    `ARC_TYPE.md`, `PARALLELISM_RULES.md` D2/D3 and `MEMORY_SAFETY.md`'s
    "RC-managed types" list.

## 7. Migration recipes

| Today | After | Found by |
| --- | --- | --- |
| a plain parameter of an owning type that only reads | `imm(x) : T` | V3b `yo fix` sweep |
| `inout(x) : T`, `inout(self)` | `mut(x) : T`, `mut(self)` | V3b sweep |
| `own(x) : T` / `sink(x) : T` | `x : T` | V3b sweep |
| `T :: ref(struct(...))` mutated through one handle only | `T :: struct(...)`, mutators `mut(self)` | E0908 audit |
| `T :: ref(struct(...))` held in two places on purpose | `struct(...)` plus `Rc(T)` at the sharing site | E0908 audit, `__yo_ptr_eq` sites |
| `T :: atomic(ref(struct(...)))` shared across threads | `Arc(T)` over a value `T` (requires `T <: Sync`) | E0602 at the `Arc` |
| `T :: ref(enum(... Self ...))` | `enum(... Box(Self) ...)`, or `Rc(Self)` for the large compiler trees | V4 list |
| `Box(T)` whose copies must alias | `Rc(T)` | V1 step 1 renames all; step 2 moves recursion back |
| an implicit copy of a `String`, collection, `Box` or `Dyn` whose source lives on | `x.clone()`, a move, or `imm(y) := x` | E0901 + note (V2b) |
| an implicit `Rc`/`Arc` copy | `r.clone()` | E0901 (V2c) |
| `Dispose where(Self <: Rc)` | `Dispose` on a move-only value | V3 impl check |
| a resource copied (`m2 := m`) | `Arc(Mutex(T))`, `clone()`, or `mut` | E0901 + note |
| a `match` on an owned local that is used afterwards | `match(&x, …)` | E0901 at the later use (V3b) |
| a named place passed to an `imm`/`mut` parameter | `f(&x)` / `f(&mut x)` | the decision 33 mismatch error (V3b `yo fix`) |
| `&x` making a raw pointer (unsafe code) | `addr_of(x)` | V3b Generation A rename |
| a payload extracted from a dying value | `match(x, .Some(v) => v, …)`, the by-value default | — |
| `Box(T)(v)` / `Arc(T)(v)` in user code | `box(v)` / `arc(v)`; `box(v, alloc : .Some(a))` | docs and skills; E0405 after V5 |
| `with_allocator(a, () => box(v))` for one cell | `box(v, alloc : .Some(a))` | review |
| `rc(x)` (the count) | `ref_count(x)` on an `Rc`/`Arc` | done (#1186) |
| a future awaited twice, or by two tasks | await once; share the result as `Rc(JoinHandle(T))` | E0901 at the second use |
| a `JoinHandle` copied, or joined twice | one owner; `join(h, io)` consumes it | E0901 |
| `race(handles, io)` then reusing `handles` | `match(io.await(race(handles, io), io), (w, rest) => …)` | E0901 at the reuse |
| a method whose returned future mutates `self` | `mut(self)`, awaited at the call (A2) | the capture audit |
| an `io.async` body writing a captured collection | `mut` if the future is awaited directly; otherwise return it, or `Rc(...)` | the capture audit |
| a borrowing future through an `Rc` (`shared.s.next(io)`) | own the value in the task, or `Rc(Mutex(S))` | the A2 compile error |
| a deadline on a borrowing future | `timeout(rx.recv(io), d, io)`, awaited directly | — |
| a cursor loop cloning each node | `mut(cur) := …; mut(cur) = n.next` | review; the clone lint |

## 8. Risks

- **Migration size.** Every implicit copy of an owning value whose source
  lives on becomes an error. The §6 measurement sizes it before the phases
  do. Diagnostics and `yo fix` insert `.clone()` where a copy is wanted, but
  many sites want a move or a borrow, which is the point of looking.
- **A forgotten `imm` (decision 30).** It surfaces at the caller as E0901,
  and the easy fix is a silent `.clone()`. The note must name `imm(x)` in
  the callee first, and decision 27's lint catches clones that elision
  would remove.
- **`yo fix` inserting `.clone()`.** This is the same failure mode at
  scale: a tool that inserts a clone wherever one compiles. About 73% of
  the measured sites want a clone, and the rest want a move or a borrow.
  Decision 27's lint therefore lands in the sweep's own PR, and the sweep's
  output is reviewed by category, not by site count.
- **Local and re-pointed borrows** (decisions 18 and 25).
  - The exclusivity diagnostics must read well.
  - The "reached from `cur`" rule must see through pattern bindings and
    projections. If it is too narrow, cursor loops fall back to clones; if
    too wide, it is unsound.
  - The PR carries negative tests: re-pointing to a sibling root, and to a
    place a callee could reach.
- **The compiler's trees (decision 21).** With `Rc` children, `check ./src`
  time and RSS should stay flat. V4 measures each tree.
- **Auto-dereference precedence.** Decision 32 makes a wrapper/payload name
  clash an error. So the risk is the error's text: it must name both
  spellings, and `yo fix` must offer them.
- **Move-only in generic std code.** Errors raised at instantiation inside
  std must read well. `_reported_at_user_call` anchors them at the user's
  call.
- **Performance.** Every phase records `check ./src` time and stage-2 RSS,
  and stops if they regress past the ratchet.

## 9. Open questions

No design question is open. The last two were decided as decisions 31 (the
child wrapper in patterns) and 34 (operator operands). Decision 18 was also
amended to place-based exclusivity.

**Parked with the phase that decides them.** These are smaller choices
inside a settled design:
- **A6:** what the bundle copy does with an `Rc`/`Arc` field: clone it,
  or make bundles explicit-copy. Decided in V2c.
- **§3.10:** whether `pragma(Pragma.StrictBorrow)` is deleted or kept for
  `Rc` roots. Decided in V2b, when the collections' headers go.
- **§3.11:** whether the containers' `new_in`/`with_capacity_in` move to
  the constructors' `alloc` parameter. Decided after V2b.
- **A closure capture list,** if a Yo-shaped spelling is proposed
  ("Considered and kept implicit", §4).
