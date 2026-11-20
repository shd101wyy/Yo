# Reference counting in the generated C

> **Status (2026-11-17).** This page is now a short guide to the reference
> counting Yo emits. Its earlier form, "Compile-time Reference Counting with
> Ownership and Lifetime Analysis", documented the compiler's ownership model
> before unique ownership landed — every assignment inserted `___dup`,
> parameters borrowed by default, `sink()` transferred ownership — and those
> sections are deleted as history. The language-level rules are
> [MEMORY_SAFETY.md](./MEMORY_SAFETY.md); the design is
> [`plans/VALUES_BY_DEFAULT.md`](../../plans/VALUES_BY_DEFAULT.md).

Yo counts `Rc(T)` cells with a non-atomic reference count, `Arc(T)` cells with an atomic one, and removes reference-count operations it can prove unnecessary at compile time.

Non-atomic RC is sound in Yo because counted objects are **thread-local** and cannot be shared across threads unless their type is explicitly `Send` (see [PARALLELISM.md](./PARALLELISM.md)).

## The generated C

Every counted cell starts with a header (`__yo_ref_header_t`, aliased
`__yo_rc_prefix_t`): a `uint32_t` count at offset 0 — its top bit is the
explicit-allocator tag, so count reads mask it — then the type id, and a
16-bit word that holds an object's interior-borrow marks or, on an
`Rc`/`Arc` cell, the `Weak` count ([WEAK.md](./WEAK.md)). The operations
are a handful of `static inline` helpers emitted into every file:

- `__yo_incr_rc` / `__yo_decr_rc` — the non-atomic count operations;
- `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic` — the same for atomically
  counted cells (`Arc`, atomic reference objects);
- `__yo_dyn_retain` / `__yo_dyn_release` / `__yo_dyn_clone` — a `Dyn`
  payload's count through its vtable;
- `__yo_rc_weak_retain` / `__yo_rc_weak_release` / `__yo_rc_weak_upgrade` —
  the `Weak`/`ArcWeak` handles;
- `__yo_borrow_acquire` / `__yo_borrow_release` /
  `__yo_borrow_assert_unborrowed` (plus an `_atomic` trio) — the Law of
  Exclusivity backstop: an interior reference into a container's storage
  increments the container's borrow mark, and an operation that could
  reallocate or free that storage panics unless the mark is back at zero.
  An `Rc`/`Arc` cell never carries a borrow mark; its word is the weak
  count.

Per type the compiler also derives `___dup` / `___drop` / `___dispose`
helpers — a dup clones each RC-carrying field, a drop releases them, a
dispose runs the payload's `Drop` and releases. Under chunked emission
(`--emit-chunks`) every translation unit gets its own `static` copy: these
are the RC hot path.

## Reading the count: `ref_count(x)`

The builtin `ref_count(x)` returns the current reference count of the cell `x` holds, as a `usize`. For a value type (a plain `struct`, an integer) it is always `1`, known at compile time. Atomically counted handles (`Arc(T)`) are read with an atomic load. A `Box` has no count: `ref_count(b)` is a compile error ("a uniquely owned cell with no count").

The count reflects the compiler's dup/drop optimizations, so a copy the optimizer cancelled does not show up; it is meant for uniqueness checks (copy-on-write) and tests, not program logic.

```yo
a := Rc.new(i32(42));
b := Rc.clone(a);
assert(ref_count(b) == usize(2), "two handles, one cell");
```

`Rc.new(v)` allocates the cell and takes ownership of `v`; a second handle is `Rc.clone(h)`, and `Arc(T)` counts its handles the same way, atomically, for sharing across threads.

## Where a `___dup` comes from

Under unique ownership a dup raises the count when a **second owner** of RC-carrying data is created: `Rc.clone(h)`, and a value stored into a field, an array element or an enum payload while its binding keeps living (the borrowed-argument guard below is one more). A value moved at its last use carries no count traffic: the store's dup and the binding's scope-end drop are the pair the optimizer cancels below. Plain data (an integer, a struct of integers) is copied with no count at all; a `Box` moves and is never counted.

Every scope exit still drops what it owns: the drop of an owned binding decrements the count, and when it reaches zero the payload's `Drop` runs and the cell is freed.

## The dup/drop pair optimizer

`_optimize_dup_drop_pairs` (`src/evaluator/exprs/begin.yo`) cancels a local's single runtime dup against its scope-end drop — a **move**: the dup disappears AND the variable is marked consumed, so no path drops it. That is sound only if the dup executes unconditionally on every path that reaches the scope end, so the optimizer:

- collects dups **branch-aware** for `cond`/`match`: a dup present in only SOME fallthrough arms flags the variable (`vars_with_partial_branch_dups`) and the pair is preserved — dup on the taken arm, scope-end drop on every path;
- counts a dup in EVERY arm once per arm, so a runtime dup count above 1 also preserves the pair;
- follows `ExprInfo.macro_expansion` instead of the raw macro-call args, because `if(...)` keeps its macro head in the AST and only its recorded `cond` expansion exposes the branch structure. Walking the raw args treated an arm-internal dup as unconditional and cancelled it — leaking one reference on every path that skipped the arm (`issues/fixed/where-constraints-arraylist-96b-leak.md`, fixed 2026-08-06);
- never optimizes across `while` bodies (a loop-body dup executes N times, the scope-end drop once);
- skips `io.async` captures (the state machine needs both the dup and the drop).

## The borrowed-argument aliasing guard

A place inside an `Rc`/`Arc` payload passed to a borrowing (`&T`) parameter could dangle if the callee, during the call, released the container holding it through another handle. The hole is closed (2026-08, Lobster-style borrow inference in two stages; see `issues/fixed/borrowed-arg-invalidated-by-aliased-container-mutation.md` for the reproducer, the staged design, and the landing logs):

- **Stage 0** — an RC-typed field **projection** passed to a **borrowing** parameter gets a caller-owned `+1` for the call, and a place reached through a read-only handle shares on the handle: the cell stays alive while the callee runs, even if a closure argument drops the last other handle. Plain locals stay `+0` (the caller's binding keeps them alive), as do owned temps, `&mut` parameters, and extern/builtin callees (no Yo code runs inside them).
- **Stage 1** — per-callee **mutation summaries** (`src/evaluator/effects/mutation-summary.yo`) ask "may this call transitively mutate RC container storage?"; the read-only majority get the `+0` borrow back. Stage 0 alone cost +23% self-compile time; Stage 1 returns all of it and more (45.3 s → 55.2 s → 38.5 s on `check ./std`), so the hole is closed at no runtime cost.

A callee counts as **may-mutate** if it (transitively) assigns to an RC-typed place, performs an **explicit RC decrement** (`___drop`, `__yo_decr_rc` and friends — any of which can release the container-held reference a borrow depends on), calls an extern that is the runtime/allocator family, a libc `free`/`realloc`, or takes a callback, yields to the event loop via an io builtin, is a control function, or calls anything the compiler cannot resolve. It is a MAY-analysis: anything unrecognised counts as mutating. Compiler-generated drops are not a hazard — they only ever target variables that own their value, and a borrow is non-owning by definition.

## Loops

The retired TypeScript compiler recognized a linked-list traversal loop and removed all of its RC operations. That optimization was never ported to the self-hosted compiler (the note in `src/evaluator/exprs/begin.yo` beside the pair optimizer); `issues/fixed/loop-traversal-borrow-chain-mutation-uaf.md` records the use-after-free its mutation guard had to close. Under unique ownership the language replaces it: a local borrow re-pointed into the node it already borrows walks the list (`plans/VALUES_BY_DEFAULT.md`, decision 25). Over `Box` nodes the walk has no count traffic; over `Rc` nodes each step pins the entered cell, one increment and one decrement.
