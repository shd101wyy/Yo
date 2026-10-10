# Generated-code performance: closing the gap to Rust

**Status: ACTIVE — measured 2026-10-10, nothing landed yet; CP0 then CP2f
are the entry points.** Written 2026-10-08 at the maintainer's request,
alongside [`RUST_REFERENCE_PATTERNS.md`](backlog/RUST_REFERENCE_PATTERNS.md)'s
§12, parked in `backlog/` on 2026-10-08 and moved to the active set on
2026-10-10 by the maintainer's call, once the first measurements (§0.1)
re-ordered its levers. The async runtime's performance
is owned by
[`ASYNC_PERFORMANCE_HANDOVER.md`](handover/ASYNC_PERFORMANCE_HANDOVER.md)
and [`ASYNC_STATE_MACHINE_GENERATION.md`](ASYNC_STATE_MACHINE_GENERATION.md);
this plan is the other half: **what the emitted C is worth at run time.**

**Audited 2026-10-10 against measurements** (§0.1): the plan was written
from reading the emitted C; this audit timed it. Two of §0's three causes
are re-weighted by the numbers, two causes it did not list are added
(runtime contract checks in std, and std's own algorithms), CP1c's question
is answered from the emitted C, and §5's order changes: CP2f (the range
pass) is the first lever after CP0, not one of the last.

## 0. The position

Post-VBD, Yo's *semantics* are near-Rust by construction for unshared code:
unique buffers, no hidden counts, implicit moves, static exclusivity for
value-rooted borrows. The remaining gap to Rust has three causes, and
this plan attacks all three:

1. **What clang is allowed to see.** Rust tells LLVM `noalias` on every
   `&mut`; Yo lowers `mut(x) : T` to a plain `T*` and discards the
   exclusivity it just proved — nothing in the emitted C uses `restrict`
   (measured 2026-10-08: zero occurrences in a fresh `yo compile` output).
   Cross-translation-unit inlining is NOT a gap: chunked optimizing builds
   already pass `-flto=thin` by default (`src/main.yo:4898`–`4917`,
   [`CHUNKED_C_EMISSION.md`](reference/CHUNKED_C_EMISSION.md) — MEASURED
   on an N=4 self-build at `-O2`: 14.2% slower without it, 102.8s vs 90.0s
   on `check ./src`, and the thin link slightly FASTER than single-file,
   87.4s). The visibility gap that remains is aliasing metadata (CP1a) and
   the audit edges of CP1b.
2. **Checks the language could discharge itself.** Per-step bounds checks on
   index walks (decision 39 accepted them), the `Rc` write-site borrow assert
   (§3.10), container guards, and the integer overflow traps safe mode emits
   on every `+ - *` and negation at every `-O`
   ([`SAFE_MODE.md`](SAFE_MODE.md) D1; Rust's release profile wraps
   instead, so this is the one check Rust does not pay) — each has a proof
   path that removes it: static exclusivity, the runtime pin, the verifier,
   or a range pass (CP2f).
3. **Collector work on cells that can never be on a cycle** (added
   2026-10-09). A tracked `Rc` cell pays a list link at allocation and
   unlink at free, a `gc_flags` test plus a first-time buffer push on every
   non-final decrement, the `gc_prev`/`gc_next`/mark bytes in its header,
   and its share of every tracked-list scan. The tracking predicate
   (`can_type_form_rc_cycle`, `src/types/utils.yo`) is "the payload type
   can reach itself through `Rc` edges", so every recursive type is
   tracked — the compiler's `AstExpr` and `TypeValue` trees in full — though
   a tree built once and never written through a shared handle cannot form
   a cycle. Rust's `Rc<Expr>` pays nothing for the same data. CP2e removes
   that tax statically; the collector itself stays (the maintainer's
   constraint, 2026-10-09: cycles through `Rc` must keep collecting).
4. **Runtime contract checks in std's hot methods** (added 2026-10-10,
   measured in §0.1). FORMAL_VERIFICATION Phase 0 lowers every
   `requires`/`ensures` to a runtime assert, and `yo compile` erases one
   only when the in-process verifier proved it (the 5b line, verify-mode
   builds). `std/collections/array_list.yo` carries 9 `ensures` and 7
   `requires`, `push`'s among them, and an ordinary `--optimize 2` build
   pays all of them on every call. Rust has no such check. CP2g removes it.
5. **std's own algorithms** (added 2026-10-10). `sort_by` is an index
   merge sort with checked counters and bounds-checked index reads at 4.3×
   `qsort`; the choice was made for RC-discipline reasons that V2b's
   unique buffers remove. Not a codegen lever — a std one (CP2h) — but it is
   where a user's first benchmark will land.

**Not gaps** (checked 2026-10-09, so nobody chases them): cross-TU inlining
(above); monomorphized `Impl(Fn)` bodies and `Dyn` vtable dispatch (the
same shapes as Rust's generics and `dyn`); the allocator (mimalloc or TLSF
versus Rust's default system malloc); panics (`abort()` with no unwinding
tables, where Rust's default `panic=unwind` carries landing pads); the
async runtime (measured at libuv parity, owned by the ASYNC plans); large
values passed by pointer under decision 30/34 (a Rust move of a large
struct is the same `memcpy`).

### 0.1 What the first measurement says (2026-10-10)

Setup: the installed seed `yo 0.2.56` with the tree's `std/` (`--std-path`),
`--optimize 2`, nix clang 21.1.7 on a Mac Mini M4 under a load average of
3.6 (a peer session was building; the numbers were stable to ±2 ms across
runs). The paired C reference is the same four loops written by hand and
compiled `clang -O2 -std=c11`. **No `rustc` on this box**, so the Rust
column is still missing: CP0 needs a Rust toolchain in CI, not on a dev
machine. The kernel (the seed of CP0's `scripts/bench/lang-vs-c/`):

```yo
{ ArrayList } :: import("std/collections/array_list");
Point :: struct(x : f64, y : f64);
derive(Point, Copy, Clone);
dot :: (fn(imm(a) : ArrayList(f64), imm(b) : ArrayList(f64)) -> f64)({
  acc := f64(0);
  n := a.len();
  i := usize(0);
  while(i < n, {
    acc = (acc + (a(i) * b(i)));
    i = (i + usize(1));
  });
  acc
});
sum_index :: (fn(imm(xs) : ArrayList(i32)) -> i64)({
  acc := i64(0);
  n := xs.len();
  i := usize(0);
  while(i < n, {
    acc = (acc + i64(xs(i)));
    i = (i + usize(1));
  });
  acc
});
sum_for :: (fn(xs : ArrayList(i32)) -> i64)({
  acc := i64(0);
  for(xs, inout(x) => {
    acc = (acc + i64(x));
  });
  acc
});
// norms: the same index walk over ArrayList(Point); main pushes 20,000,000
// elements into each list, sorts xs descending with sort_by, then times
// each phase with Instant.
```

| Phase (20 M elements) | C `-O2` | Yo baseline | Yo, counters and accumulators `wrapping_add` | Yo, raw `ptr()` walk + wrapping | Yo / C |
| --- | --- | --- | --- | --- | --- |
| push ×4 lists | 62 ms | 119 ms | 119 ms | 119 ms | **1.9×** |
| `sort_by` (C: `qsort`) | 261 ms | 1,118 ms | 1,112 ms | 1,116 ms | **4.3×** |
| `sum_index` ×3 | 3 ms | 17 ms | 3 ms | 3 ms | **5.7× → 1.0×** |
| `dot` ×3 | 43 ms | 42 ms | 42 ms | 42 ms | 1.0× |
| `norms` ×3 (struct walk) | 44 ms | 43 ms | 43 ms | 43 ms | 1.0× |
| borrowed `for` sum | 1 ms | 7 ms | 1 ms | 1 ms | **7× → 1.0×** |

Two measurement lessons that CP0's harness must bake in: the first C
reference reported `sum_index ×3` as 1 ms because clang CSE'd three calls
of a `readonly` function into one — launder the pointer argument through an
empty `asm` between calls; and `-Rpass-analysis=loop-vectorize` on the
emitted C (`--cflags`) is the cheapest attribution tool there is, it names
the instruction that stopped the vectorizer.

**What the table attributes:**

- **The integer overflow trap is the whole integer-loop gap.** Replacing
  `i + 1` and `acc + x` with `wrapping_add` takes `sum_index` from 5.7× to
  parity and the borrowed `for` from 7× to parity; nothing else in those
  loops costs anything. The trap is a helper call with an early exit
  (`__yo_add_chk_s64`, `src/codegen/c/collection.yo`), and clang's remark on
  the baseline loop is "call instruction cannot be vectorized" / "early
  exit loop": a trapping reduction cannot be vectorized or unrolled. This
  is CP2f's target and it is the first lever, not one of the last.
- **Bounds checks cost nothing in a straight index walk.** The raw-pointer
  variant, which removes the bounds check AND the `ArrayList.index` null
  check, is identical to the wrapping variant on every row. clang hoists
  both guards (they read `_length`/`_ptr`, which the loop never writes).
  Decision 39's "one bounds check per step" is therefore not a measured
  tax for these shapes, and CP2b (the hoisted `for` lowering) is a smaller
  win than §0 assumed; its value is in loops with stores, where the guard
  reload is not hoistable, and that needs its own workload.
- **Float loops are at parity already**, with no `restrict` and with
  `-fno-strict-aliasing`: the vectorizer reports the same shape on the
  emitted `dot` as on the C (`width 2, interleaved count 4`, an in-order
  reduction). So §0's cause 1 (what clang is allowed to see) is NOT the
  first-order gap: an A/B with `--cflags=-fstrict-aliasing` and one with
  `--cflags=-fno-wrapv` changed no row. CP1a (`restrict`) stays worth
  doing, but after CP2f, and it must show a row that moves.
- **`push` is 1.9× C, and the emitted C says why** (per push, i32 element):
  two `__yo_borrow_assert_unborrowed` loads-and-branches (`push` and the
  `try_push` it calls both assert), a `capacity()` call, the `_ptr` null
  branch, a checked `_length + 1`, a `Result` tag switch — and then **the Phase-0 contract**:
  `ensures(self.len() == old(self.len()) + usize(1))` is lowered to a runtime
  assert in every build, `assumed()` or not, which is two more `len()`
  calls, a checked add and an abort branch. Rust's `push` is a capacity
  compare, a store and `len += 1`.
- **`sort_by` is 4.3× C's `qsort`**, and `qsort` is itself slower than
  Rust's in-place driftsort. std sorts an index permutation
  (`_merge_sort_indices`, two `ArrayList(usize)` scratch lists, every
  index through the bounds-checked `index` helper, every merge counter a
  checked add), then applies it. The comparator is NOT the problem: the
  `Impl(Fn)` closure is a direct monomorphized call on a 1-byte capture
  struct, so CP1c's question is answered for this shape — no indirect call.
- **The collector costs nothing when nothing is tracked:** this program
  emits `__yo_gc_register` as an empty stub, and the cell header without
  GC fields is 8 bytes (`ref_count u32, type_id u16, borrow_count u16`).
  CP2e's tax appears only with `Rc`-recursive payload types; it is the
  compiler's own cost, not a general one.

**Non-goals.** No direct LLVM backend: the portable-C identity is
load-bearing ([`PORTABLE_C_DISTRIBUTION.md`](reference/PORTABLE_C_DISTRIBUTION.md),
the bootstrap chain — `yo.c` runs wherever any C compiler runs), and after
`restrict` + LTO + PGO clang *is* LLVM's optimizer for this C
(`plans/ROADMAP.md` lists the backend as a non-goal). Recorded 2026-10-08,
this is a **reopen condition, not a flat no**: reopen only if, after CP1 and
CP2 land, CP0's paired suite still shows a gap to Rust that is (a)
persistent across releases, (b) attributable by profiling to metadata or
lowering the C path cannot express — exact `noalias` without `restrict`'s
UB-on-violation, per-construct aliasing facts, Yo-aware lowering of count
and flag operations — and (c) worth more than it costs: an IR emitter owns
per-triple ABI (raw IR does not inherit clang's calling-convention and
struct-passing decisions), DWARF emission, and a doubled gate surface. If it
ever reopens, the shape is an optional `--backend llvm` for release builds
(`.ll` text, compiled by clang), with C staying canonical for bootstrap,
portability and every gate. No language-semantics change. No async-runtime
work (the ASYNC plans own it; the runtime is already at measured libuv
parity).

**Relationship to VALUES_BY_DEFAULT.** Every VBD phase reshapes the emitted
C, so the measurement-gated work is sequenced around it (§5); nothing here
re-baselines what a VBD phase owns (`check ./src` time, stage-2 RSS stay
that campaign's ratchets).

## 1. CP0 — the measurement (first PR, prerequisite for everything)

Without numbers, "on par with Rust" is unfalsifiable and every later phase is
unprovable. Two layers:

- **The paired suite**, `scripts/bench/lang-vs-c/`: the same workload written
  in Yo, Rust and C, one directory each, a runner script printing a table.
  The initial set, chosen to cover the cost axes of §0:

  | Workload | What it isolates |
  | --- | --- |
  | numeric kernel (dot product, n-body step) | autovectorization; what `restrict` unlocks |
  | ArrayList/Vec churn (build, sort, dedup) | buffer ownership, growth, move/copy costs |
  | string building + parsing (a small JSON/toml reader) | `String`/`&str` shape vs `String`/`&str`, bounds checks |
  | an `Rc`/`Arc` tree walk + rewrite | handle traffic, write asserts, collector |
  | iterator sum / filter-map chains | decision 39's bounds check vs Rust's elision |
  | closure-heavy (a `with_lock`-shaped loop) | whether `Impl(Fn)` bodies fold away |

  Rust compiled with its release profile, C with clang `-O2` (and `-O3` for
  reference), Yo with `--optimize 2`. Results land in this file, dated, per
  phase that claims a change — the same discipline VBD applies to
  `check ./src` time.
- **Event counters, not only wall clock** (added 2026-10-09). A build-time
  knob (`-Dyo_perf_counters=1`-shaped, off in every gate) makes the
  runtime count, per process, the events each CP2 lever claims to remove:
  borrow-mark acquires and releases, write asserts executed, overflow and
  index guards executed, `Rc` increments and decrements, collector
  registrations and tracked-list scans. Printed at exit, recorded beside
  each bench row and for `check ./src`. A lever's PR then shows two
  deltas — events removed and time saved — so a lever that removes many
  events for no time is dropped, and a time win is attributed to the
  events it removed rather than to noise (the macOS footprint lesson:
  single-binary wall clock swings run to run).
- **The macro-benchmark you already own**: the fixpoint battery's wall clock
  (`scripts/bootstrap/fixpoint_only.sh`, `gates_fast.sh`) is a large real Yo
  program running its own test suite through a self-compiled binary. Record
  it beside the suite at each phase; it catches what microbenches miss.

CP0's PR ships the suite, the first table, and nothing else.

## 2. CP1 — let clang see the guarantees (codegen only)

### CP1a. `restrict` for exclusive parameters

Emit `T* restrict` (and `const T*` stays as is) where Yo has *proved*
exclusivity, so clang may treat the parameter as `noalias` — the one
attribute Rust gets from `&mut` that the C pipeline currently throws away.
Decision 29 recorded the precedent (Hylo passes parameters by pointer "adding
only LLVM attributes (`noalias`, `nofree`, `nocapture`, and `readonly` for
`let`)").

**Where it is sound:**

- a `mut(x) : T` / `mut(self)` parameter whose lent place is value-rooted:
  decision 28's overlap rules reject every competing argument at compile
  time (E0901/E0911), so at the C level no other access path into the object
  exists in this call;
- a `mut` place through an `Rc`/`Arc` deref, provided the exclusive-flag
  acquire and its assert are emitted before any payload access: the assert
  reads the cell header, not the payload, so the object is only ever
  accessed through the `restrict` pointer or after a panic.

**Where it is not:** `imm` parameters — two `imm` arguments may alias
(decision 28 allows it), so `noalias` would be a lie. A later extension may
emit it where Stage-1 summaries prove the argument disjoint from every other
alias in the call.

**Canaries.** `restrict` violations are silent UB, so the gate is the
UBSan language-suite job (`ubsan.yml`) plus stress tests that alias exactly
the ways the rule must reject (overlapping `mut` args — compile errors;
writes through a second `Rc` handle during a pinned walk — the §3.10 panic).
A `-fno-`-style kill switch is not kept: the canaries are the contract.

**Phase:** after the V3b Generation B flip (the `mut` spelling and the
by-value default are then final, so the rule keys on the end-state modes).

### CP1b. LTO edges (an audit, not a build)

ThinLTO is already the default for chunked `-O1+` builds (`--no-chunk-lto`
opts out; wasm excluded), with the measured numbers in §0 — there is nothing
to add for the common path, and single-file builds need no LTO (inlining is
already intra-TU). What remains is small:

- the flag is clang-shaped: `-flto=thin` is not gcc's spelling (`-flto`),
  and zig/msvc are their own stories — audit every supported C compiler in
  the target matrix (`src/target.yo`) so a non-clang toolchain either gets
  its own flag or a loud error, never a silently slower or broken link;
- confirm the posture with CP0's per-compiler numbers and document it beside
  [`CHUNKED_C_EMISSION.md`](reference/CHUNKED_C_EMISSION.md)'s;
- **`-fno-strict-aliasing` has no recorded reason** (added 2026-10-10):
  `src/main.yo` passes it unconditionally with no comment, and it predates
  the TypeScript-to-Yo rename (`git log -S` finds nothing earlier than
  #171). `-fwrapv` beside it is documented (MEMORY_SAFETY limitation 6).
  Measured 2026-10-10: `--cflags=-fstrict-aliasing` moved no row of §0.1's
  table. Keep the flag (the runtime's `void*` cell casts are exactly what
  TBAA punishes) but record that reason in the source, and re-measure on
  the self-build once, since a type-punned hot path there would show as a
  TBAA win that the kernel cannot see.

### CP1c. The closure-call audit

The closure-borrowing API style (`with_lock`, `with`, `for_each`, the
borrowed `for`) matches Rust's stack guards only if the monomorphized
`Impl(Fn)` call folds away. CP0's closure bench answers it from the emitted
C; if the call site is an indirect call through a stored function pointer,
the fix is in the specialization/inlining emission (`src/codegen/exprs/inline_fns.yo`
is the existing inline machinery), not in the API.

**Answered for the comparator shape (2026-10-10, §0.1):** `sort_by`'s
`Impl(Fn(imm(a) : T, imm(b) : T) -> bool)` argument is emitted as a 1-byte
capture struct passed by value and called directly
(`closure_yo_id_…(&less, a, b)`), a `static inline` function clang inlines.
The borrowed `for`'s body is emitted inline in the loop. What remains for
CP0 is the `with_lock`-shaped case (a closure crossing a `Mutex` method)
and a closure with captures; the no-capture case is settled.

## 3. CP2 — stop paying for checks the language already subsumes

### CP2a. Finish the 5b elision line (designed work, not new design)

SAFE_MODE 5b Phases 0–2 landed (#983, #987, #998, #1009): a verify-mode entry
file's guards elide through `guard_site_is_proved` and the verifier's sited
`index-in-bounds` obligations. What remains is owned by the backlog designs
and lands as they say:

- [`SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md`](backlog/SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md)
  — the std container's own trap elided at proved call sites (option A
  implemented on its branch per that doc; land or re-land it);
- [`SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`](backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)
  — Phase 3, the general verifier-driven elision.

This plan's only addition: the CP0 suite before/after, so the elision's
value is a number in this file, not an assertion.

### CP2b. The borrowed `for` lowers to a hoisted walk

Decision 39 accepted "one bounds check per step" for index walks. Inside the
borrowed `for` the check is redundant, because the guarantee lives elsewhere:

- **value-rooted container:** the body's element borrow conflicts with every
  `mut` access on the root (E0911), so growth mid-walk is a compile error —
  the loop is as safe unchecked as checked;
- **`Rc`-rooted container:** the pin is retained, and every write through
  the cell asserts (§3.10), so a growth that would reallocate panics before
  the old buffer is freed.

The lowering hoists the length and the element pointer at loop entry and
walks raw elements. `indices()` walks and `xs(i)` outside the macro keep
their checks (growth is genuinely possible there), so decision 39's test
requirement survives with its three readings: value-root = compile error,
`Rc`-root = pin panic, cursor walk = bounds error.

**Phase:** with V2b (the collections must be uniquely owned first).

**Re-weighted 2026-10-10 (§0.1):** in a straight read walk the per-step
guard is already free — clang hoists the `_length`/`_ptr` loads, and
removing the guard outright measured 0 ms on three workloads. CP2b's win
is confined to loops whose body stores through the container (the guard
reloads after every store under `-fno-strict-aliasing`) and to the null
branch `ArrayList.index` adds after the bounds check (`.None =>
__yo_panic("index on empty list")`, unreachable when `_length > idx`, a
second branch per access in every non-hoistable shape — a one-line std
fix, independent of this phase). Measure a store-heavy workload before
spending the lowering.

### CP2c. Which `Rc(T)` writes compile — the static exclusivity verdict

Per VALUES_BY_DEFAULT.md §3.10 (decisions 41 and 43): at every write through
a shared handle and every mutating-method entry on a cell, the Stage-1
mutation summaries (`src/evaluator/effects/mutation_summary.yo`) decide (a)
proved safe — a plain write with no assert and no mark traffic; (b) proved
conflict — a compile error; (c) undecidable — a compile error naming the
repairs (`RefCell(T)`, `Rc.get_mut`). There is no run-time mark on a plain
`Rc`; the mark exists only inside `RefCell(T)`. So this lever is not an
elision: the assert on a plain `Rc` is never emitted, and what the
summaries decide is whether the write compiles. CP0's "asserts executed"
counter counts `RefCell` `with_mut`/`get_mut` entries, and the ratchet is
the number of `RefCell` fields in `src/` and `std/` at V4/V5. One negative
test per outcome (§3.10's list).

**Phase:** §3.10's rollout — Generation A with V1's write-site work (the
census, run-time assert kept for (c)); Generation B on the next seed (the
sweep, then (c) is the error).

Dead `Rc.clone()` elision needs no work here: decision 27 owns it, landing
with V2b.

### CP2d. `Rc(T)` versus `Rc(RefCell(T))` — adopted (decision 41, 2026-10-10)

A plain `Rc(T)` has no borrow flag and pays what Rust's `Rc<T>` pays: no
header word for marks, no mark set/clear around a lend, no assert at a
write (a write through it compiles only where CP2c's summaries prove it
exclusive). `Rc(RefCell(T))` is spelled where mutation through a handle
happens, and only its cell carries the marks and the `with_mut`/`get_mut`
assert. The fact is in the type, so it is modular — it holds across static
libraries and needs no whole-program "frozen cell" analysis — and a struct
definition shows which fields are dynamically checked. The ergonomic price
(every user spells `RefCell` where handle mutation happens) is Rust's own,
and decision 21's immutable trees mean the compiler pays it in few places.

**Measured target:** CP0's `Rc`-tree row with the mark/assert counter;
after this lands the counter reads zero on a program with no `RefCell`.

**Phase:** V1 adds `RefCell(T)`; the header word goes with V2b.

### CP2e. Collector tracking only for cells that can form a cycle (decision 41)

The maintainer's constraint: Rust-level performance **with** the cycle
collector kept for `Rc` graphs that do form cycles. The collector's cost is
per *tracked* cell (§0, cause 3), so the lever is the tracking predicate,
not the algorithm.

**The rule: construction-time acyclicity.** A cell can only point at values
that existed before it was built, so a cycle through `Rc(T)` requires a
later write, through a shared handle, into a field of `T`'s payload that
reaches an `Rc`. In safe code such a write exists only inside a `RefCell`,
`Mutex` or `RwLock`, so the predicate is a type property with no analysis:
**track a cell iff its payload reaches a `RefCell`/`Mutex`/`RwLock` that
reaches an `Rc`.** A payload with none needs no registration, no buffer
push on decrement, no mark bytes and no scan; its cells cost exactly what
Rust's `Rc<T>` costs.

- **What stays tracked:** payloads reaching one of those cells that reaches
  an `Rc` (parent pointers, open graphs, mutable registries), plus the
  conservative cases — a `Dyn` payload, a closure capture record, and any
  type reachable from them (their field writes are not enumerable per
  type). The `Acyclic` trait (`std/prelude.yo`) remains the user's
  assertion where the predicate is conservative, as `arc`'s bound today.
- **What changes in the runtime:** nothing. The Bacon-Rajan buffered
  decrement and the allocation-driven full scan
  (`src/codegen/functions/gc_runtime.yo`) keep their shape for the tracked
  set; `__yo_gc_register` is simply not emitted for untracked types' cells.
  `tracked_count()` (`std/gc`) reports the smaller set.
- **Canaries:** the move-formed-cycle reproducer recorded in
  `issues/fixed/yo-gc-full-heap-scan-bottleneck.md` and the cycle-collection
  language tests (`tests/cycle_collection*.test.yo`) must keep passing for a
  tracked type; an untracked type's cells must show zero registrations in
  CP0's counter; a type that gains a `RefCell` field must flip to tracked.

**Phase:** with CP2d (`RefCell(T)` is the predicate's input), after CP0's
counters. Expected to be the largest collector-side win for the compiler's
own trees (V4 makes every tree node an `Rc` cell, almost all immutable).

### CP2f. A range pass for overflow and index guards, without the solver (2026-10-09)

Safe mode's overflow traps are the one check Rust's release profile does not
pay (§0, cause 2). CP2a removes them where the *verifier* proves them, which
needs a verify-mode build and Z3. The common loop shapes need neither:
`i + 1` where `i < xs.len()`, `acc + x` under a stated bound, an index
`i * stride + j` inside a bounds-checked walk. Emit those bare from a
codegen-side pass over intervals and difference bounds — the L7 lever of
[`SELF_VERIFICATION.md`](SELF_VERIFICATION.md) (decision D3 there:
zones plus intervals), run as an elision pass instead of an invariant
generator — keyed to the same `guard_site_is_proved` sites CP2a uses, so a
site is elided once by whichever proof reaches it first.

- **Scope:** `+ - *` and negation on the integer widths, and the index
  guards decision 39 keeps on cursor walks, inside loops whose bound is a
  container length or a comparison the pass can read. Division, shift and
  the general case stay with CP2a.
- **Soundness gate:** the elided guard's trap must be unreachable by the
  pass's own proof; the UBSan language suite (`-fwrapv` keeps signed
  overflow defined, so a wrong elision is a wrong value, not UB) plus a
  mutation-tested negative corpus (perturb each rule, assert the guard
  returns) are the canaries. The `wrapping_*` hatch is unchanged.
- **The policy question this does not decide** is in §7: whether a build
  knob that *wraps* instead of trapping (Rust's release behavior) should
  exist at all. The position recorded here: not before CP2f's numbers;
  safe mode's D1 stands, and a knob is a last resort for a measured kernel
  the range pass cannot reach.

**Phase:** after CP0 (it needs the guard counters); independent of VBD.
**Promoted 2026-10-10 to the first lever after CP0**: §0.1 measured the
trap as the entire 5.7×/7× gap on integer reductions, with the other guards
at zero, so this pass is where the first user-visible win is. Its first
three rules are exactly the kernel's shapes: a counter `i + 1` under
`i < n`, an accumulator `acc + x` where `x` is narrower than `acc` (an
`i32` into an `i64` cannot overflow in fewer than 2^32 steps, and a loop
bounded by a `usize` length can be proved shorter than that), and an index
expression `base + i` under a bounds check. Until the pass exists, the
documented escape is `wrapping_add` at the hot site, which is what §0.1's
"wrapping" column did by hand.

### CP2g. Erase contracts the verifier already proved — in every build (2026-10-10)

Phase-0 contracts are runtime asserts, and the 5b line erases a guard only
when the verifier proved it inside the same `yo compile` (its recommendation
1: "no Z3 in codegen", the verify cache "is never a source of proofs on its
own"). That rule is right for user code, and it means std's `push`
postcondition is checked on every push of every optimized program, although
the CI FV job proves `std/collections/array_list.yo` on every merge.

The lever: **a proof result for std is a property of std's source**, so the
release bundle (and `yo build` of this tree) can carry the FV job's verdict
per contract site, keyed by the content hash of the module, and codegen
erases a proved clause in `--optimize 1+` builds. An `assumed()` clause is
not proved and keeps its assert (the runtime check is the only thing
standing behind the assumption); `requires` clauses keep their assert at
the call boundary unless the caller's side is proved too. `-O0` keeps
everything. This is 5b's side table with one more source of entries, gated
by the same cross-check against the site's source position, so a stale
verdict can only ever fail closed (the assert stays).

**Measured target:** `push` at 1.9× C (§0.1) with the contract being two
`len()` calls, a checked add and a branch of that; the push row before/after
is the acceptance number, together with CP0's "asserts executed" counter.

**Phase:** after CP0's counters; independent of VBD; needs a dated amendment
to `SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md` recommendation 1 (an open
question in §7 until the maintainer rules).

### CP2h. std's sort in place (2026-10-10)

`sort_by` at 4.3× `qsort` (§0.1) is the index merge sort of
`std/collections/array_list.yo` (`_merge_sort_indices`): two
`ArrayList(usize)` scratch lists, every index read through the bounds-checked
helper, every merge counter a checked add, and a final permutation pass.
The doc comment records why: a scratch of RC-typed uninitialised slots was
a trap under the old `consume(p.* = v)` discipline, and a second generic
instantiation confused the specializer. V2b's unique buffers remove the
first reason, and the second is a specializer bug to fix, not design around.
The target is Rust's: an in-place stable merge (or driftsort) over the
element buffer, with the merge counters written so CP2f discharges them.
Acceptance is the sort row of CP0, and `tests/` sort tests plus the
RC-balance witness the current comment cites must keep passing.

**Phase:** after V2b (unique buffers); independent of the codegen phases.

## 4. CP3 — layout and profiles

- **CP3a. Field reordering** in codegen for non-`extern` nominal types
  (descending alignment, deterministic by type key so chunked emission
  agrees across translation units). C keeps declaration order; rustc's
  `repr(Rust)` reorders — this is the free cache win on hot structs.
  `extern`/C types keep declaration order (ABI); the `Option` one-pointer
  niches must survive; `sizeof` goldens move with this.
- **CP3b. PGO**: `--pgo generate|use` mapped onto clang's
  `-fprofile-generate`/`-fprofile-instr-use` (gcc equivalents per target),
  counter-file placement under `yo-out/`, documented in BUILD docs. The flag
  is not `--profile`: that name is already the timing report of `yo build`
  and `yo compile` (`profile: watch round N <ms> rss=…MB`), and a PGO knob
  must not shadow it. BOLT is a later option once PGO exists.

## 5. Gates and sequencing

Every phase: the AGENTS.md battery (`check ./src`, `check ./std`,
`compile --skip-c-compiler`, `build --std-path ./std`, fixpoint,
`gates_fast`, the fast language suite, fmt with the tree binary) **plus the
CP0 table before/after in this file**. CP1a additionally requires a green
UBSan language suite. One PR per phase, or a stack with one battery.

| Phase | Depends on | Can start |
| --- | --- | --- |
| CP0 | — | now |
| CP1b (LTO audit) | CP0 per-compiler numbers | now |
| CP1c (closure audit) | CP0 | now |
| CP1a (`restrict`) | V3b Generation B flip; UBSan canaries | after V3b |
| CP2a (5b) | its own backlog designs | as designed |
| CP2b (`for` lowering) | V2b | after V2b |
| CP2c (which `Rc(T)` writes compile; marks only inside `RefCell`) | §3.10's rollout (Generation A with V1, Generation B on the next seed) | with V1's remainder |
| CP2d (`Rc(T)` markless, `Rc(RefCell(T))` where handle mutation happens) | V1 adds `RefCell(T)`; the header word goes with V2b | with V1 / V2b |
| CP2e (collector tracking by the `RefCell`/`Mutex`/`RwLock`-reach predicate) | `RefCell(T)`; CP0's registration counter | with CP2d |
| CP2f (range pass for overflow/index guards) | CP0's guard counters | **first after CP0** (2026-10-10: the measured 5.7×/7× integer-loop gap); independent of VBD |
| CP2g (erase proved std contracts in every build) | CP0's assert counter; a §7 ruling on 5b's recommendation 1 | after CP0; independent of VBD |
| CP2h (std sort in place) | V2b unique buffers | after V2b |
| CP3 | everything worth profiling | last |

## 6. Risks

- **`restrict` is a soundness claim, not a hint.** A wrong rule is silent UB;
  the UBSan job and the alias stress tests are the only detectors, so the
  rule ships conservative (value-rooted `mut` first, the `Rc`-path rule only
  with the assert-ordering proof) and widens by measurement.
- **CP1b's audit must not regress the default.** ThinLTO's on-by-default is a
  measured position (`CHUNKED_C_EMISSION.md`); any per-compiler change keeps
  dev builds chunked and re-measures `yo build` wall clock in the PR.
- **CP2b changes panic sites** (a growth attempt inside a value-rooted
  borrowed `for` becomes a compile error instead of a bounds error); the
  decision-39 test and its docs move with it — a dated amendment there, not
  a silent change.
- **Elision by summary is only as sound as the summaries.** CP2c reuses
  machinery that already gates D3 checks; its negative tests (the panic
  canaries) must fail before the elision exists.
- **An un-tracked cycle is a silent leak, not a crash.** CP2e's frozen
  fact must be recomputed on every build from the whole program; a cached
  or per-module answer is wrong the moment a new write site appears. The
  negative test per write shape and CP0's registration counter are the only
  detectors, because a leaked cycle produces no failure.
- **A wrong range fact is a wrong value.** CP2f elides a trap, and under
  `-fwrapv` the result silently wraps; the mutation-tested negative corpus
  is mandatory before any rule ships, and the pass starts with the three
  loop shapes above, nothing more.

## 7. Open questions

- Whether `imm` parameters may earn `restrict` where Stage-1 summaries prove
  an argument disjoint from every other alias in the call (a per-call proof,
  unlike CP1a's per-rule one).
- **Whether a wrap-instead-of-trap build knob should exist** (the
  maintainer's call, after CP2f's numbers). Rust release wraps; safe mode
  traps at every `-O` by D1. If a measured integer kernel still exceeds the
  tolerance after CP2f and `wrapping_*` at the hot sites, the candidates
  are a per-module `pragma` or a `--overflow wrap` compile flag; both
  change what a safe program means, so neither lands without a dated
  amendment to SAFE_MODE.
- **The tolerance itself.** The maintainer's target (2026-10-09) is within
  0–5% of Rust's release profile per paired workload. CP0's table carries
  that column; a workload outside it names the cause from §0.
- **Whether a proof produced outside the compiling process may erase a
  runtime check** (CP2g, 2026-10-10). 5b's recommendation 1 says no, for
  user code, so that a missing solver can never silently drop a guard. For
  std the proof is CI's, pinned to a content hash, and the alternative is
  every optimized program re-checking `push`'s postcondition forever. The
  position here: yes for std and for any dependency whose proof verdict is
  shipped with its source hash, fail-closed on any mismatch, never for the
  entry file; `yo verify` output is the artifact, not the cache.
- **Where the Rust column comes from.** No dev box here has `rustc`; CP0's
  paired suite needs a CI job with a pinned Rust toolchain, and its numbers
  then come from Linux x86-64 and arm64 runners, not from the M4 the
  §0.1 table was measured on. The C column is the stand-in on a dev box.
