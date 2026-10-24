# Should Yo add a flagless `Cell(T)` beside `RefCell(T)`?

**Kind:** design question — an open decision, not a defect.

**Status:** open. Filed 2026-10-23 from the maintainer's question "We have
added `RefCell` to Yo. Should we also add `Cell`, like Rust's `Cell`?".
Evidence read on origin/develop 4b96ec5e9 (after B5, #1551). Probes ran on
the seed v0.2.68 with `--std-path` pointed at that tree's std.

## The question

`RefCell(T)` (`std/sync/refcell.yo`, decision 41/46) is the one spelling of
the dynamic exclusivity check. It lends `&T`/`&mut T` into a closure, keeps a
borrow mark, and panics when a conflicting borrow is taken while one is live. Rust also has
`Cell<T>`: copy in, copy out, never lend. It needs no mark and has no
panic path. Should Yo ship that second type, and if so, when and in what
shape?

## What holds today

- **Earlier written positions.**
  - `plans/backlog/RUST_REFERENCE_PATTERNS.md` §4.2 (a backlog catalog
    entry, not a decision) says "`Cell<T>` disappears ... a `RefCell(T)`
    over a `Copy` payload (`c.get_mut().* = v`)". `get_mut()` has not
    landed. It is B0's expression-scoped projection, now scheduled with
    decision 43 step 2 (v0.2.73). The increment that entry implies,
    `c.get_mut().* = (c.get().* + 1)`, also conflicts with itself: both
    marks are held to the end of the expression (VBD §3.10). So the
    "no hole" claim does not hold as written.
  - `plans/VALUES_BY_DEFAULT.md` §3.10: "The run-time check has one
    spelling, `RefCell(T)`". A Cell performs no run-time check, so the text
    does not exclude it. But the "one door" framing is the closest
    maintainer text.
  - `plans/handover/VBD_HANDOVER_2026-10-15.md:632` already told users to
    "use a `Mutex`, `Cell` or atomic global". No `Cell` exists. The
    shipped E0916 help names only an atomic or a `Mutex(T)`.
  - `std/sync/once.yo:28-36`: Yo's `OnceCell(T)` is thread-safe (Rust's
    `OnceLock`), and "adding a genuinely single-threaded cell beside it is
    a live question".
- **Who would use it.**
  - `src/` and `std/`: **0** `RefCell` sites with a Copy payload. The
    only text matches are the E0919 example string
    (`src/diagnostics_registry.yo:714`) and refcell.yo's module example.
    All 377 B5 `RefCell` globals hold collections.
  - `tests/`: **258 of 292** `RefCell(..).new(` sites are Copy (i32 226,
    bool 27, usize 4, i64 1). Most are counters and flags shared between
    `io.async` tasks or escaping closures, which own their captures
    (decision 22). The largest file is `tests/async_await.test.yo` with 141.
    Every user-doc example of `RefCell` is a Copy counter
    (`docs/en-US/ASYNC_AWAIT.md:66-95`, `DESIGN.md:3260`/`:3670`).
  - The 125 Copy `mut(G)` data globals and the 44 fn-pointer hooks are
    copy-in/copy-out and never lent (lending is E0916). A Cell changes
    nothing for them.
- **What a Cell would buy, measured.**
  - 200M increments of an `Rc` counter at `--optimize 2`, on one machine:
    - `with_mut(v => { v = (v + 1); })`: about 0.7 ns per operation.
    - A prototype `c.set(c.get() + 1)`: about 0.37 ns per operation.
  - Much of that gap is the closure shape: `with_mut` sets and tests the
    thread-local `__yo_effect_escaped` flag around its body. The mark
    itself is a compare, a branch, two stores and 8 bytes per cell. N5
    (VBD :7342), the real-program measurement of the mark, was never run.
- **Layout.** A non-projection `&T` receiver is passed as a C value copy
  today (decision 34: "Today every `&T` parameter lowers to `T x`"). Interior
  state must therefore sit behind a pointer, which is why `RefCell` boxes
  its slot (refcell.yo:27-33).
  - A Box-backed prototype Cell built and ran with no compiler change:
    as an unmarked global, lent as `peek(&G)` with no E0916, and through
    a second `rc` handle.
  - The **inline** variant silently lost the write: it printed `5` after
    `set(9)`.
  - **Decision 43 step 1 does not fix this.** The v0.2.72 row of
    `VBD_RELEASE_SCHEDULE.md` requires "an emit-diff with no C change", and
    no row schedules the by-address lowering.
  - `thread_local(G) := Cell(usize).new(0)` is rejected while the Box is
    there (`type_contains_rc_type`,
    `src/evaluator/exprs/initialization_assignment.yo:1790-1796`).
    `RefCell` is rejected the same way.
- **No compiler pass knows interior mutability exists.**
  - VBD §3.10 says "a `&T` lend means unchanged only for `RefCell`-free
    types". That exclusion is planned, not built.
  - Grep finds no RefCell, UnsafeCell, Freeze or interior predicate in
    `src/`.
  - The verifier's call-site `old()` rule assumes "every other name is
    unchanged by the call" (`src/verifier/vc.yo:4167-4169`). A probe
    (2026-10-23) found that a cell's own contents are sound today: a
    `&RefCell`, `Rc(RefCell)` or atomic parameter is outside the subset,
    and `with`/`with_mut`/`load` calls are contract-less callees. The hole
    is one step removed. A `RefCell` global can hold a second handle to a
    caller's `ArrayList`, and a trusted runtime-mode callee with
    `ensures(true)` can grow it while the caller is proved to see it
    unchanged. That is the S1
    `issues/fixed/2026-10-23-the-call-site-frame-misses-a-list-reached-through-a-refcell-global.md`.
  - `RefCell`, `Mutex` and the atomics are opaque `unsafe` writes in std.
  - This gap exists today with `RefCell` alone. Adding Cell as a second
    hand-built type gives that unbuilt exclusion a second name it can
    miss.

## Options

1. **Add a Box-backed `Cell(T)` now**, in `std/sync/cell.yo`, as a std-only
   Generation A like RefCell's #1415. Use a private marker trait
   (`!Freeze`-like), implemented by hand on each interior type, as the
   predicate.
   - For: it works today, and the API (`get`/`set`/`replace`/`update`)
     never lends, so it can never panic. Tests and docs read better.
   - Against:
     - It has no src/std user.
     - A hand-implemented marker is a soundness hole for the next
       unsafe std type that forgets it.
     - Allocations are unchanged until `&T` is passed by address, so the
       layout changes again later.
     - It contradicts §4.2 and the "one spelling" prose without a
       decision behind it.
2. **No Cell; give `RefCell` Rust's Copy-friendly methods.**
   `replace`, `replace_with(f)`, `take` (`where(T <: Default)`) and
   `into_inner`, all through the existing mark.
   - For: no compiler work, no second type, and the one-door rule stays
     literally true.
   - Against:
     - Every Copy counter still pays the mark, and reads stay
       `c.with(v => v)` until B0.
     - Rust-trained authors (and LLMs) look for `Cell`.
     - It leaves the unbuilt interior predicate unbuilt.
3. **Build the interior primitive first; Cell rides on it.** A compiler-known
   private `__yo_interior(T)` (Rust's `UnsafeCell`) plus a derived
   `type_has_interior` predicate (Rust's `!Freeze`). Every "`&T` means
   unchanged" consumer reads it. `RefCell` moves inline onto the primitive,
   and a Copy-only `Cell(T)` is added on the same primitive.
   - For: it closes today's gap for RefCell, Mutex and the atomics at once,
     and a derived predicate cannot be forgotten. The by-pointer ABI rule
     it needs makes the inline layout sound, which drops one Box per
     cell, including the 377 globals. Cell then costs about 40 lines of
     std.
   - Against: it is compiler Generation A work, so it needs a forced
     release, and it ships nothing to users before then.

## Recommendation

**Option 3, sequenced, with option 2's methods now. Yes to a flagless
`Cell(T)`, but only on the compiler-known interior primitive, never as a
second hand-built `unsafe` type.** Record it as decision 49 in VBD §4.

**Step 0, now (std-only, no seed gate).**
- `RefCell(T)` gains Rust's own names:

  ```yo ignore
  replace : (fn(self : &Self, value : T) -> T)(...),           // panics under a running with/with_mut
  replace_with : (fn(self : &Self, f : &Impl(Fn(v : &T) -> T)) -> T)(...), // holds -1 while f runs
  into_inner : (fn(self : Self) -> T)(...),
  // take : where(T <: Default)
  ```

  With them, `c.with_mut(v => { v = (v + i32(1)); });` becomes
  `c.replace_with(v => (v + i32(1)));`.
- Test them in `tests/sync/refcell.test.yo` (re-entry from `f` panics;
  the mark is restored on unwind).
- Rewrite refcell.yo's module example and the counter examples in
  DESIGN.md and ASYNC_AWAIT.md, in en-US and zh-CN.
- Amend RUST_REFERENCE_PATTERNS.md §4.2: retract "no hole", record the
  self-conflicting `get_mut().* = (get().* + 1)`, and point to decision 49.
- Add a note beside the stale "`Cell`" in
  `VBD_HANDOVER_2026-10-15.md:632`. It is a historical record, so the
  line itself is not rewritten.

**Step 1, decision 49 compiler work (Generation A, compiler only, riding
the next forced cut beside `__yo_cell`).** The primitive is unrelated to
`__yo_cell`, which backs `Rc`. `type_has_interior(T)` is derived
structurally, never declared. These consumers read it:
- **The verifier.** A value that reaches interior state is outside the
  subset, and the `old()` frame rule at `vc.yo:4167` treats an
  interior-reaching argument passed `&` as possibly changed.
- **Mutation summaries and decision 28's overlap check.** A cell write
  is a write to that cell (`issues/questions/refcell-inside-a-plain-value.md`,
  option 2).
- **CTFE.** It never folds a read through an unmarked global that
  reaches interior state. Probe this first: whether `G.get()` on an
  inline cell global folds to its initializer is unverified.
- **Copy derivation.** An interior type is never `Copy`, so `b := a`
  cannot silently fork a cell.
- **Decision 34's lowering.** `&T` of an interior type lowers to `T*`,
  whatever its size, and globals that reach interior state are never
  emitted `const`. Decision 34 already makes the lowering "a function of
  the monomorphized type alone", so this is one more input to it, not a
  rival ABI.

**Step 2, std half on that seed.**
- `RefCell` moves inline (`struct(_borrow, _value)` on the primitive).
- `std/sync/cell.yo` adds:

  ```yo ignore
  //! `Cell(T)`: a Copy value replaced through shared handles on one thread.
  //! Never lent, so no mark and no panic. Rust's `Cell<T>`.
  Cell :: (fn(comptime(T) : Type) -> comptime(Type))(struct(_v : __yo_interior(T)));
  impl(generic(T : Type), Cell(T), !Sync()); // Send iff T is Send
  impl(generic(T : Type), where(T <: Copy), Cell(T),
    new, get, set, replace, update(f : &Impl(Fn(v : T) -> T)) -> T, into_inner);
  // take : where(T <: Copy, T <: Default); Clone (not Copy) when T <: Copy
  ```

- Constraints on the Cell API:
  - Payloads are Copy only. That means no `Drop` re-entry and no `Rc`
    cycle through a Cell, so decision 48, `Acyclic` and `Weak` are not
    involved.
  - No method returns `&T` or passes `&T` to a closure. Write that
    invariant into the header as the soundness argument.
  - No `get_mut`: the name collides with RefCell's planned projection.
  - Cell joins the O3-3 payload-invariance list
    (`REFERENCES_AND_ORIGINS.md:681`/`:736`). It is `Escapable` only when
    its payload is.
- Tests:
  - `!Sync`, and `Arc(Cell(T))` rejected.
  - A spawned thread reaching a Cell global rejected.
  - `&G` lend of an unmarked Cell global.
  - `thread_local(G) := Cell(...)` accepted.
  - An async counter across `await`.
  - The write-loss canary: a `set` through a `&Self` receiver is
    visible to the owner. It failed on today's ABI and guards the `T*`
    rule.
- E0916's help adds "or an unmarked `Cell(T)` global for a
  single-threaded Copy value" (needs a cli-diff re-record).
- Docs in both languages get a "Cell / RefCell / Mutex / Atomic" table.
- Migrate the Copy `rc(RefCell(..))` counters in `tests/` to Cell, and
  keep a deliberate RefCell subset in the async and effects files.

**Not in scope.** The `mut(G)` scalar globals, the 377 collection
`RefCell` globals, and the resource flags that V3 turns into `&mut self`
values. A src sweep is never required.

**Follow-up question.** Rename the thread-safe `OnceCell` to `OnceLock` in
the step-2 pass, so that `*Cell` always means single-threaded.

**Why not option 1:** its gain is per access (about 0.35 ns per op on one
machine) plus ergonomics. Step 0 delivers most of the ergonomics, and nothing
in src/std would collect the speed. It also adds the second interior type
before any predicate exists to name it.

**Why not option 2 alone:** declining Cell does not close the `&T`-means-unchanged gap,
which exists today. Once the primitive exists, Cell is the cheapest correct
answer to the shared-counter shape that dominates user code and docs.

**Reopen** if N5 or a profile shows `RefCell` marks above 1% in a real
program before step 1 lands. If so, ship the Box-backed Cell early on a
hand-written predicate, and treat that as debt that step 1 pays off.
