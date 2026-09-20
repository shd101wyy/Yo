# Perceus-style reuse — drop-guided allocation reuse in Yo's RC codegen

**Status: DESIGN, NOT STARTED (2026-09-20).** Written in answer to "is
Perceus a better fit for Yo than an arena?" after
`ARENA_ALLOCATOR_FEASIBILITY.md` (2026-09-20) found that arenas cannot be made
RC-free without region types and do not touch the compiler's footprint. Sister
plan: `../EVALUATOR_MEMORY_REDUCTION.md` (the footprint; this document is about
allocation CHURN and the CPU it costs).

## 0. Verdict

**Yes — Perceus is the allocation lever that fits Yo's model, and it is the
one that needs no new language surface.** Yo already has the three things
Perceus is built on: precise, non-atomic reference counts on every heap cell;
an ownership analysis in the evaluator that knows which local OWNS a count and
where its last use is (`is_owning_the_rc_value`, `set_expr_as_consumed`,
`_optimize_dup_drop_pairs`); and typed constructors / typed dispose in the
emitted C. Reuse is a local rewrite — "this cell is about to die, and a
same-size cell is about to be allocated: hand the memory over" — guarded at
runtime by a uniqueness check (`ref_count == 1`, `borrow_count == 0`), so it is
sound by the same argument as `Iso`'s `can_isolate` and needs no escape
analysis, no lifetimes, no arena scope. It respects the policy/mechanism split
(`RC_POLICY_MECHANISM_SPLIT.md`): the evaluator decides WHERE a cell may be
reused, codegen decides HOW.

What it buys: fewer `malloc`/`free` pairs and less `memset`/cache traffic on
churn-heavy code (the self-compile constructs 1.59 B objects for 130 M
survivors — §2). What it does **not** buy: peak footprint (retention is the
footprint, §`EVALUATOR_MEMORY_REDUCTION.md`), nor the ~58% of CPU in
`__yo_decr_rc` that comes from dup/drop traffic on lookups
(`issues/yo-self-compile-performance-rc-string-eq.md`) — that is the
Symbol/identity lever. Perceus's gain is bounded by how often a death and a
same-size birth sit next to each other in one block; **Phase 0 measures that
ceiling before anything is built**, with a go/no-go.

## 1. What Perceus is, part by part, against what Yo has

Perceus (Reinking, Xie, de Moura, Leijen, PLDI 2021; Koka, Lean 4):

| Perceus part                                                                      | Yo today                                                                                                                                                                   | gap                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Precise RC, owned calling convention** — a function owns its arguments and drops them at last use | Non-atomic RC; **parameters BORROW by default**, `own(x)` opts in (`RC_OWNERSHIP_IMPLEMENTATION.md` Phase 1); locals own; last-use analysis exists (`_optimize_dup_drop_pairs`, `begin.yo:1028`) | reuse of a caller's cell inside the callee needs `own`; reuse of LOCALS needs nothing new |
| **Drop specialization** — inline the drop for a known type, dropping fields individually | Typed `dispose_fn` per type, `generate_drop_code_for_value` (`codegen/exprs/drop_dup.yo:175`) descends arrays/tuples by C lvalue                                             | none                                                             |
| **Reuse analysis** — pair `drop(x)` with a same-size constructor in the same block; pass a reuse token | Deferred drops are typed `AstExpr`s the evaluator plans and codegen emits at flush points; constructors are `__yo_new___yo_t_N[_Variant](args)` (`other_fn_call.yo:874/1695`) | the pairing pass, an ExprInfo channel for the token, `_in`-constructors |
| **Dup/drop fusion** — a field re-stored into the reused cell is moved, not dup'd+dropped | The optimizer already turns a single dup + scope-end drop into a MOVE (`isOwningTheSameRcValueAs`, Phase 1.5)                                                                | field-level fusion at the reuse site (Phase 2)                    |
| **FBIP** — functional-but-in-place updates of unique data                          | `ref(struct/enum)` are mutable in place already, so FBIP's headline case is free; the payoff is REBUILD-heavy code (`substitute`, `synthesize`, `clone_expr_fresh_ids`, `EvalValue` transforms) | none beyond reuse                                                |

Two Yo specifics change the shape of the design:

1. **Borrowed parameters.** Koka's `map(xs, f)` reuses each cons cell because
   `xs` is owned by the callee. In Yo a callee sees a borrowed `xs`; reuse of
   an argument's cell requires `own(xs)`. Reuse is therefore first a
   LOCAL-VARIABLE optimization (owned locals, temporaries, `own` params), and
   `own` inference is deliberately out of scope (borrow-by-default is a design
   decision, `RC_OWNERSHIP_IMPLEMENTATION.md`).
2. **The cycle-collector header.** A dying tracked cell may be on the
   `possible_roots` buffer (`__YO_GC_BUFFERED`) and is on the `tracked_objects`
   list; reuse must leave those lists consistent (§4.1). Untracked cells
   (`ArrayList(u8)`, `Token`-like) are the easy majority.

## 2. The measured target (2026-09-20 census, `check src/main.yo`)

Gross constructions vs survivors, from `scripts/bootstrap/live_census_t.py`
(`EVALUATOR_MEMORY_REDUCTION.md` §0.4): 1.59 B constructions, 130 M live at
exit. The churn-heaviest types — the ones where a death and a same-size birth
are most likely adjacent:

| type                             | gross    | live    | gross/live | sizeof | note                                           |
| -------------------------------- | -------- | ------- | ---------- | ------ | ---------------------------------------------- |
| `ArrayList(u8)` (strings)        | 729.6 M  | 22.6 M  | 32×        | 40     | template strings, `to_string`, keys             |
| `ArrayList(usize)`               | 136.3 M  | 12.0 M  | 11×        | 40     | level lists on `SomeT`/`DynT`, frame positions |
| `ArrayList(TypeValue)`           | 129.8 M  | 11.6 M  | 11×        | 80     | every `substitute`/`synthesize` rebuild        |
| `ArrayList(String)`              | 103.6 M  | 3.4 M   | 30×        | 40     | label lists, `split`, paths                    |
| `ArrayList(AstExpr)`             | 23.8 M   | 3.9 M   | 6×         | 40     | arg lists of cloned bodies                     |
| `TypeValue`                      | 16.4 M   | 7.8 M   | 2×         | 176    |                                                |
| `EvalValue`                      | 15.2 M   | 1.8 M   | 8×         | 96     | transient values                               |
| `HashMap(String, unit)`          | 13.5 M   | 4.4 k   | 3000×      | 72     | visited sets minted and dropped per call       |
| `ArrayList(Variable)`            | 15.2 M   | 0.3 M   | 44×        | 80     | per-frame lists                                |

CPU side (`YO_SELF_ENV_SHARING.md` §3b, `check`, 2026-08-22): `malloc`/`free`
≈16%, `memset`/`memmove`/`memcmp` ≈7%, `__yo_decr_rc` ≈16% self time.

The ceiling for reuse is the fraction of those constructions that (a) sit in
the same straight-line block as the death of a same-size owned local and (b)
find that local unique at runtime. Nobody has measured (a) or (b) for Yo.
Koka reports most cons-cell allocations in list-processing code reusing; Yo's
compiler is not that shape (it builds up tables), but its type
substitution/synthesis and string formatting are.

## 3. Soundness

A reuse rewrite replaces `___drop(x); cell := __yo_malloc(size)` with
`cell := __yo_reuse_or_alloc(x, size)` where the helper either (i) proves
uniqueness at runtime and hands `x`'s memory over, or (ii) falls back to the
original two operations. Every path preserves the RC invariant:

- **Uniqueness is checked, not inferred.** `ref_count == 1 && borrow_count ==
  0` at the moment of reuse. Any other owner (an aliasing local, a capture, a
  container) makes `ref_count > 1` → fallback. Any live interior borrow (an
  `inout(y) := x.field` binding, a method-entry borrow assert) makes
  `borrow_count > 0` → fallback. This is exactly `Iso`'s `can_isolate`
  argument (`docs/en-US/ISOLATED.md`).
- **The death is a real death.** The evaluator marks `x` CONSUMED at the
  reuse site exactly as `_optimize_dup_drop_pairs` marks a move winner, so
  the scope-end drop is skipped (its e5 consumed gate) and the M3 machinery
  attaches early-return-only drops for exits between init and the reuse
  point. Codegen's RC balance is therefore identical to a move.
- **Children are disposed, not leaked.** Before the cell is handed over its
  `dispose_fn` runs (drops fields/buffers); Phase 2's fusion replaces that
  with per-field moves/drops but never skips a field.
- **The collector stays consistent.** Reused untracked cells need nothing.
  A tracked dying cell: if `__YO_GC_BUFFERED`, `__yo_gc_remove_root` first;
  it stays on `tracked_objects` (the new object is tracked too when sizes
  match within one type; for a cross-type reuse into an untracked type,
  `__yo_gc_unregister` — or restrict Phase 1 to same-type reuse and avoid
  the question). Reuse never runs while `__yo_gc_collecting` (it is user
  code, not collector code).
- **Atomic RC types are excluded.** `atomic(ref(...))`, `Arc`, `Iso`: a
  relaxed `ref_count` read is not a uniqueness proof under concurrent
  `incr`; `Iso` uses an acquire load for `rc()` and is the only place that
  reasons about it. Keep them out; they are not the churn.
- **Async state machines are excluded in Phase 1.** Locals that cross an
  `await` live in the state struct; the async emitter has its own
  destructure/drop loops (memory note "async match emitter has its own
  destructure loop"). Reuse inside `io.async` bodies waits for Phase 3.

Failure mode if any of the above is wrong: a use-after-free, immediately
visible under ASan (the layout-bug friendly failure) — hence the Linux ASan
run and the red-first canaries in §6 are mandatory for every phase.

## 4. Design

### 4.1 Runtime (emitted C, `codegen/functions/gc_runtime.yo`)

```c
// Hand x's cell to a same-size construction when x is provably dead and
// unique; otherwise drop x and allocate. `size` is the NEW type's sizeof.
static inline void* __yo_reuse_or_alloc(void* x, size_t size) {
  if (x != NULL) {
    __yo_ref_header_t* h = (__yo_ref_header_t*)x;
    if (h->ref_count == 1 && h->borrow_count == 0) {
      if (h->gc_flags & __YO_GC_BUFFERED) { __yo_gc_remove_root(x); }
      if (h->dispose_fn) { h->dispose_fn(x); }     // drop children (Phase 1); fused per field in Phase 2
      return x;                                    // header is rewritten by the _in constructor
    }
    __yo_decr_rc(x);
  }
  return __yo_malloc(size);
}
```

Phase 1 restricts reuse to **the same type** (so `sizeof` and trackedness are
identical and the `tracked_objects` link stays valid); cross-type same-size
reuse (Koka does it) is a Phase 3 extension that must also handle the
tracked/untracked header difference (56 vs 16 B — a different `sizeof`, so
in practice it only pairs tracked-with-tracked).

### 4.2 Constructors that take a cell

For every ref type/variant with at least one reuse site, emit alongside
`__yo_new___yo_t_N[_V](args)` an `__yo_new___yo_t_N[_V]_in(void* cell,
args)` that skips `__yo_malloc` and `__yo_gc_register` (the cell is already
registered when same-type) but writes every header field exactly as the
fresh constructor does (`ref_count = 1`, `borrow_count = 0`, `gc_flags`,
`gc_mark`, `dispose_fn`, `traverse_fn`, `tag`). Emitter: `functions/constructors.yo`
(`:120-175` struct, `:590-640` enum) factored so both variants share the body.

### 4.3 Policy: where reuse tokens come from (evaluator)

A construction expression `T(...)` / `.Variant(...)` of a reference type `T`
gets a reuse candidate `x` when, in the block being evaluated:

1. `x` is a local (or `own` parameter) of the SAME type `T`, with
   `is_owning_the_rc_value == true` and not `is_ref`;
2. this construction is after `x`'s last use in the block, and no branch
   between the last use and the construction can use `x` (the
   straight-line condition — the same one `_optimize_dup_drop_pairs` needs
   for a move; loops disqualify a candidate that is live across the back
   edge, as the memory note "loops defeat drop-deferral safety" records);
3. `x` is not captured by a closure defined in the window (captures dup, so
   the runtime check would refuse anyway — the static filter is for
   emit stability), and `x` is not an `inout` borrow root with live
   borrowers (`find_live_inout_borrowers`).

The pass records `ExprInfoRare.reuse_candidate : Option(Variable)` on the
construction's `ExprInfo` and marks `x` consumed at that token. It runs
inside `evaluate_begin_expression` immediately after `_optimize_dup_drop_pairs`
(same inputs, same consumed-marking discipline). Priority shapes, in order:

- **A. Reassignment of an owned local**: `x = T(...)` where `x : T` — today
  `___drop(old x)` then the new value is stored; the drop and the alloc are
  adjacent by construction. The cleanest first target (loops that rebuild a
  cell per iteration, builders).
- **B. Rebuild of a consumed match scrutinee**: `match(x, .V(a, b) =>
  .V(f(a), b))` where `x` is an owned local dead after the match (or an `own`
  param). Destructuring BORROWS `a`/`b`; storing `b` into the new cell emits
  `___dup(b)` and disposing `x` emits `___drop(b)` — Phase 2's fusion cancels
  that pair (move) and drops only `a`.
- **C. Temporaries**: `g(T(...))` where a same-type temp dies in the same
  statement (`_optimize_dup_drop_pairs` already tracks statement temps by
  `isOwningTheSameRcValueAs`).

### 4.4 Mechanism: emission (codegen)

At the construction sites (`codegen/exprs/other_fn_call.yo:874` struct ctor,
`:1695` variant ctor; `comptime_value.yo` for comptime-materialized values),
when the `ExprInfo` carries a `reuse_candidate`, emit
`__yo_new___yo_t_N[_V]_in(__yo_reuse_or_alloc(<x>, sizeof(__yo_t_N)), args)`
instead of `__yo_new___yo_t_N[_V](args)`. The scope-end drop of `x` is already
gone (consumed). Nothing else in the emitter changes; the deferred-drop
flush points are untouched, which is what keeps the policy/mechanism split
intact.

### 4.5 Fusion (Phase 2, shape B)

For shape B the evaluator additionally records which destructured fields are
re-stored into the new cell (by variable identity). Codegen emits, instead of
`dispose_fn(x)`, a per-field prologue: re-stored fields are MOVED (no dup at
the store, no drop), the others are dropped with `generate_drop_code_for_value`.
This is Perceus's dup/drop fusion and where list/tree rebuilds become
allocation-free. It needs the field→argument mapping the constructor emission
already computes (`other_fn_call.yo:665` "value exprs in runtime-field order").

## 5. Phases

### Phase 0 — measure the ceiling (no compiler change), go/no-go

1. **Static candidates**: a `YO_REUSE_REPORT=1` pass (evaluator, read at exit
   like the `YO_DEBUG_*` knobs) that counts, per shape A/B/C, construction
   sites with an eligible candidate under §4.3's rules, on `check src/main.yo`
   and on `check ./std`. Also report the top 20 types by candidate count.
2. **Dynamic ceiling**: instrument the emitted C (a sibling of
   `live_census_t.py`): at every last-reference free record `sizeof`; at every
   object `__yo_malloc` check whether the previous free in the SAME C
   function had the same size and no intervening allocation — the
   "adjacent same-size death→birth" rate per type, and the fraction of those
   deaths that had `ref_count == 1` (always, by definition of free — the
   interesting number is how many ALLOCATIONS have such a predecessor).
   Run on the self-compile and on two churn-shaped programs (a JSON parser
   over 100 MB; a list-processing benchmark).
3. **Profile share**: `sample` of `check src/main.yo` for `malloc`+`free`+
   `memset` self time (the 2026-08-22 numbers are a month old).
4. **Decision**: predicted win = (share of allocations with an adjacent
   same-size death) × (malloc+free+memset share). **Go if ≥ 5% of wall on
   the self-compile or ≥ 15% on the churn-shaped programs; otherwise
   archive this plan with the numbers.**

### Phase 1 — shape A (reassignment) and C (temporaries), same-type only

1. Runtime helper `__yo_reuse_or_alloc` (§4.1) + `_in` constructor variants
   (§4.2), emitted only when a reuse site exists (no change to programs with
   none — byte-identical C, which is how the fixpoint gate stays meaningful).
2. Evaluator pass (§4.3) for shapes A and C; `ExprInfoRare.reuse_candidate`.
3. Emission (§4.4).
4. Gates (§6). Measure: allocation count (the census's gross column), wall,
   footprint (expect ≈ unchanged) on the self-compile and the two programs.

### Phase 2 — shape B (match-arm rebuild) with field fusion

1. Field→argument re-store mapping recorded by the evaluator; fused
   prologue emitted by codegen (§4.5).
2. Same gates; measure on `substitute`/`synthesize`-heavy inputs
   (`check ./std` is one) and on the list benchmark.

### Phase 3 — extensions, each with its own measurement

- Cross-type same-size reuse (tracked↔tracked only).
- `own` parameters as candidates (callee-side reuse of an owned argument).
- Async bodies (after the async emitter's drop loops are unified).
- A `--no-reuse` compile flag as the bisect/kill switch from day one of
  Phase 1; default-on decided by Phase 1's numbers.

## 6. Gates (every phase)

- `yo check ./src --std-path ./std`, `yo compile src/main.yo --skip-c-compiler`.
- **Emitted-C classification, not byte identity**: the corpus diff must
  consist ONLY of (a) `_in` constructor additions and (b) reuse rewrites at
  sites the `YO_REUSE_REPORT` listed; every removed `___drop` must pair with
  a reuse call in the same function. The dup/drop emit-diff gate (fewer dups
  = potential UAF) runs with reuse sites excluded and must otherwise be
  clean.
- **Over-cancellation canaries, red first** (memory notes "probe analyses
  that remove safety ops", "double-drop oracle"): for each §4.3 rule a
  program that would be MISCOMPILED if the rule were dropped — an aliased
  local (`y := x` before the rebuild, `y` used after), a closure capturing
  `x`, an `inout` borrow of `x.field` alive at the site, a loop where `x` is
  live across the back edge, an early return between last use and the
  construction. Each asserts observable behaviour AND a Dispose counter
  (dispose runs exactly once per cell; keep objects alive in a keeper so a
  double release cannot hide).
- Linux ASan run of the fast suite; `fixpoint_only.sh`; `gates_fast.sh`; the
  hollow-sweep ratchet.
- Performance: gross-construction count from the census, wall on the
  self-compile (quiet machine, `--optimize 2`, interleaved A/B).

## 7. What this plan does not do

- It does not reduce the footprint. Retention is the footprint
  (`EVALUATOR_MEMORY_REDUCTION.md`).
- It does not remove RC operations on borrowed lookups (the `__yo_decr_rc`
  58%): that is String identity / `Symbol` interning and borrow elision
  (`issues/yo-self-compile-performance-rc-string-eq.md`).
- It does not change the calling convention (parameters stay borrowed).
- It is not an arena: cells are reused one at a time, at the point their
  owner dies, with a runtime uniqueness check — which is exactly why it is
  sound without lifetimes.

## References

- Reinking, Xie, de Moura, Leijen. *Perceus: Garbage Free Reference Counting
  with Reuse.* PLDI 2021. Lorenzen, Leijen. *Reference Counting with Frame
  Limited Reuse.* ICFP 2022 (the drop-guided reuse refinement). Lean 4's
  `IR/ExpandResetReuse` (reset/reuse instructions) is the other shipped
  implementation.
- `plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md` (ownership model,
  Phase 1.5 pair cancellation), `plans/backlog/RC_POLICY_MECHANISM_SPLIT.md`
  (why the pairing decision belongs to the evaluator and the emission to
  codegen), `issues/fixed/where-constraints-arraylist-96b-leak.md` and
  `issues/fixed/spawn-closure-captures-never-dropped-leak.md` (the optimizer
  family's soundness rules), `plans/archive/PERF_BORROW_ELISION.md` (the
  RC-traffic attribution method).
