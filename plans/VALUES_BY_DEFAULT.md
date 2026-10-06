# Values by default: sharing is visible in the type

**Status: ACTIVE.**
- **Direction:** approved by the maintainer on 2026-10-03.
- **Pivot:** on 2026-10-05, unique ownership (Hylo's model, Mojo's
  spelling) replaced the first draft's copy-on-write design.
- **Decisions:** all 38 in §4 are confirmed. No design question is open;
  the sub-decisions parked with the phase that settles them are listed in
  §9.

Consolidated 2026-10-05: this document states the current design only. The
copy-on-write design, the superseded decision texts and the analyses of
rejected alternatives are in git history (this file at commit 7e0efc70f, and PRs
#1153–#1212).

Progress:
- **Landed:**
  - V1 Generation A (#1186, #1188, #1191, #1207);
  - V1 step 1 Generation A, the `Rc` names (#1232);
  - V2a (#1204);
  - V3's compiler Generation A (#1217);
  - V3b Generation A (#1240);
  - decision 32 Generation A, `Rc.clone(w)` (#1241);
  - the §6 measurement (#1220). Its call-site pass is deferred.
- **In progress:**
  - the Generation A wave: decision 35's capture lists with decision 38's
    rules, then decision 37's `FnOnce`; decision 36's `Copy`; the
    `Send`/`Sync` split with decision 38 E; local borrows (`imm(y) :=`,
    decision 25);
  - V3's remaining async work (§3.13).
- **Next:** v0.2.53, then the Generation B sweeps (the Box→Rc rename,
  decision 32's clash error, the V3b sweep and flip).
- **Rule for this header:** the PR that lands a phase moves its line from
  "In progress" to "Landed".

- Builds on [`plans/STRING_VALUE_SEMANTICS.md`](STRING_VALUE_SEMANTICS.md):
  S1, S2, S3a (#1190) and S4 (#1175) have landed, and S3b is dropped (§0 below).
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
| **implicitly copyable** (`Copy`, decision 36) | implements `Copy`: integers, floats, `bool`, `rune`, raw pointers, `str` views and `fn` pointers (prelude impls); a struct, enum or newtype that opts in with `derive(T, Copy, Clone)` (`Copy` requires `Clone`); and tuples, arrays, anonymous records and closures whose parts are all `Copy` | a bitwise copy | `p2 := p` for `p : Point` with `derive(Point, Copy, Clone)` |
| **explicit-copy** | owns a buffer: `String`, the collections, `Box(T)`, `Dyn(Trait)`, `Rc(T)`/`Arc(T)` handles (decision 17), and any type containing one (unless it is move-only) | an error unless it is the value's last use (then a move); an independent copy is `x.clone()` | `t := s.clone()` |
| **move-only** (§3.4) | implements neither `Copy` nor `Clone` (decision 36); a `Dispose` type is never `Copy` | an error unless it is the last use; with `Clone` it is explicit-copy instead (`Sender`) | `f2 := f` moves the `File` |

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
    `a == b` and `a + b` keep both operands. Each operator's trait declares
    them `imm`, and an impl on an implicitly copyable type may take them by
    value instead (`Point op(Point, Point)`).
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
  - Through a raw pointer, field reads and calls of function-typed
    pointee fields auto-dereference, and method calls do not (E0610). A
    member name the pointer and its pointee both have is decision 32's
    clash error, which covers raw pointers (decision 36).
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

- **Amended by decision 36 (2026-10-05).** After decision 36's
  Generation B, a type is move-only when it implements neither `Copy` nor
  `Clone`, and the `MoveOnly` marker below is deleted. The text below
  describes the V3 compiler as landed (#1217).
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

All 38 are confirmed by the maintainer. A change is a dated amendment here
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
   - **Amended 2026-10-05 by decision 36.** Move-only becomes "neither
     `Copy` nor `Clone`", and the `MoveOnly` marker is deleted in decision
     36's Generation B.
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
    copy is explicit.** Requiring `.clone()` on `i32`, as Hylo does, buys
    nothing.
    - **Amended 2026-10-05 by decision 36.** The first version made the
      rule structural (no heap, no `Dispose`) with no annotation. Now a
      named type copies implicitly only if it implements `Copy`. Anonymous
      composites stay structural.
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
      log(s2)`, or with a capture list `{ s2 : s.clone() }() => log(s2)`
      (decision 35).
    - Writing through a borrowed capture is E0908. A `mut` capture exists
      only in a capture list, and only on a non-escaping closure (decision
      35, amended 2026-10-05).
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
    - **No `FnMut`.** A closure body never writes its own captures. State
      goes through a `mut` capture (decision 35), an `Rc` capture or a `mut`
      parameter. A `mut` capture writes through the captured pointer, not
      the closure's environment, so the call stays `imm(self)`. Decision 37
      gives the reasons.
    - **`FnOnce` is added by decision 37** (amended 2026-10-05). The first
      version also had no `FnOnce`, so a body could not move a capture out.
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
    - **A borrow is a mode, never a type** (the maintainer, 2026-10-05).
      Making `&T`/`&mut T` types, as Rust does, with `x : &String` replacing
      `imm(x) : String` and `impl(&String, Add(…))` possible, was considered
      and rejected:
      - **Without lifetimes, a borrow type leaks.** `ArrayList(&String)`,
        `Option(&T)`, a field `r : &T`, and a generic `T := &String` would
        all be expressible. Keeping them second-class would need a new "type
        that cannot be stored" kind, checked at every instantiation and
        field. Hylo, Swift and Mojo keep conventions out of types for the
        same reason.
        - *Amended 2026-10-06 by decision 38 A.* Decision 38 builds that
          check for closure and future types, which are nameable through
          `type_of`. So "it would need a new kind" no longer argues against
          borrow types by itself. The decision stands on the other three
          reasons: a C signature readable from the Yo signature, operators
          that would consume their operands, and auto-ref probing.
      - **The C would stop being readable from the signature.** In
        `fn(x : T)` with `T := &String`, `x` is a pointer, which defeats
        this decision's reason.
      - **Operators would consume.** Rust's operator traits take their
        operands by value, so `String + String` moves both. Keeping them
        means `&a + &b`, or four impls per pair. Decision 34 gives
        per-impl modes without that.
      - **Method lookup would need auto-ref/auto-deref probing** to choose
        between `impl(String, …)` and `impl(&String, …)`. That is a hidden
        rule.
      - **The `&` spelling as a mode** (`x : &String` that is not a type)
        was also declined. It would put a non-type in type position, and
        Rust readers would expect `Option(&T)` to work. The words
        `imm`/`mut` say "mode", and the sigils stay at arguments and
        scrutinees (decision 33).
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
    - **Raw pointers are covered too** (amended 2026-10-06, decision 36).
      If `p : *(T)` and both the pointer and `T` have a member `m`, then
      `p.m` is an error naming `p.*.m()` for the pointee's member and the
      implicit copy `q := p` for the pointer. In practice the only shared
      names are `Clone`/`Copy` members against a function-typed pointee
      field, because method calls through a pointer do not auto-dereference
      today. This part needs no seed and lands in decision 36's Generation A
      (see its "Raw pointers and `clone`" bullet).
    - **This is Rust's convention, made a rule.** Rust's `w.clone()` on an
      `Rc` compiles and means the handle copy. The Rust book recommends
      `Rc::clone(&w)`, and clippy's `clone_on_ref_ptr` lint enforces it, so
      that a cheap handle copy reads differently from a deep clone. Yo
      rejects the ambiguous form outright.
    - **The spelling needs one small feature:** calling a method through an
      unapplied generic type constructor, with its arguments inferred from
      the receiver (`Rc.clone(w)`, as Rust infers `Rc::clone`'s `T`).
      Landed as V1 Generation A (§6 V1); before it, `Rc(T).clone(w)`
      worked and `Rc.clone(w)` was E0610.
    - **Phase.** The unapplied-constructor call is V1 Generation A. The
      clash error and the call-site sweep are Generation B, after a
      `SEED_VERSION` carries Generation A, since the sweep writes
      `Box.clone(w)` into `src/` and `std/`.

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
      - operator operands, which no operator consumes or writes
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
      - **The `Comptime*` twins are out of scope.** Their operands are
        `comptime(lhs)`/`comptime(rhs)`, compile-time values with no run-time
        convention and no C signature, so `imm` has nothing to say about
        them. They are `ComptimeAdd` through `ComptimeBitXor`, `ComptimeEq`,
        `ComptimeOrd`, `ComptimeNegate`, `ComptimeLogicalNot`,
        `ComptimeBitNot` and the two `ComptimeRange*` traits. The sweep
        leaves them unchanged.
      - **Operand names.** The binary traits name their operands `lhs` and
        `rhs` (`std/prelude.yo`), and the unary traits name theirs `self`.
        An impl may name its first operand `self`, as std's do; the name
        does not change the mode. The rule covers every operand alike, so a
        binary operator has no receiver in decision 30's sense.
    - **An impl may take an implicitly copyable operand by value**
      (amended 2026-10-05 by the maintainer). Where the trait declares
      `imm(x) : T` and `T` is implicitly copyable, the impl may write
      `x : T` instead:
      ```rust
      impl(Point, Add(Point)(
        Output : Point,
        (+) : (fn(lhs : Self, rhs : Self) -> Self)(...)             // Point op(Point, Point)
      ));
      impl(String, Add(String)(
        Output : String,
        (+) : (fn(imm(lhs) : Self, imm(rhs) : Self) -> Self)(...)   // String op(const String*, const String*)
      ));
      ```
      - **Why it is sound.** For an implicitly copyable type, a copy keeps
        every promise an `imm` borrow makes: the caller keeps its value,
        and nothing the callee does reaches it. The by-value impl is the
        cheaper way to meet the trait's contract.
      - **Why it is wanted.** Without it, every small value type behind an
        operator is passed by pointer. A `Point` of two `i32`s fits in one
        register, but by pointer the caller stores it to memory first, and
        only inlining removes the indirection.
      - **The C stays readable.** The impl's own signature is its C
        signature, as decision 30 requires. The impl's author chooses, and
        the compiler never picks a lowering.
      - **The check.** A by-value operand whose type is not implicitly
        copyable is an error, because it would consume the caller's
        operand. The error names `imm(x)`. An operand written `mut(x)` is an
        error, because no operator writes an operand.
        - **Concrete operand types** are checked at the impl.
        - **A generic impl's operand** (`Vec2(T)` by value) states its
          requirement as a bound and is checked at the impl (amended
          2026-10-05 by decision 36):
          ```rust
          impl(generic(T : Type), where(T <: Copy), Vec2(T), Copy());
          impl(generic(T : Type), where(T <: Copy, T <: Add(T)), Vec2(T), Add(Vec2(T))(
            Output : Vec2(T),
            (+) : (fn(lhs : Self, rhs : Self) -> Self)(...)
          ));
          ```
          Without the bound, `Vec2(T)` is not known to be `Copy`, and the
          by-value operand is the error at the impl, naming
          `where(T <: Copy)` or `imm(x)`.
        - Until decision 36 lands, the check runs per instantiation, as
          the rest of Yo's generic code does (§3.4). That is the interim
          rule.
      - **Call sites are the same either way.** An operator takes no marker,
        and a generic body is specialized per instantiation, so `a + b`
        calls the concrete impl with its own convention.
      - **`Dyn` is unaffected.** A vtable slot's type comes from the trait,
        never from an impl, so an `imm` operand is `const T*` in the slot
        for every impl.
        - Each impl already gets a wrapper, `__yo_wrap_<impl>_<method>`
          (`generate_dyn_wrapper_functions`, `src/codegen/functions/dyn.yo`).
          The wrapper is defined with the slot's signature and forwards to
          the impl, adapting where the two spellings differ (`arg_casts`).
        - A by-value impl adds one more adaptation: its wrapper passes
          `*argN` where the slot has a pointer. That is one load per call
          through a `Dyn`, which already pays an indirect call.
        - The receiver is `void* self_ptr` in every slot already, whatever
          the impl's receiver mode.
        - **Which operators have a slot** (corrected 2026-10-05; #1229 said
          `Eq(String)`'s `(==)` had one, and it does not):
          - A slot needs a first parameter labelled `self` in the trait
            (`dyn_member_is_method`, `src/types/utils.yo`). The binary
            traits label theirs `lhs`, so no binary operator is callable
            through a `Dyn` today.
          - `dyn_member_unsafe_reason` also drops a member whose result
            mentions `Self`, which removes `Negate` and `BitNot`
            (`Self.Output`).
          - That leaves `LogicalNot`'s `(!)`, which takes `self` and returns
            `bool`.
          - The wrapper rule covers any operator member that gains a slot
            later.
        - Test: a `Dyn(LogicalNot)` over a by-value impl negates
          correctly.
      - **Only for the operator traits.** A named method's call site carries
        decision 33's marker. If an impl could change a parameter's mode,
        `p.eq(&q)` through the trait and `p.eq(q)` against the concrete
        type would disagree. Extending the rule to every trait method would
        need its own marker decision.
    - **No marker at the operator.** `a == b` and `a + b` never consume or
      write an operand, whichever mode the impl chose.
      - The operator itself is the marker, as `.` is for a receiver
        (decision 33).
      - A `&` on an operand is an error.
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
        because `+` on an owning type would then consume silently;
      - `imm` for every impl, which puts small value types behind a
        pointer;
      - impls on borrows, Rust's `impl Add for &String`, which doubles the
        impl surface for a borrow Yo does not make first-class;
      - a mode parameter on the trait (`Add(Rhs, mode)`), heavy machinery
        for one rule.
    - **Indexing is not covered:** `xs(i)` is a projection (decision 24).
    - **Phase.** V3b.
      - Generation A adds `imm` to the traits' operands. It also adds the
        impl check: `imm`, or by value for an implicitly copyable type.
        Today's plain parameters already borrow, so no program changes
        behaviour.
      - The Generation B sweep rewrites the operands of operator impls on
        types that are not implicitly copyable to `imm`. The impls on plain
        data keep their by-value operands.
      - Tests:
        - a by-value `Point` `+` emits `Point op(Point, Point)`;
        - a `String` `+` emits `const String*` operands;
        - a by-value `String` operand is the impl error;
        - a `mut` operand is an error;
        - generic `a + b` calls each impl with its own convention.

35. **A closure may carry a capture list: a record literal before its
    parameters.** Proposed and confirmed 2026-10-05 by the maintainer.
    - **The form.**
      ```rust
      h := { x, imm(y) : &y, mut(z) : &mut z }(m : i32) => (x + y + z + m);
      h2 := { s2 : s.clone() }() => log(s2);
      xs.for_each({ mut(count) }(x : i32) => { count = (count + x); });
      ```
      - **Desugaring.** The parser already rewrites `{...}` to `_(...)`, so
        `{...}(params) => body` is `_(...)(params) => body`.
      - A record is not callable, so the shape is new and ambiguous with
        nothing.
    - **Vocabulary.** It follows decision 33's split. The left of an entry
      declares a field, so it takes the words (`imm(y)`, `mut(z)`). The
      right initializes it, like an argument, so it takes the sigils (`&y`,
      `&mut z`).
    - **Puns, like `{ x }` for `x : x`:**
      - `imm(y)` is `imm(y) : &y`, and `mut(z)` is `mut(z) : &mut z`.
      - The long form renames a capture or captures a projected place:
        `imm(name) : &self.name`.
    - **Entries:**
      - **`x` (or `x : e`) is by value.** Plain data copies. An owning value
        moves at its last use; otherwise it is E0901, and the note names
        `x : x.clone()`.
      - **`imm(y) : &p` and `mut(z) : &mut p` borrow a place.** A borrow of a
        temporary is an error (`imm(t) : &make_name()`), because the
        temporary dies before the closure does.
      - Any other initializer is an ordinary by-value field: `n :
        s.len()`, `s2 : s.clone()`.
    - **The list is exhaustive.**
      - With a list, the body may name only the listed captures and
        module-level items.
      - `{}()` captures nothing, which asserts the closure is pure of local
        state.
      - Without a list, decision 22's rules are unchanged: a literal passed
        to an `imm(f)` parameter borrows implicitly.
    - **The closure's kind follows its capture record** (decision 22's
      structural rule):
      - An `imm` or `mut` capture makes the closure second-class. It cannot
        be stored, returned, spawned, or passed to a by-value (escaping)
        parameter. In `io.async`, it is a borrowing future (§3.13 A2).
      - A `mut` capture also makes it move-only, because two copies of one
        exclusive borrow would alias. `imm` captures copy freely.
      - The borrows follow decisions 18 and 28. A captured place is frozen
        for the closure's live range, and a closure argument overlaps
        everything it captures, so `g(&f, &mut z)` stays an error.
    - **`mut` captures on non-escaping closures are new.** This amends
      decision 22, which forbade `mut` captures, and decision 23.
      - It is sound for the reason Swift's non-escaping closures may
        capture `inout`: the closure cannot outlive the borrow, and nothing
        else reaches the place while the closure is live.
      - A call writes through the captured pointer, so `Fn`'s call stays
        `imm(self)` and no `FnMut` is added (decision 37 explains why).
      - It replaces the `Rc` counter that a `for_each` body needs today.
    - **Parsing.** `{ x, y } => …` is a record pattern in a `match` arm.
      `{…}(params) => …` is accepted only where a closure is expected, and
      an arm pattern of that shape is an error. A parser test covers both.
    - **Rejected:**
      - `[imm(s), t]() => …` (C++/Rust style), which does not fit Yo's
        syntax;
      - leaving the capture mode implicit only, which was deferred until a
        Yo-shaped spelling appeared.
    - **Phase.** V3b. It needs the `imm`/`mut` words and the `&` sigils, so
      Generation A adds the form, and the V3b sweep needs no migration for
      it.
    - **Tests:**
      - each entry kind;
      - the puns;
      - exhaustiveness (naming an unlisted local is an error);
      - an escaping closure with a borrow capture is an error;
      - a `mut` capture counter through `for_each`;
      - copying a `mut`-capturing closure is E0901;
      - `g(&f, &mut z)` is an overlap error;
      - the `match`-arm parse.

36. **Implicit copy is a trait: `Copy`.** Confirmed 2026-10-05 by the
    maintainer. A named type copies implicitly only if it implements
    `Copy`, as in Rust. This replaces decision 16's structural rule for
    named types.
    - **Why.**
      - **The author promises the copy as part of the API.** Under the
        structural rule, adding a private `String` field to a public
        struct silently turned every caller's `p2 := p` into E0901.
      - **Some plain-data types should not copy** although they could: an
        `Fd(i32)` without a `Dispose`, a type-state token, an arena index
        that must stay unique, an `Array(u8, 4096)`.
      - **Generic code can state the requirement** (`where(T <: Copy)`),
        so decision 34's by-value operand check runs at the impl, not per
        instantiation.
      - "Explicit whenever we can" (the maintainer).
    - **The rule.**
      - `Copy :: trait(where(Self <: Clone))` is a prelude marker with
        `Clone` as its supertrait, the same `where(Self <: …)` declaration
        form other traits use (docs/en-US/DESIGN.md). So **`where(T <: Copy)`
        implies `T <: Clone` in a generic body**, as `T: Copy` does in Rust:
        `x.clone()` needs no second bound. If the seed cannot compile the
        supertrait form in `std/prelude.yo`, Generation A expands the bound
        in the compiler, and the declaration follows in Generation B.
      - A struct, enum or newtype opts in with `derive(T, Copy, Clone)`, or
        with `impl(T, Copy())` beside a `Clone` impl. A generic type uses
        `impl(generic(T : Type), where(T <: Copy), Pair(T), Copy())`.
      - **The impl is checked.** Every field, payload and element must be
        `Copy`, and the type must not implement `Dispose`, which is Rust's
        `Copy`/`Drop` exclusion. A failing impl is an error naming the
        first non-`Copy` part.
      - **`Copy` and `Clone`** (amended twice on 2026-10-06 by the maintainer.
        The first text rejected `derive(T, Clone)` on a `Copy` type, which
        made a conditionally `Copy` generic type impossible to write. The
        second amendment makes `Copy` require `Clone`, as in Rust.)
        - **`Copy` requires `Clone`**, Rust's `Copy: Clone` supertrait.
          `impl(T, Copy())` needs a `Clone` impl that covers the same
          instantiations. `derive(T, Copy)` without `Clone` is an error
          naming `derive(T, Copy, Clone)`. The compiler never synthesizes a
          `Clone` impl.
          - **Why.** A synthesized impl is an implicit one:
            `Type.impls(Point, Clone)` would be true, and `where(T <: Clone)`
            would accept `Point`, with no `Clone` in the source.
          - Synthesis also needs coherence rules for impls nobody wrote: an
            inherited conditional bound, and no overlap with a derived or
            hand-written generic `Clone`. A supertrait check is one rule.
          - `derive(T, Copy, Clone)` is what Rust programmers, and agents,
            already write.
          - The cost is one word per `Copy` type, added by the decision 36
            sweep.
        - **`derive(T, Clone)` is allowed.** A derived clone is field-wise,
          and for `Copy` fields that is exactly the bitwise copy, so it
          cannot diverge. It is the spelling for a type that is `Copy` only
          under a bound:
          ```rust
          Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
          derive(Pair(T), Clone);                                      // Pair(String) needs it
          impl(generic(T : Type), where(T <: Copy), Pair(T), Copy());  // Pair(i32) is also Copy
          ```
        - **A hand-written `Clone` is an error only on a type that is `Copy`
          for every instantiation:** a concrete `Copy` type such as
          `Point`, or a generic type whose `Copy` impl has no bound. There
          the impl can only be redundant or divergent (`log("cloning")`),
          and a divergent one would break the rule that cloning a `Copy`
          value is the copy. Generic code calling `x.clone()` on a `Copy`
          `T` relies on that rule. Decision 27's elision does not, because
          it only elides compiler-known clones. The error names
          `derive(T, Clone)`.
        - **A generic hand-written `Clone` that also serves non-`Copy`
          instantiations is allowed.** The prelude `Option(T)`'s
          `.Some(v) => .Some(v.clone())` is one: at a `Copy` `T` its
          structural clone reduces to the copy.
        - **The one difference from Rust.** Rust's documentation says a
          `Copy` type's `Clone` must equal the copy, but leaves divergence
          to a Clippy lint (`expl_impl_clone_on_copy`). Yo enforces it in
          the one case that can be checked without breaking generics.
      - **Prelude impls,** each beside its `Clone`: the integers, floats,
        `bool`, `rune`, `unit`, raw pointers, `fn` pointers and `str` views;
        `Option(T)` and `Result(T, E)` with `where(T <: Copy)` (and
        `E <: Copy`).
      - **Raw pointers and `clone`** (corrected 2026-10-06; the first text
        said `p.clone()` auto-dereferenced to the pointee today, which is
        false).
        - **Today:** a method call through a raw pointer does not
          auto-dereference. `q.clone()` on a `*(Point)` is E0610, because
          receiver resolution skips pointer receivers
          (`src/evaluator/calls/function.yo`, the `!is_pointer_type` guard).
          A field read (`q.x`) and a call of a function-typed pointee field
          (`q.getv()`) do auto-dereference.
        - **So `*(T)`'s new `Clone`, a pointer copy, changes no working
          program's meaning,** except one corner: a pointee field of
          function type named `clone` (or another `Clone`/`Copy` member
          name), called through a pointer.
        - **That corner gets decision 32's clash rule:** a member both the
          pointer and its pointee have is an error at `p.m`, naming
          `p.*.m()` for the pointee and the implicit copy `q := p` for the
          pointer.
        - **Timing.** The pointer `Copy`/`Clone` impls and this pointer clash
          error land together in decision 36's Generation A. Neither needs
          the seed: the suggestions are `p.*.m()` and `q := p`, not
          decision 32's unapplied-constructor call. So `where(T <: Copy)`
          accepts raw pointers from Generation A on.
        - The count of affected call sites (pointer-through calls of a
          pointee fn-field with a clashing name) is expected to be about
          zero. It is measured and reported in the Generation A PR.
      - **Structural for anonymous composites.** Tuples, `Array(T, N)`,
        anonymous records `_(...)` and closures (their capture records)
        have no declaration to annotate. Each is `Copy`, and `Clone`, when
        all its parts are. Rust does the same for tuples, arrays and
        closures.
      - **Never `Copy`:** `Rc`, `Arc`, `Box`, `String`, the collections,
        `Dyn`, and every type with a `Dispose`.
    - **The three kinds become Rust's** (§0.2):
      - **`Copy`:** copies implicitly.
      - **`Clone` without `Copy`:** explicit-copy.
      - **Neither:** move-only.
      - The `MoveOnly` marker (decision 2) and its structural derivation are
        deleted, and `type_requires_explicit_copy` becomes
        `!(T <: Copy)`. Only cloning keys on `Clone`.
    - **First measurement.** Count the named plain-data types in `src/`,
      `std/` and `tests/` that are copied implicitly today, which are the
      types that need `Copy`. Do it with an audit flag like §6's before
      the sweep PR is opened.
      - **Its blind spots are §6's.** Files that fail `check` report
        nothing, and a generic body counts only where something
        instantiates it. A plain-data type the audit misses flips to move
        semantics at the flip. The result is E0901 at call sites the sweep
        never touched, an error rather than corruption, and the diagnostic
        names `derive(T, Copy, Clone)`. The sweep PR therefore lists its
        uncovered files.
      - **What "today" means.** Count after the V3b flip. By then a plain
        parameter of an implicitly copyable type is a by-value copy, and
        those copies count.
    - **Phase.** Before V2b, which widens the same predicate to `String`
      and the collections.
      - **Generation A:**
        - the prelude `Copy` trait and its impls;
        - the impl check;
        - the `Copy: Clone` supertrait check and its error;
        - the `derive` rule.

        The seed sees `Copy` as an ordinary marker trait, so `std/` and
        `src/` may add their impls at once.
      - **Generation B:**
        - the `yo fix` sweep, which adds `Copy`, plus `Clone` where it is
          missing, to every named type that is copied implicitly today;
        - the flip: a named type without `Copy` is no longer implicitly
          copyable;
        - deleting `MoveOnly`.
    - **Tests:**
      - a `derive(Point, Copy, Clone)` copy;
      - `derive(Point, Copy)` without `Clone` is the error naming
        `derive(Point, Copy, Clone)`;
      - a plain struct without `Copy` moves, and a later use is E0901;
      - `impl(T, Copy())` over a `String` field is an error;
      - `Copy` plus `Dispose` is an error;
      - a hand-written `Clone` on a concrete `Copy` type is an error naming
        `derive(T, Clone)`;
      - `Pair(T)` with `derive(Clone)` and a conditional `Copy` works at
        both `i32` (implicit copy) and `String` (explicit `.clone()`);
      - the prelude `Option(i32)` stays `Copy` with its generic `Clone`;
      - a generic `where(T <: Copy)` operator impl;
      - a tuple of `Copy` parts copies implicitly;
      - a closure whose captures are all `Copy` copies implicitly.

37. **`FnOnce` is added; `FnMut` is not.** Confirmed 2026-10-05 by the
    maintainer. This amends decision 23.
    - **Background.** Rust's three closure traits differ only in how a call
      uses the closure's own environment:

      | Rust | The call takes | Used for |
      | --- | --- | --- |
      | `Fn` | `&self` | reading captures |
      | `FnMut` | `&mut self` | writing the closure's own state |
      | `FnOnce` | `self` | moving a capture out |

    - **`FnOnce(...)`.**
      - Its call takes `self`, decision 30's consuming receiver.
      - A closure whose body moves a capture out (`{ tx, msg }() =>
        tx.send(msg)`) implements only `FnOnce`. Calling it consumes it,
        and a second call is E0901, pointing at the first.
      - **`Fn` implies `FnOnce`.** A borrowing call also serves for one
        call, so an escaping API that calls its argument once takes
        `Impl(FnOnce(...))` by value and accepts both kinds. A non-escaping
        API cannot take `FnOnce`, because a consuming call cannot go
        through `imm(f)` (decision 38, amended 2026-10-06).
      - **Which trait a closure gets follows from its body**, by decision
        22's structural rule: does the body move a capture out? There is
        no annotation. A mismatch (an `FnOnce`-only closure passed where
        `Fn` is required) is an error naming the line that moves.
      - **The order is fixed** (decision 38, audit N5), because the trait
        and the captures' modes inside the body would otherwise be defined
        in terms of each other:
        1. Scan the by-value, non-`Copy` captures for move positions:
           - §0.2's move points (a by-value argument, a store, a binding, a
             tail or `return`);
           - a consuming receiver;
           - a bare `match(x, …)` or `for(x, …)`;
           - `dyn(x)`.
        2. Any hit makes the closure `FnOnce`-only, and its body owns the
           destructured captures. Captures it does not move drop when the
           call ends.
        3. Otherwise the body is typed with the captures as `imm` bindings.
           A move out is then E0901, and a `match` is matched through the
           borrow.

        `match(&x, …)` keeps the closure `Fn`.
      - `Dyn(FnOnce(...))` is move-only, and its slot consumes the payload.
    - **Why `FnOnce` is needed.**
      - Moving out of a capture is about ownership, not mutation, and
        nothing else expresses it.
      - Without it, `tx.send(msg)` in a spawned closure is
        `tx.send(msg.clone())` (a wasted copy), or an `Option` plus `take`
        through a `mut`/`Rc` capture (noise).
      - One-shot callbacks are common: thread and task spawns, the
        `Option`/`Result` combinators, `with_lock`'s body.
    - **Why no `FnMut`.** In Rust, an `FnMut` closure is a value whose own
      state changes on every call. Yo never needs one, because every use
      has an explicit spelling:
      - **Mutating outside state from a non-escaping closure:** a `mut`
        capture (decision 35), e.g. `xs.for_each({ mut(count) }(x : i32) =>
        { count = (count + x); })`.
        - The closure is second-class and move-only, so it cannot escape or
          be duplicated.
        - It is not `Sync`, so a parallel `for_each` that requires
          `Impl(Fn(...), Sync)` rejects it.
        - Those are exactly the hazards `FnMut`'s `&mut self` guards
          against in Rust: two callers of one stateful closure, and a call
          that runs while another is live.
        - The call writes through the captured pointer, never the
          environment, so `imm(self)` stays honest.
      - **An escaping closure with private state** (Rust's `move || { n +=
        1; n }` returned as `impl FnMut`):
        - an `Rc` capture, `{ n : rc(0) }() => { n.* = (n.* + 1); n.* }`,
          whose sharing and allocation are visible;
        - or a named struct with a `mut(self)` method, which is what Yo's
          iterators already are.

        Both cost a little more than Rust's version, which is the point:
        state that changes across calls is never hidden inside a value
        that looks like a function.
      - **Worked example: a counter.** What decision 37 rules out is only
        that a closure's own captured variables change between calls. The
        state lives where the closure points, or the counter is a named
        type. The choice follows from whether it escapes:
        ```rust
        // 1. Non-escaping: a mut capture (decision 35). No allocation.
        n := 0;
        tick := { mut(n) }() => { n = (n + 1); n };
        tick(); tick();                       // n == 2

        // 2. Escaping, as a closure: the state lives in an Rc cell the closure holds.
        make_counter :: (fn() -> Impl(Fn() -> i32))({
          n := rc(0);
          { n }() => { n.* = (n.* + 1); n.* }
        });

        // 3. Escaping, with no allocation: a named struct. This is what
        // Rust compiles an FnMut closure to anyway.
        Counter :: struct(n : i32);
        impl(Counter, next : (fn(mut(self)) -> i32)({ self.n = (self.n + 1); self.n }));
        c := Counter(n : 0);
        c.next(); c.next();
        ```
        - **What is lost.** No capability, and no run-time cost: form 3
          is the machine code of Rust's `FnMut` closure, which is itself an
          anonymous struct with a `&mut self` call method.
        - **The one case that is longer:** an escaping closure that keeps
          its own state and must not allocate. It is written as form 3, or as
          form 2 at the cost of the `Rc` allocation. Lazy adapters that store
          their closure, std's `StreamMap`/`StreamFilter`
          (`std/async/stream.yo`) and generators, are where this shows.
        - **If that case proves common, a stateful call is added the way
          Hylo has it,** not as Rust's third trait (recorded 2026-10-05 by
          the maintainer).
      - **Hylo's design.** Hylo
        (https://hylo-lang.org/docs/user/language-tour/functions-and-methods/)
        has three capture kinds, its parameter conventions: `let`, `inout`
        and `sink`.
        - `let` and `inout` captures are inferred from the body. A `sink`
          capture must be listed (`fun[var i = 0]`).
        - A closure that changes its own state is an `inout` lambda,
          `fun[var i = 0]() inout -> Int { … }`, and its call is marked:
          `&counter()`.
        - So Hylo's `FnMut` is the third receiver mode of one call, not a
          third trait.
        - Lambda types carry their environment (`[E]`, or erased), which is
          Yo's `Impl(Fn(...))` versus `Dyn(Fn(...))`.
        - Hylo's issue #1807 (a `let` capture of a temporary,
          `fun[let c = c.copy()]`, used after its lifetime) is the hole
          decision 35 closes by requiring a place for a borrow entry.
      - **The planned addition, if it is ever made.**
        - **One call trait.** `Fn` stays the only call trait, and a
          closure's call takes one of the three receiver modes decision 30
          already has: `imm(self)` (`Fn`), `self` (`FnOnce`), or `mut(self)`
          (the stateful call). The spelling of the `mut` form in a type is
          chosen when it is added. It must name the mode and must not be a
          new trait name.
        - **The body.** A closure whose body writes one of its by-value
          captures gets the `mut(self)` call. A capture list makes its
          initial state explicit: `{ n : 0 }() => { n = (n + 1); n }`.
        - **The call site is unmarked,** like every closure call (see "Calling
          a closure" below): `counter()`, as `xs.push(1)` is unmarked.
          Hylo marks `&counter()` because it also marks mutating method
          calls (`&xs.append(y)`), and Yo exempts receivers (decision 33).
        - **Holding one.** It needs a `mut` place to be called through:
          `mut(f) : Impl(Fn(...))` with the `mut` call, or an owned local.
          An `Fn` (`imm(self)`) closure is accepted wherever the `mut` call
          is required, as `Fn` implies `FnOnce`.
        - **Rejected for that future step:** a separate `FnMut` trait,
          because a third trait name would recreate Rust's three-way split
          in every bound and in `Dyn`.
        - **What would trigger it:** stateful closures stored in lazy
          adapters (`StreamMap`/`StreamFilter`) or generators that are
          common enough that form 3's named struct is a burden.
      - **What leaving it out saves today.** No callback bound, `Dyn` slot
        or closure inference has to handle a third call mode. A closure's
        environment never changes while it lives, and a call either borrows
        it (`Fn`) or consumes it (`FnOnce`). The Hylo-style addition above
        would add the mode to every bound that accepts a stateful closure.
    - **Calling a closure is a receiver call, so it is never marked**
      (amended 2026-10-05 by the maintainer).
      - `f(x)` is `f`'s call method with `f` as the receiver, so decision
        33's receiver exemption applies in every mode:
        - an `Fn` call borrows `f`, like `s.len()`;
        - an `FnOnce` call consumes it, like `h.join()`, and a later use is
          E0901 pointing at the call;
        - a stateful call, if one is added, borrows it exclusively, like
          `xs.push(1)`.
      - The mode is part of the closure's type, as a method's receiver mode
        is part of its signature.
      - Marking only closure calls (`&mut counter()`), or `imm` calls as
        well (`&f()`), would be inconsistent with `s.len()` and
        `xs.push(1)`. Both were rejected.
      - **Passing a closure is an ordinary argument** and takes decision
        33's markers:
        ```rust
        add := { k }(x : i32) => (x + k);
        add(1); add(2);                      // an Fn call: unmarked, add stays usable
        apply :: (fn(imm(f) : Impl(Fn(i32) -> i32), x : i32) -> i32)(f(x));
        apply(&add, 5);                      // lending the closure: marked (after V3b Generation B;
                                             // until then &add to an Impl(...) parameter is the address-of)
        apply((x : i32) => (x * 2), 5);      // a literal is a temporary: exempt
        keep(add);                           // a by-value (escaping) parameter: moves add

        send := { tx, msg }() => tx.send(msg);
        send();                              // an FnOnce call: consumes send
        send();                              // E0901: send was moved by the call above
        run_once(send2);                     // a by-value Impl(FnOnce(...)) parameter: moves send2 in
        ```
      - **A stateful closure (if added) is passed with `&mut`:**
        `step(&mut counter)` to a `mut(f)` parameter. It cannot be called
        through an `imm` borrow, as `xs.push` cannot be called on `imm(xs)`.
    - **std switches to `Impl(FnOnce(...))` only where the closure escapes**
      (amended 2026-10-06 by the maintainer, after the closure audit,
      decision 38):
      - `Thread.spawn` and `ThreadPool.spawn` (`std/thread.yo`), as
        `Impl(FnOnce(...), Send)` by value;
      - the body passed to `io.async`, which runs once as a state machine.
        This is the one stated exception: `io.async(body)` is a by-value
        slot that accepts a second-class body. The future it returns is
        then second-class and follows §3.13 A2. Otherwise the body escapes
        and owns its captures.
    - **Non-escaping call-once APIs keep `imm(f) : Impl(Fn(...))`:**
      - `Option`: `map`, `and_then`, `or_else`, `map_or_else`,
        `unwrap_or_else`, `ok_or_else`;
      - `Result`: `map`, `map_err`, `and_then`, `or_else`, `map_or_else`,
        `unwrap_or_else`;
      - the `with_lock`/`try_with_lock` bodies (`std/sync/mutex.yo`,
        `std/async/mutex.yo`).

      Their bodies may borrow captures, including `mut` captures, but
      cannot move a capture out. A *non-escaping consuming* parameter mode
      (by value, but not allowed to escape) is recorded as a possible
      later addition. It is not adopted, because it would be a fourth
      parameter mode beside `imm`, `mut` and by-value.
    - Callbacks that run per element keep `Impl(Fn(...))` too: `for_each`,
      the iterator `map`/`filter`, comparators and hashers.
    - **Phase.**
      - **Generation A:** the compiler. That means the prelude `FnOnce`
        trait, the "moves a capture out" rule that decides a closure's
        trait, the consuming call, `Fn` implies `FnOnce`, and the
        `Dyn(FnOnce)` slot.
      - **Generation B:** std's signatures switch, once the seed carries
        Generation A. It lands with V3's move-only work, which already
        tracks moves out of captures (`consume_captured_variables`).
    - **Tests:**
      - a spawned closure sends a captured `String` with no clone;
      - a second call of an `FnOnce`-only closure is E0901;
      - passing it where `Fn` is required is the error naming the moving
        line;
      - an `Fn` closure is accepted by an `FnOnce` parameter;
      - `Dyn(FnOnce(...))` is called once;
      - `Thread.spawn` moves a captured value out with no clone;
      - `unwrap_or_else(imm(f))` with an `FnOnce`-only closure is the
        error that names the moving line;
      - one test for each N5 shape: a move out, a bare `match` on a
        capture, a tail return of a capture, and `match(&x, …)`.

38. **Closure soundness rules: the 2026-10-06 audit.** Confirmed
    2026-10-06 by the maintainer. An adversarial audit of decisions 22, 23,
    35 and 37 found that the closure design was not sound as written. It is
    sound with five fixes, A to E, each of which extends a mechanism the
    plan already has. The maintainer chose between alternatives in B, C and
    D.

    **A. Second-class is a structural property of types.**
    - **Which types are second-class.** A closure is second-class when its
      capture record holds a borrow (`imm`/`mut`), or holds a second-class
      value, transitively. The same goes for a tuple, a record, an `Option`
      payload and a generic instantiation: anything that contains a
      second-class value is second-class.
    - **`Copy` is never first-class.** A second-class closure with only
      `imm` captures is `Copy` (decision 36). Its copies are second-class
      too, and a copy carries the same borrows. So:
      - "`Copy`" never implies "may be stored";
      - decision 34's by-value operand exception needs a first-class
        `Copy` type;
      - the second-class check runs per instantiation even in
        bound-checked generics.
    - **Where it may not go.** A second-class value may not be:
      - returned;
      - stored in a field, element or `Dyn`;
      - captured by an escaping closure, implicitly or by value;
      - spawned;
      - passed to a by-value parameter (except `io.async`, decision 37).
    - **Results and assignments.** A block, arm or `cond` result, or an `=`
      target, may not outlive any place its value borrows. Re-assigning a
      second-class local follows decision 25's rule.
    - **Type positions.** A second-class type may not appear as a field
      type, an element type, or a generic argument of a type constructor.
      `type_of(f)` names closure types, so `ArrayList(type_of(f))` is
      checked too. The check runs at the declaration and at every
      instantiation.
    - **Transitive freezes.** A borrow, or any second-class value built
      from one, keeps its source live, and so frozen (decision 18), until
      its own last use. This applies transitively through captures, `Copy`
      copies and re-borrows. If `g` captures `f` and `f` captures
      `mut(z)`, then `z` stays frozen until `g`'s last use.
    - **Borrow sets join.** The borrow set of a second-class local is the
      union over all its reaching definitions, and a scope-end drop of a
      borrowed place is an access.
    - **Re-points.** A re-point of `cur` (decision 25) is an error while
      any borrow derived from `cur`'s current target is live: a capture, a
      local re-borrow, or a borrowing future.
    - **Corrects decision 30's rationale.** Closure types are nameable
      (`type_of`), so "a borrow type would leak" is answered by these
      type-position rules, not by namelessness. Borrows themselves still
      stay modes, never types.

    **B. Exclusivity counts the receiver, and a value carrying a `mut`
    borrow is lent exclusively.** The maintainer chose this over giving
    `mut`-capturing closures a `mut(self)` call. That would break every
    `xs.for_each({ mut(count) }(x) => …)` literal, because a temporary
    cannot go to a `mut` parameter.
    - **The receiver is an argument** for decision 28's overlap check and
      for its `Rc`-path shared mark. That includes the callee of a closure
      call (`f(x)`) and a method receiver (`xs.for_each(…)` versus a `mut`
      capture of `xs`).
    - **A value that carries a `mut` borrow counts as a `mut` argument,**
      even when it is passed to an `imm(f)` parameter. Such values are a
      `mut`-capturing closure and a borrowing future. The overlap set is the
      transitive closure of the places it captures.
      - So `f(false, &g)`, where `g` reaches `f`, is an overlap error.
      - So is `select(s.next(io), s.next(io))` over two futures that hold
        `mut` on one place.
      - The `for_each` literal still works, because the literal overlaps
        nothing else at the call.
    - **This closes re-entry.** A closure holding a `mut` borrow cannot be
      reached by anything it is called with. Swift has the same restriction
      for non-escaping closures (SE-0176).
    - **Module-level places** that a callee may write are in the overlap set
      of a lend of a module-level root. They are approximated by Stage 1's
      write summaries, until §3.10's module-level rule covers them.
    - **Decision 37's claim is corrected.** Move-only plus non-`Sync`
      prevents copies and threads, but `imm` lends could still overlap
      before this fix. `imm(self)` stays the call's mode; the exclusivity
      comes from the lend.
    - **Stage 1 shortcut.** Stage 1 may not skip the shared mark for a
      `Dyn(Fn)` callee, or for a closure whose body writes through an `Rc`
      capture. A closure stored in an `Rc` that replaces itself mid-call
      then trips the assert.

    **C. Call-once APIs: `FnOnce` by value only where the closure escapes.**
    This is recorded in decision 37's std list and its trait-inference
    order. The maintainer chose this over adding a non-escaping consuming
    parameter mode now.

    **D. A borrow capture may not cross an `Rc`/`Arc` deref.** The
    maintainer chose this over making such a closure non-`Copy` with a
    synthesized release.
    - **Why.** `{ imm(items) : &r.*.items }` cannot hold the cell's
      run-time mark. The closure is `Copy`, its copies are untracked, and a
      per-call mark leaves the pointer dangling between calls.
    - **The error names the explicit spelling:** `{ imm(r) }() =>
      r.*.items.len()`. This captures the handle, re-derives the place, and
      takes the marks on every call. It mirrors A2's "no exclusive borrow
      through an `Rc`".
    - **No module-level places.** A module-level place cannot be a borrow
      capture either (decision 18, rule 3).
    - **The place must be writable.** A `mut` capture's place must be
      writable: not through an `imm` binding, and not through an `Arc`
      (D3).

    **E. Threads.**
    - **Borrows.** A borrow capture is never `Send`.
    - **Closure `Sync`** is structural over the capture record. A `mut`
      capture is never `Sync`, and an `imm` capture of `T` is `Sync` iff
      `T <: Sync`.
    - **Raw pointers** are neither `Send` nor `Sync` unless a type opts in
      under `pragma(Pragma.AllowUnsafe)`. So `JoinHandle` (A3, a struct over
      `*(void)`) and the RAII guards stay `!Send` by construction. `Io` and
      `JoinHandle` also declare a negative marker.
    - **`Dyn(Trait)`** is `Send`/`Sync` only through an explicit bound,
      `Dyn(Trait, Send)`. `dyn(v)` into such a `Dyn` checks `v`.
    - **Coverage.** D1's reach walk applies to every `Sync`-bounded closure
      slot, as well as `Send` ones. This is a prerequisite of any scoped
      parallel API.

    **Related rules the audit requires before their phases land:**
    - **Decision 27 (V2b).** Clone elision inside a closure body runs
      under the closure's already-decided trait (C's order). It never
      elides a clone of a capture in an `Fn` body, or of a place that is
      transitively borrowed (A).
    - **§3.12, the verifier (before its subset widens past
      `vc.yo:6047`'s closure-callee bailout).** A call of a closure value,
      or a call that receives a closure with `mut` captures (transitively),
      havocs every place that closure `mut`-captures. Those places join the
      loop havoc set.
      - Decision 33's "the marker always tells the truth" is qualified: a
        `mut` capture is spelled at the closure literal, not at the call.
    - **The cycle collector (V3's `Dispose` work).** After the dispose
      pass, it re-checks each white cell's count. A resurrected cell, and
      everything reachable from it, is leaked and turned black instead of
      freed (as in CPython's PEP 442). **Confirmed in today's collector**
      and tracked as
      `issues/a-dispose-that-resurrects-a-cycle-member-leaves-a-dangling-handle.md`
      (S1, a reproducer is in `issues/repros/`). It is fixed on its own,
      not deferred to V3's std half.
    - **Unwind and abort (decision 28's `Rc` arm).** Per-call shared marks
      and the borrowed-`for` guard are released by the unwind cleanup, not
      by code after the call. A by-value or `FnOnce` argument counts as
      consumed at call entry.
    - **`Dispose`** may not move out of `self` (decision 19). A scope guard
      holds `Option(Dyn(FnOnce()))` and uses `take`.
    - **Small rules:**
      - A started state machine never moves (A1).
      - A2's return rule reads: "returned only if every place it borrows is
        rooted at the returning function's own `imm`/`mut` parameters".
      - A write to a by-value capture gets its own error, distinct from
        E0908.
      - A borrow entry's place is rooted at a named binding and crosses no
        temporary.
      - A stateful (`mut(self)`) closure, if added, is never `Copy`.

    **Sound as stated.** The audit also confirmed these:
    - sibling `mut` captures;
    - prefix overlap;
    - `Copy` and `FnOnce`-only never coinciding;
    - a captured `FnOnce` called inside a closure making it `FnOnce`;
    - effect handlers, which capture nothing;
    - read-only `Rc` re-entry;
    - a consuming call through a borrow being an error;
    - specialization catching an `Impl` that stores a borrowing literal.

    **Tests.** Each fix lands with its negative tests:
    - A: escape through a by-value capture, a block tail, `=`, `type_of`,
      and a `Copy` copy;
    - B: re-entry, `select`, and a receiver versus a `mut` capture;
    - C: the order shapes;
    - D: the `Rc` crossing error;
    - E: `Thread.spawn` of a borrow capture, a raw-pointer struct, and a
      `Dyn` without `Send`.

    **Phase.** Each rule lands with the feature it constrains:
    - A and B with V3b's closure work (decision 35);
    - C with decision 37's Generation A;
    - D with decision 35;
    - E with the `Send`/`Sync` split (§3.8, V3).

**Considered and kept implicit** (2026-10-05, the maintainer):
- **Moves at a last use.** `f(s)` moves `s` with no marker, and a later use
  is E0901, which points at the move. A marker such as Mojo's `s^` on every
  by-value pass was rejected.
- **Copies of plain data** (decision 16). The copy is free and has no
  observable effect.
- **Allocator placement.** The `alloc` parameter is the explicit form, and
  `with_allocator` places everything a call tree creates (§3.11). Both
  stay.
- **A closure's capture mode, when no capture list is written,** follows
  the parameter the closure is passed to (`imm(f)` or a by-value `f`,
  decision 22), which the callee's signature spells. The explicit form is
  the capture list (decision 35).

## 5. Prerequisites, gates and the seed

- **`STRING_VALUE_SEMANTICS`.** S1 (E0908 on `mut` writes through a
  borrowed value), S2 (count accuracy), S3a (the model-independent part,
  #1190) and S4 (docs, #1175) have landed. S3b (the
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
4. **V3b:** the parameter conventions (decisions 30, 33 and 34) and the
   capture list (decision 35).
5. **V1 step 2:** the unique `Box`, explicit-copy from its first commit.
   - **V3, std:** the resources become move-only values. Their cells are
     the unique `Box` (§3.4), so this half follows step 2. It is Generation
     B in any case, because it needs a seed that enforces move-only.
6. **Decision 36:** the `Copy` trait (Generation A, then the sweep and
   the flip), so that V2b widens a predicate that is already
   `!(T <: Copy)`.
7. **V2b:** projections, unique buffers, and the explicit-copy kind for
   `String`, the collections and `Dyn`. **V2c:** decision 17 for `Rc`/`Arc`.
8. **V4** (the compiler's trees), then **V5** (remove `ref`/`atomic`).

### V0: decisions — DONE 2026-10-03

### V1: `Rc`, `Box`, `Arc`, auto-dereference, no `Rc` marker trait

**Done (Generation A and its follow-ups):**
- step 0, the `rc` → `ref_count` rename and the prelude `rc` constructor
  (#1186);
- the `Rc` marker trait's deletion, with `Dispose`/`Trace` gated on
  reference types at the impl site until V3 (#1188);
- the `build.AllocatorKind` rename (#1188);
- `Deref` and auto-dereference (#1191);
- `Allocator` in the prelude (#1188, #1207);
- decision 32, Generation A: a method called through an unapplied generic
  type constructor (`Box.clone(b)`, `Pair.first(p)`), its arguments inferred
  from the receiver (#1241).
  - **The rule.** `G.m(x, ...)`, where `G` evaluates to a comptime function
    returning a `Type`, is `G(A, ...).m(x, ...)` when the type of `x`, the
    first argument, is an instantiation `G(A, ...)`. The match is by
    constructor identity (a struct's `constructor_func_id`, an enum's
    registered cfid), so it is never ambiguous: an `Rc(Box(T))` argument is
    an `Rc` instance, not a `Box` one. Generic and trait impls are found as
    for the written form, because the call then proceeds as that form.
    The AST is not rewritten: the receiver node's ExprInfo is overwritten
    with the inferred `G(A, ...)`, so a generic body infers again per
    specialization. A first rewrite of the receiver into a fresh atom
    broke a module-qualified constructor (`m.Pair.first(p)`) in a generic
    body, because the definition-time trial left an atom named `.` behind.
  - **Aliases and partial applications** are constructors of their own
    (identity, not inversion of a comptime function): `IntPair.first(q)`
    for `q : Pair(i32, u8)` is E0613 telling the user that another
    constructor built the argument; `Pair.first(q)` and
    `IntPair(u8).first(q)` work. A labeled receiver
    (`Pair.first(self : p)`) is the first argument too, since labels are
    positional.
  - **Static methods.** A method with no `self` has nothing to infer from,
    so `Pair.make(a, b)` is E0613; the type arguments are written,
    `Pair(A, B).make(a, b)`. The type a binding expects of the result does
    not supply them either: "whenever we could be explicit, do explicit".
    A first argument of another type (`Box.clone(a)` for an `Arc`) is
    E0613 naming its type; a missing method stays E0610, which now names
    the instance (`No method "m" on Box(i32)`, not `on Type`).
  - **`Arc.clone(a)`** is the same E0610 as `Arc(i32).clone(a)` until V2c
    gives `Arc` a `clone` (decision 17). `Rc.clone(w)` is tested on #1232's
    prelude `Rc`.
  - Hook: `_infer_unapplied_ctor_receiver`
    (`src/evaluator/calls/function.yo`), before `_try_find_receiver_method`.
  - Test: `tests/unapplied_constructor_method.test.yo`.

**Remaining, Generation A:**
- **The exclusivity assert moves to the write-through-`Rc` site** (§3.10).
  Tests: a closure and an async fn that mutate a captured
  `Rc(ArrayList(T))` while a `for` borrows it panic deterministically.
  Today they do not.
- **Diagnostics:** E0406/E0610 learn "`w` is a `Box(P)`; its payload `P`
  has no field `x` either" when auto-deref also misses.
- **`arc` gains the `alloc` parameter.**

**Decision 32, Generation B: the wrapper/payload name clash is an error,**
in `evaluate_property_access` and `_try_find_receiver_method`. It waits for
a `SEED_VERSION` carrying Generation A, because the sweep rewrites `src/`,
`std/` and tests to `Box.clone(w)`, which the seed compiles
(`plans/backlog/SEED_VERSION_AUTOMATION.md`).
- Tests: the clash error with both suggested spellings, and forwarding of
  unclashed names unchanged.
- **Sites, measured 2026-10-05:** two source sites.
  - Measured with a temporary probe in `_try_find_receiver_method`
    (`YO_AUDIT_D32`, not committed): an instance call whose receiver
    (pointer-stripped) has the method AND whose `deref_target_type`
    payload has it too, printed per call and deduplicated on
    `module:row:col`. Run with the tree-built compiler over
    `check ./src` (278/278 files), `check ./std` (178/178) and
    `check ./tests --exclude tests/internal --exclude tests/cli-cases`
    (563/633 files pass `check` standalone; the rest are negative
    fixtures). It sees only bodies `check` evaluates: a generic body only
    at the instantiations something reaches.
  - **`clone`:** `src/` 0, `std/` 0, tests 2:
    `tests/deref_auto.test.yo:63` (the test that pins "the wrapper's own
    members win") and `tests/rc_cell.test.yo:129`. The probe ran on the
    tree just before #1232 landed; #1232's diff adds that one `.clone()`
    on a wrapper (read from the diff, not probed). Six more evaluations
    are `derive(Clone)` bodies cloning a `Box` field
    (`auto-generated://`): the derive rule, not a call site, has to spell
    `Box.clone(self.f)`.
  - **Other names:** `id` at `tests/impl.test.yo:19` (`value.id()` with
    `T := Box(i32)`) and `hash` at `std/collections/hash_map.yo:233`
    (`key.hash(h)` with `K := Box(i32)`, reached from a test). Both are
    trait-bound calls on a type parameter: the error must fire only where
    the receiver's type is written as a wrapper, never at an instantiation
    of a `T <: Trait` call.
  - Box handles copy implicitly until V2c, so `.clone()` on one is rare
    today; V2c's `Rc.clone(w)` sites (decision 17) are the sweep's bulk.

**Step 1: rename every `Box(` to `Rc(` and `box(` to `rc(`** in `src/`,
`std/`, `tests/`, docs and skills.
- It is mechanical; the gates stay green because nothing changes
  semantically.
- `Rc(V)` is today's `Box` definition and impls, renamed.
- **It is seed-gated** (found 2026-10-05). The compiler recognises the
  shared cell by NAME, and the seed (v0.2.52) has the same hard-coding. The
  seed compiles `src/` against the tree's `std/`, so if std renamed `Box` to
  `Rc` first, a seed-built stage-1 would misread every `Rc` cell at these
  sites:

  | Site | What keyed off the name |
  | --- | --- |
  | `src/evaluator/calls/comptime_fn.yo` (the instance-name stamp) | only a call of `Box` (or `Arc`) names its result `Box(T)`; every other check below reads that name |
  | `src/types/guards.yo` `is_box_type` | `name.starts_with("Box(")`: patterns through the payload (`pattern.yo`, `pattern_compile.yo`), RC and downcast codegen |
  | `src/types/guards.yo` `is_boxed_type` | the same prefix: the boxed-`dyn` vtable path and `downcast` |
  | `src/evaluator/values/dyn.yo` | `dyn(box(<closure>))` recognised by the callee `box`; the auto-box of a non-object payload synthesizes `Box`/`box` |
  | `src/verifier/vc.yo` | the "Box payload pattern" outside-the-subset message |
  | `src/evaluator/values/impl.yo`, `src/diagnostics_registry.yo` (E0406, E0610) | diagnostics naming the `Deref` types |

  Not name-keyed, so already correct for `Rc`: `Deref` and auto-deref (the
  trait's key, #1191), `ref_count`, the pattern shapes (`box_inner_type`,
  `_box_shaped`: a single `*` field), and the type-identity rule
  (`compatibility.yo`: different constructor ids are different types).
- **Generation A — done** (#1232). The compiler knows both
  names: every check above reads one list, `shared_cell_names_at`
  (`src/types/guards.yo`), with the canonical spelling first
  (`shared_cell_canonical_names`, what `dyn(v)` synthesizes). The canonical
  spelling stays `Box`/`box`, because the std a seed-built compiler reads
  defines `Box` under every seed. The prelude gained `Rc(V)`, a second
  definition with `Box`'s impls (`Isolation`, `Hash`, `Eq`, `Clone`,
  `Default`, `Deref`), and `rc(v)` now returns `Rc(V)`. The seed lowers that
  much, because nothing in `std/` or `src/` constructs or matches an `Rc`.
  So in Generation A, `Rc` and `Box` are two types, and assigning one to the
  other is a type error. `tests/rc_cell.test.yo` covers `Rc` everywhere
  `Box` works: patterns through the payload, `dyn(rc(v))` and its
  `downcast`, a cell type built by a comptime function, auto-deref, and
  `ref_count`/`Clone`/`Eq`/`Hash`/`Default`. On the v0.2.52 seed it fails
  to compile (E0609 on the first pattern through an `Rc`).
- **Generation B** comes after a release whose seed carries Generation A.
  It is the mechanical rename: about 215 + 16 + 633 `Box(` and 91 + 8 + 170
  `box(` sites in `src/`/`std/`/`tests/`, plus about 85 + 101 in `docs/` and
  9 + 8 in skills, and the diagnostics and help texts that suggest "`Box`"
  as a reference type (`evaluator/utils.yo`, `calls/iso.yo`,
  `types/enum.yo`, `types/struct.yo`). The same PR:
  - deletes `Box` and `box` from the prelude;
  - makes `Rc`/`rc` the canonical spelling in `shared_cell_canonical_names`;
  - deletes the list's second row, so the list holds `Rc` alone.

  V1 step 2 then reintroduces `Box` as the unique cell, a separate type
  that is not on the list.

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
  - It adds the closure capture list, `{ x, imm(y), mut(z) : &mut w }(params)
    => body` (decision 35), in a follow-up PR stacked on the parameter-mode
    PR (feat/vbd-v3b-gen-a), which does not carry it.
  - Decision 34's operator-trait `imm` operands, its impl check and its
    `Dyn` wrapper adaptation are **not** in Generation A; they are
    Generation B's first item (below). The traits live in `std/prelude.yo`,
    which the seed compiles, and v0.2.52 rejects `imm(lhs)` as a parameter
    label. The impl check has nothing to check until then: in Generation A
    a plain operand already means `imm`, so every existing impl (`String`'s
    `(==) : fn(lhs : Self, rhs : Self)`) is a borrowing one, and only the
    flip makes a plain operand by value. The wrapper's `*argN` load is
    needed only once `imm` lowers to `const T*`. The `Comptime*` twins stay
    out of scope (decision 34). What Generation A does carry is the
    `Dyn(LogicalNot)` test over a by-value impl, and the fix it exposed:
    every `Dyn` over an operator member emitted its vtable wrapper under the
    raw label (`__yo_wrap_<impl>_!`), which is not C
    (`issues/fixed/a-dyn-over-an-operator-trait-emits-an-invalid-c-wrapper-name.md`).
    A binary operator through a `Dyn` still has no slot, and calling one is
    an internal compiler error instead of a diagnostic
    (`issues/a-binary-operator-called-through-a-dyn-is-an-internal-compiler-error.md`).
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
    - **Measured 2026-10-05** with `YO_AUDIT_BORROW_MARKERS=1 yo check`
      (`audit_borrow_marker_site`, `src/evaluator/calls/helper.yo`), on the
      tree compiler at the Generation A head, counting distinct source
      positions. A site is a named place (`x`, `s.items`) passed to a
      `mut`/`inout` parameter (`&mut`), or to a plain parameter whose
      argument type is not implicitly copyable (`&`); receivers,
      temporaries, `sink` and compile-time parameters are exempt.

      | Tree | `&` | `&mut` | Total |
      | --- | ---: | ---: | ---: |
      | `src/` | 35,054 | 1,623 | 36,677 |
      | `std/` | 2,438 | 321 | 2,759 |
      | `tests/` (no `internal/`, `cli-cases/`) | 2,710 | 211 | 2,921 |

      - `src/`'s `&` sites are dominated by the compiler's reference
        handles: `AstExpr` 8,344, `TypeValue` 6,398, `String` 5,454,
        `ArrayList` 2,768, `Environment` 2,493, `EvalContext` 1,319.
        Most of them are `ref(...)` types today, so V4's tree rewrite
        decides how many stay borrows.
      - `tests/` is a lower bound: `check` fails 70 of its 636 files, which
        need the test runner, and a failed file reports nothing.
      - `check` evaluates a generic body only per instantiation it sees, so
        a body no call instantiates reports nothing either.
- **Generation A, as landed** (feat/vbd-v3b-gen-a). What each spelling
  maps to, so Generation B knows what to replace:
  - **Parameters and receivers.** `evaluate_function_parameter` strips
    `imm(x)` and sets no flag, so `fn(imm(x) : T)` *is* `fn(x : T)`. It
    reads `mut(x)` exactly like `inout(x)` (`param_is_ref`). Function types
    and `Fn(...)` types go through the same parser, so `Fn(imm(s) : String)
    -> usize` works. Function-type parameters still need labels:
    `Fn(imm(String))` is not accepted, because `Fn(String)` is not.
    `-> mut(T)` is rejected like `-> inout(T)`.
  - **Types and diagnostics keep today's spellings** (`x : T`, `inout(x)`,
    `sizeof`), so no golden moved. Generation B switches the printer to
    `imm`/`mut` and the snake_case names.
  - **Local bindings.** `mut(y) := place` is `inout(y) := place` at every
    site that recognizes the binding (`ast_expr_is_inout_mode_call`).
    `imm(y) := place` is rejected with "not supported yet". It is V3's
    follow-up with last-use live ranges (decision 18).
  - **`&mut`** is one operator token. The lexer emits it for a lone `&` that
    ends an operator run and is directly followed by the word `mut`, so
    `&&mut` is still `&&` followed by `mut`.
  - **How `&x` is disambiguated today** (`apply_call_site_borrow_markers` in
    `src/evaluator/calls/helper.yo`). Both call paths run it before any
    argument rule reads the arguments. For argument `i` it looks at the
    callee's declared parameter `i`:
    - `&mut x` to an `inout`/`mut` parameter → the place `x`, exactly
      today's `f(x)`;
    - `&mut x` to any other parameter → an error;
    - `&x` to an `inout`/`mut` parameter → an error naming `&mut x`;
    - `&x` to a `sink` parameter, or to a parameter whose declared type is a
      raw pointer `*(T)` or a `SomeT` (generic or `Impl(...)`) → today's
      address-of, unchanged;
    - `&x` to any other parameter → the place `x`, exactly today's `f(x)`.
      Today such a call never type-checked, because there is no implicit
      `*(T)` → `T` or `*(T)` → `Option(*(T))` conversion.

    Variadic positions keep the address-of. A `&x` anywhere else (a
    binding, a field store, a method-call receiver) is the address-of. A `&mut x`
    anywhere else is an error. Generation B rewrites every address-of `&x`
    to `addr_of(x)`, deletes the address-of reading, and turns the mismatch
    error on for bare arguments.
  - **Scrutinees.** The parser's desugar pass rewrites `match(&x, …)` and
    `match(&mut x, …)` to `match(x, …)`. Today a plain scrutinee borrows
    and its arm bindings are read-only copies, so both markers mean exactly
    that. No match arm binds a `mut` place yet. A `match` inside `quote(...)`
    is not desugared, as with `if`.
  - **`addr_of(x)`** is dispatched to the address-of evaluator and emitter,
    with the same unsafe-file gate.
  - **`size_of`/`align_of`/`type_of`/`type_id`** match beside the old
    names at every site: the evaluator dispatch, each builtin's shape
    check, codegen, the mutation summary's pure-builtin list, and the
    reserved-binding list. The LSP, `yo context`, the pack and the
    diagnostics registry never named the old builtins, so nothing changed
    there. The LSP keyword list gained `mut` and `imm`.
  - **Collisions.** `std/term.yo`'s `size_of` became `term_size`. Six
    `type_id` locals in `src/` became `tid`. Parameters and fields named
    `type_id` are not binding sites and stay.
  - **Not in Generation A:** `imm(y) :=`, re-points, projection results,
    lambda parameters spelled `(mut(n)) => …` (a lambda takes its modes
    from the expected `Fn` type, and `(inout(n)) => …` is not legal
    either), and `for(xs, mut(x) => …)`.
- **Generation B,** once `SEED_VERSION` carries Generation A:
  0. **Decision 34 first:** the prelude's operator traits declare their
     operands `imm` (`RangeOp`/`RangeInclusiveOp` excepted); the impl check
     rejects a by-value operand whose type is not implicitly copyable, and
     a `mut` operand, naming `imm(x)`; and the `Dyn` wrapper passes `*argN`
     to a by-value impl. It must land with the flip, not before: until a
     plain operand is by value, the check would reject every existing
     owning-type impl.
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
- **Stale compiler comments.** Three comments say "Yo has no `mut`; the
  body is the signature", which is false once `mut(x)` exists. They are
  `src/codegen/functions/generation.yo` (`_maybe_emit_method_entry_borrow_assert`)
  and `src/evaluator/effects/mutation_summary.yo` (twice, at the file's
  mask overview and at `function_param_mutation_mask`). Generation A
  rewrites them to "a `mut` parameter spells the write, and the mask still
  covers the writes reached through a `ref` object until V5".
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

No design question is open. The latest were decided as decisions 31 (the
child wrapper in patterns), 34 (operator operands), 35 (the closure capture
list), 36 (the `Copy` trait) and 37 (`FnOnce`, and no `FnMut`). Decision
38 records the closure soundness rules from the 2026-10-06 audit. Decision 18 was also
amended to place-based exclusivity.

**Parked with the phase that decides them.** These are smaller choices
inside a settled design:
- **A6:** what the bundle copy does with an `Rc`/`Arc` field: clone it,
  or make bundles explicit-copy. Decided in V2c.
- **§3.10:** whether `pragma(Pragma.StrictBorrow)` is deleted or kept for
  `Rc` roots. Decided in V2b, when the collections' headers go.
- **§3.11:** whether the containers' `new_in`/`with_capacity_in` move to
  the constructors' `alloc` parameter. Decided after V2b.
- *(Decided as decision 35, 2026-10-05: the capture list.)*
