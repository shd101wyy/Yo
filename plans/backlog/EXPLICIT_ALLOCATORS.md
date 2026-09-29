# Explicit allocators (Zig-style) beside reference counting

> **Status: BACKLOG — design audit completed 2026-09-29, no implementation
> started.** Verdict: **feasible**. An explicit allocator in Yo selects *where*
> a block lives; reference counting keeps *whether and when* it dies. Every
> allocation falls back to the global allocator when no explicit allocator is
> in scope, so `ref(struct(...))`, `ref(enum(...))`, `Box`, `Dyn`, `Arc`,
> `String`, closures and all of std behave exactly as today unless a program
> names an allocator. This document answers the open question recorded in
> `std/allocator.yo`'s own stability note (2026-09: "a decision on whether
> containers take an allocator parameter the way Zig's and Rust's do …
> freezing needs a second implementor — an arena or a counting allocator").
> It is the per-object layer **on top of** — not a replacement for — the
> compile-time global allocator choice of
> [`FIXED_REGION_ALLOCATOR.md`](../reference/FIXED_REGION_ALLOCATOR.md) §0
> (which scoped itself to "Yo keeps one global allocator" and recorded the
> Zig-style parameter as out of that plan's scope).

## 0. Verdict

**Yes, the two compose**, because of where each mechanism sits:

| concern | owner | mechanism |
| --- | --- | --- |
| which pool a block comes from | explicit `Allocator` (opt-in) | allocation-site parameter/scope |
| when it is released | reference counting (always) | compiler-inserted dup/drop, refcount-0 dispose, cycle GC |
| released **back to the right pool** | automatic | the block records its owner; every free site routes on it |

That third row is the whole trick, and it is why this is *more* compatible
with RC than it first looks: in Zig, the programmer must pair every `free`
with the allocator the block came from — the single largest allocator bug
class (wrong-allocator free, use-after-arena-deinit) exists because the
pairing is manual. In Yo, frees are compiler-inserted at deterministic points
(`__yo_decr_rc`, the cycle collectors, thread-exit cleanup — §1.2), all of
which already hold the block's header. If the block records its owning
allocator, routing frees back is mechanical, and the Zig bug class is
impossible by construction rather than by discipline.

**Rule 1 (fallback).** Absent an explicit allocator, every allocation uses
the global allocator. Absence is never an error, never a behavior change,
and (P1) not even an emitted-C change.

**What does NOT carry over from Zig.** Zig's allocator parameter is also a
*lifetime* statement: `arena.deinit()` frees everything instantly and nobody
tracks liveness. Under RC, a block lives exactly as long as its refcount (and
the cycle collector) says — an arena cannot bulk-free what RC still counts.
Yo therefore gets the *placement* benefits of explicit allocators (memory
locality, a second TLSF region, scoped scratch space, per-subsystem OOM
budgets, test/counting allocators) and pays for them with one rule: **arena
`deinit` verifies emptiness** — live blocks at deinit are a tier-3 trap
(defined behavior, `file:line:col`, identical at every `-O`), and a
process-lifetime arena that never deinits uses the explicit `abandon()`
escape hatch instead. Bulk-free-without-check is the one Zig capability
declined, deliberately: it cannot be made sound under dynamic refcounts
without a proof RC does not have.

## 1. What exists today (measured 2026-09-29)

### 1.1 One allocator, chosen at compile time

Every allocation in a compiled program — RC objects, container buffers,
runtime internals — flows through one function family, selected at compile
time by `--allocator mimalloc|system|fixed`
(`src/codegen/c/collection.yo:173-236`; the fixed arm's TLSF lives in
`src/codegen/c/allocator_fixed.yo`). Above it, one helper is the sole entry
point for RC blocks:

- `__yo_rc_alloc(size)` — `src/codegen/c/collection.yo:500-512`: `__yo_malloc`
  + `__yo_alloc_fail` (OOM abort). Note the `__asm__ volatile("" : "+r"(p))`
  barrier keeping clang from fusing malloc+memset into a calloc that bypasses
  tcache (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.4) — any variant of
  this helper must preserve it.
- std reaches the same family via `GlobalAllocator` (`std/allocator.yo:47-162`),
  whose stability note already names this plan's question as the open one.

### 1.2 The complete RC allocation inventory

Every construct whose runtime construction allocates an RC-managed block,
with its emission site (all verified 2026-09-29):

| # | construct | allocation site |
| --- | --- | --- |
| 1 | `ref(struct(...))` ctor — also covers `atomic(ref(struct))`, `Box(T)`/`Arc(T)` (one-field ref structs, `std/prelude.yo:9395-9403`), `JoinHandle` | `src/codegen/functions/constructors.yo:182` |
| 2 | `ref(enum(...))` variant ctors (incl. atomic) | `src/codegen/functions/constructors.yo:670` |
| 3 | `Dyn(Trait)` boxes (`__yo_dyn_box_*`; `Dyn` is a compiler builtin type, not a prelude struct) | `src/codegen/functions/dyn.yo:142` |
| 4 | `Iso(T)` create | `src/codegen/types/generation.yo:1667` |
| 5 | async-block state machines | `src/codegen/exprs/async.yo:1428`, `:3067` |
| 6 | parallelism spawn closure-capture copy (non-RC block, freed with plain `__yo_free`) | `src/codegen/exprs/parallelism.yo:330` |
| 7 | GC per-thread state | `src/codegen/functions/gc_runtime.yo:762` |
| 8 | container buffers (ArrayList et al.) | std, via `GlobalAllocator` (§1.4) |

Template strings, `String`, `StringBuilder`, `Regex`, `std/hash` allocate no
other way: they bottom out in #1 (String is a newtype over
`Option(ArrayList(u8))`, `std/string/string.yo:86-88`) or #8. Capturing
closures do **not** allocate (stack capture struct,
`src/codegen/exprs/closures.yo:160-268`); a closure becomes heap state only
when boxed (`box`/`arc` → #1, or `Dyn(Fn)` → #3).

The free side is even more concentrated. When refcount hits zero the runtime
calls `dispose_fn` (or `__yo_dispose_dispatch`) and then `__yo_free(ptr)` at
exactly: `src/codegen/functions/gc_runtime.yo:400`, `:441` (atomic),
`:556`, `:609` (tracked tail), `:650`, plus the cycle collectors at
`:1036-1042` (incremental Bacon-Rajan) and `:1106-1117` (full trial
deletion), and thread-exit cleanup at `:1172`/`:1189`. The collectors free
through the **same** dispose → free sequence as normal drops, so routing the
free sites routes the collectors too. **No header records an owner today**
(§1.3) — there is exactly one allocator per process, so none was needed.

### 1.3 The RC headers

Three layouts, selected per type by `compute_needs_cycle_gc`
(`src/codegen/codegen_c.yo:192-215`), emitted in
`src/codegen/types/generation.yo`:

| layout | size | fields | used by |
| --- | ---: | --- | --- |
| full | 56 B | packed word (`ref_count : u32`, `gc_flags : u8`, `gc_mark : u8`, `borrow_count : u16`), `dispose_fn`, `traverse_fn`, gc/roots list links (`:980-1001`) | cycle-GC-capable ref types |
| small | 16 B | packed word + `dispose_fn` (`:1014-1021`) | cycle-incapable ref types |
| lightweight | 8 B | `ref_count : u32`, `type_id : u16`, `borrow_count : u16` (`:1043-1047`) | no-cycle-GC builds |

The packed word is size-tuned on purpose (real perf work lives in its
comments). None of the three has a spare byte for an allocator pointer —
this is why §3.3 puts the routing tag in the refcount's high bit, not in a
new field.

### 1.4 std containers hold no allocator state

`ArrayList(T) :: ref(struct(_ptr, _length, _capacity))`
(`std/collections/array_list.yo:36-44`) — every call is a *static*
`GlobalAllocator.*` call: growth malloc/realloc (`:231-238`, `:764-771`),
shrink (`:353`, `:367-370`), and the buffer free inside the `Dispose` impl
(`:885-896`, free at `:891`). Same shape in `hash_map.yo` (6 sites),
`deque.yo` (2), `std/imm/{vec,map,string}` (~10); `HashSet`, `BTreeMap`,
`LinkedList`, `StringBuilder`, `imm/{list,set,sorted_*}` allocate only
through these. No std API takes an allocator parameter; no `Arena`, bump or
pool allocator type exists anywhere in the tree (verified by grep). The
`Dispose` chain that frees buffers at refcount zero:
`Dispose :: trait(...)` (`std/prelude.yo:253-266`) → codegen-synthesized
`___dispose` calling the user `dispose` first
(`src/codegen/functions/collection.yo:1511-1585`) → stamped into the header
at construction (`constructors.yo:204-221`).

### 1.5 Docs promise nothing

`docs/en-US/MEMORY_SAFETY.md` and `docs/zh-CN/MEMORY_SAFETY.md` describe RC +
gated unsafe and mention "writing a custom allocator" only as an
unsafe-mode activity; `DESIGN.md` (en+zh) presents reference counting as
"Yo's universal object model". Allocator parameterization appears nowhere —
the feature is docs-additive, not docs-breaking.

## 2. Why this composes with RC (the compatibility argument)

1. **Frees are never manual, so pairing is never manual.** All nine free
   sites (§1.2) already hold the header pointer; adding "read owner, route"
   is local. The programmer states an allocator at *allocation* only.
2. **The RC machinery is allocator-agnostic.** Dup/drop insertion, borrow-by-
   default parameters, the dup/drop pair optimizer
   (`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`), the cycle
   collectors, `Dispose` synthesis, atomic RC, `Iso` uniqueness — none of it
   looks below `__yo_malloc`. An explicit allocator only replaces the two
   calls at the bottom of `__yo_rc_alloc` and the routed `__yo_free`.
3. **The fallback keeps the default path byte-stable** (P1: literally; P2:
   one bit-test on the free path, re-baselined once and gated).
4. **The hazard unique to explicit allocators gets a defined-behavior
   answer.** "Allocator dies while blocks are live" is a *trap* (arena
   `deinit` emptiness check), not UB — consistent with the safe-mode tier-3
   trap family. Everything else (raw pointers, block bytes) stays behind
   the existing safe/unsafe boundary: *using* an `Allocator` is safe
   (already the position of `plans/reference/MEMORY_SAFETY.md` §Allocators);
   *implementing* one needs `pragma(Pragma.AllowUnsafe)`.

## 3. Design

Two layers, each independently shippable:

- **Layer 1 (std-only, zero compiler change):** containers take an
  `Allocator` parameter for their **buffers** (§3.2).
- **Layer 2 (codegen):** RC **objects** can be allocated from an explicit
  allocator with automatic free routing (§3.3–3.4).

### 3.1 The `Allocator` value type (P0)

Zig's `std.mem.Allocator` shape: a context pointer plus function pointers.

```rust
// std/allocator.yo — added beside the existing externs
Allocator :: struct(
  ctx : ?*void,
  alloc : (fn(ctx : ?*void, size : usize) -> ?*void),
  realloc : (fn(ctx : ?*void, ptr : ?*void, size : usize) -> ?*void),
  free : (fn(ctx : ?*void, ptr : ?*void) -> unit),
  aligned_alloc : (fn(ctx : ?*void, alignment : usize, size : usize) -> ?*void)
);

// The global allocator becomes an INSTANCE (name kept; today's static-call
// sites keep compiling through it):
GlobalAllocator :: ... // unchanged static surface, plus:
global :: Allocator(  // ctx .None; fns forward to __yo_malloc et al.
  ctx : Option(*void).None,
  alloc : ((ctx, size) -> __yo_malloc(size)),
  ...
);
```

Decisions baked in: `realloc` is **required** (every container grows; a
defaulting `malloc+memcpy+free` fallback invites silent O(n) growth) — this
answers the "shape a custom allocator would need" question in the module's
stability note. `aligned_alloc` is required because the two-family rule
(`std/allocator.yo:64-79`) makes alignment a property of the *pair*, and an
allocator that cannot honor alignment cannot back container buffers
portably. `Allocator` is a **value type** (copied, not RC'd): passing one is
eight words, and an allocator must not itself need an allocator. Per the D4
function-value rule, `Allocator` is `Send` exactly when its `ctx` witness
is; the global instance (`.None` ctx) is `Send`.

**Name collision, noted:** `std/build.yo:53` already has
`Allocator :: enum(Mimalloc, System, Fixed)` — the link-time *choice* of
global allocator. Both are legal (separate modules), and build files don't
import `std/allocator.yo`; the doc-level distinction is "build allocator =
which global one, runtime `Allocator` = a value you pass". If review finds
the collision confusing, the runtime type renames (`Mem.Allocator`) — open
decision D6.

P0 also ships the **second implementor** the stability note asks for:

- `std/arena.yo` — `Arena`, a bump allocator over one block from
  `GlobalAllocator.aligned_alloc` (one family, used consistently), with a
  live-block counter and an `atomic_flag` spinlock (§3.6).
- a counting/capturing allocator in `tests/` (asserts alloc/free balance and
  byte totals) — the test-side implementor that freezes the trait surface.

### 3.2 Layer 1 — containers take an allocator (P1, std-only)

```rust
arena := Arena.new(usize(4) * usize(1024) * usize(1024));
list := ArrayList(i32).new_in(arena.allocator());
list.push(i32(1));                          // buffer grows inside the arena
map := HashMap(str, i32).with_capacity_in(arena.allocator(), usize(16));

// Fallback: the existing constructors are unchanged and default to global
plain := ArrayList(i32).new();
```

- Each container gains a private `_alloc : Allocator` field and `_in`
  constructor variants (`new_in`, `with_capacity_in`; no overloading, so
  distinct names — the D2 naming discipline gets a new row, "allocator-
  parameterized constructor suffix `_in`"). The **dispose** impl frees the
  buffer through `self._alloc.free(...)` instead of `GlobalAllocator.free`
  — the one semantic change, and it is invisible when `_alloc == global`
  (same function pointer).
- The RC *object* (the ArrayList itself) still comes from the global
  allocator in P1 — Layer 2 is what makes the object placeable. This split
  is deliberate: buffers are the volume (millions of bytes), the object is
  one block; shipping buffer placement first delivers the arena use case
  with zero compiler risk.
- ZST anchors, `try_*` fallible variants and `AllocError` flow through
  unchanged — OOM inside an explicit allocator is `.None` → `try_push`
  returns `AllocError.OutOfMemory`; the infallible `push` still panics via
  the same path it uses today.

**std-stability ruling needed (open decision D4):** adding a private field
to a stable `ref(struct)` is invisible through the public surface (E0405
makes `_` fields unreachable outside siblings), but it *is* a layout change.
Recommendation: private fields are not contract; only exported surface is.
Record the verdict in this doc when P1 opens.

### 3.3 Layer 2 — RC objects from an explicit allocator (P2, codegen)

**Tag: the refcount high bit.** None of the three headers has a spare byte
(§1.3), but `ref_count : u32` counting live objects never approaches 2^31.
Steal its top bit as the **T-bit** ("tagged block"):

- Writers of ref_count (`__yo_incr_rc`, plain `++`-style updates) preserve
  the bit naturally — adding 1 to a word with the top bit set keeps it set.
- Readers that *test* the count must mask: the `ref_count == 1` death test
  in every decr variant, the `rc()` builtin lowering
  (`src/codegen/exprs/rc_fns.yo:401-427`, the `rc(self) == 1` COW checks in
  `std/imm/*`), and `__yo_iso_unique`. This is the full list of count
  readers; each is a one-line mask.
- Free routing: `__yo_free(ptr)` at the nine sites (§1.2) becomes
  `__yo_rc_free(ptr)`: if the T-bit is clear → today's `__yo_free`
  (unchanged fast path, one predictable branch); if set → the block carries
  a **16-byte prefix immediately before the header** (`{owner : *Allocator,
  magic : u32, reserved : u32}`; 16 bytes so the returned pointer keeps
  `max_align_t` alignment) → `owner->free(owner->ctx, prefix_block)`.
  16 B per *tagged* block only; the default path pays nothing.
- The prefix is written by the **explicit allocator's** `alloc` (it
  over-allocates by 16, stores itself, returns the shifted pointer) — the
  global allocator never writes prefixes, which is why untagged emission is
  unchanged.

**Atomic RC types opt out in P2.** `__yo_decr_rc_atomic`'s CAS loops would
have to carry the T-bit through every compare-exchange; instead, an explicit
allocator applied to an `atomic(ref(...))` type is a clear compile error
("atomic RC types stay on the global allocator for now"). `Arc`, `String`
and the imm nodes are overwhelmingly global-allocated anyway; revisit as a
follow-up if a measured need appears (open decision D5).

**Allocation plumbing — a scoped form, not new signatures.** Every RC
construction already funnels through `__yo_rc_alloc`; rather than threading
an allocator parameter through eight constructor signatures and their call
sites (§1.2), the scope carries it:

- New runtime TLS: `__yo_current_allocator` (`?*Allocator`), set/cleared by
  wrappers in `std/allocator.yo` (pragma'd module, per the D6 rule — never a
  bare alias).
- `__yo_rc_alloc` consults it: null → today's behavior; set →
  `alloc->alloc(ctx, size + 16)` + prefix write + T-bit set on
  `ref_count = 1 | T`. The `__asm__` tcache barrier (§1.1) is preserved in
  both arms.
- **Internal runtime allocations pin the global allocator.** The async
  runtimes, the parallelism runtime and the GC thread state use
  `__yo_rc_alloc` for *their own* blocks and free them with plain
  `__yo_free` (§1.2 #5-#7, plus the raw-C runtime text). If a future ran
  inside a user scope, those blocks would be arena-allocated but
  untagged-freed — so those sites switch to a `__yo_rc_alloc_global`
  variant (today's body) that ignores the TLS. User-visible futures/state
  machines (also #5) *do* follow the scope: a future that outlives its
  arena trips the deinit trap — loud, defined (§3.5).
- Non-RC `__yo_rc_alloc` users (`src/codegen/parallelism/runtime.yo:190`,
  `:364`, `:525` — allocated and freed with plain `__yo_free`) move to
  `__yo_rc_alloc_global` for the same reason.

**User surface:** `arena.scoped(f)` — make me current during `f`:

```rust
graph := arena.scoped((() => build_graph()));   // every RC allocation
                                                // *dynamically inside* f
                                                // comes from the arena:
                                                // ref ctors, box, dyn, futures
```

Semantics, stated loudly because it differs from Zig (where hidden
allocations do not exist): the scope captures **all** RC allocations
dynamically inside it — including temporaries, `dyn` wrappers and deferred
dups the compiler creates — not just the ones spelled in the source. That is
correct by routing (every such block frees back to the arena), usually
*desired* (the whole subsystem's garbage lands in the arena), and it is the
documented contract. Containers stay explicit-parameter (§3.2) so a
container's buffer is *provably* from one allocator for the container's
lifetime, independent of where a constructor happens to run.

**Infallibility is preserved:** the RC path stays allocate-or-abort
(`__yo_alloc_fail` with the owning allocator's stats in the message). A
program that must survive OOM keeps using the existing fallible surface
(`try_*`, direct `Allocator` calls returning `?*void`) — unchanged from
D9 (`plans/archive/STD_API_STABILIZATION.md`).

### 3.4 Arena semantics under RC (P3)

```rust
arena := Arena.new(bytes);
{
  list := ArrayList(i32).new_in(arena.allocator());
  result := arena.scoped((() => parse_into_graph(input)));
  use(result);
}                                          // last refs drop; blocks route back
arena.deinit();                            // traps if any block is still live
```

- `deinit()` — the emptiness trap. Live blocks → tier-3 trap
  `arena deinit: 3 blocks still live (arena.yo:…)`, then abort. Under
  `--debug-heap` the message lists per-allocator live counts. This is what
  makes "allocator outlives its blocks" a *checked* invariant instead of
  the use-after-free it is in Zig.
- `abandon()` — the escape hatch for process-lifetime arenas (startup
  tables, interners): release tracking, never free; the underlying block
  rejoins the global leak-oracle accounting at exit. The mirror of Zig's
  "arena that lives forever" idiom, but explicit.
- Individual drops before deinit: a *bump* arena's `free` is a no-op unless
  the block is the last one (delayed reclamation — fine under RC, since the
  arena is short-lived by design); a *general-purpose* explicit allocator
  (e.g. a second TLSF region, or a pool) frees for real. Both route by the
  same prefix.
- **Cycles**: arena-allocated objects participate in cycle GC exactly as
  today; the collectors' free sites are routed (§1.2), so a collected cycle
  in an arena frees correctly, and anything the collector cannot prove dead
  is caught by the deinit trap. No new cycle rules.
- An `Arena`'s own allocation always comes from the global allocator
  (simplest nesting story; nested arenas compose only through explicit
  backing, which can be a later addition).

### 3.5 Safe mode and CTFE

- Using `Allocator`/`Arena`/`.scoped` is safe; implementing an `Allocator`
  requires `pragma(Pragma.AllowUnsafe)` (raw memory) — the existing rule,
  unchanged (`plans/reference/MEMORY_SAFETY.md` §Allocators). The new trap
  kinds join tier 3. No raw pointer reaches user code: an `Allocator` value
  is a struct of fn pointers + `?*void` ctx — the ctx is opaque, and
  constructing a bogus one requires writing an implementor, which requires
  the pragma.
- **CTFE**: allocator-typed values in comptime evaluation are a compile
  error ("explicit allocators are runtime-only"). The evaluator's object
  model has no block placement, and pretending it does would let comptime
  code observe an allocator that does not exist.

### 3.6 Threading

- Routing is **process-global**: the owner lives in the block's prefix, so a
  block freed on any thread reaches the right allocator. Necessary anyway:
  an `Iso` graph can cross to a worker and die there.
- std's explicit allocators are **thread-safe by default** (C11
  `atomic_flag` spinlock) — same decision and same reasoning as the fixed
  allocator's §2.3 ("always guard; revisit only with a number"): correctness
  must not depend on which thread's drop fires last.
- The TLS scope is per-thread by construction: a `spawn` body on a worker
  does not inherit the spawning thread's scope (workers have empty TLS →
  global). Passing an allocator *into* a task is explicit — pass the
  `Allocator` value; D1/D4 audit it like any other captured value.

### 3.7 Chunked emission and per-TU duplication

`__yo_decr_rc` is emitted `static inline` per translation unit
(`gc_runtime.yo:528-535`, `:383-387`); the routing helper (`__yo_rc_free`)
and the tag checks must be header-inline too, so `--emit-chunks` builds
stay consistent. The `--emit-c` single-file output stays self-contained.

## 4. Phases

Each phase is one PR (or a short stack), gated by its acceptance test.
Nothing below starts until the release freeze lifts (match adoption waves
#997/#1000 are parked ahead of it in the same queue).

### P0 — `Allocator` value type + second implementor (std-only)

1. `Allocator` struct in `std/allocator.yo`; `global` instance;
   `std/arena.yo` (`Arena` with live-block counting, spinlock, `deinit`
   trap, `abandon`, `allocator()`, `scoped` stub that is global-only until
   P2); counting allocator under `tests/`.
2. Gates: `tests/allocator.test.yo` extended (arena alloc/free balance,
   counting allocator asserts); `yo test ./std`; ASan on the arena test;
   fixpoint untouched (no compiler change, no emitted-C change).

### P1 — containers take allocators (std-only)

1. `_alloc` field + `new_in`/`with_capacity_in` on `ArrayList`, `HashMap`,
   `HashSet` (via map), `Deque`, `StringBuilder` (via list), `std/imm/{vec,
   map,string}`; dispose frees through `self._alloc`.
2. Gates: `yo test ./std` + `yo test ./tests` (fast suite); emitted C for a
   program using only default constructors is **byte-identical** (corpus
   diff); leak oracle (`--allocator fixed --debug-heap`) clean on the new
   tests; the std-stability ruling (D4) recorded here.

### P2 — RC object routing (codegen)

1. T-bit + prefix; `__yo_rc_free` routing at the nine free sites; count
   readers masked (`rc()`, iso-unique, decr tests); `__yo_current_allocator`
   TLS + TLS consult in `__yo_rc_alloc`; `__yo_rc_alloc_global` split for
   internal runtime/GC/parallelism sites (asm barrier preserved in both);
   `atomic(ref(...))` + explicit allocator → clear error; `Arena.scoped`
   goes live.
2. Gates: `yo check ./src`; `yo compile src/main.yo --skip-c-compiler`;
   fixpoint re-baseline (deliberate, one PR — the decr path changes in every
   program) + determinism green; new `tests/explicit_allocators.test.yo`
   (scoped ref/enum/Box/Dyn construction, cross-thread Iso drop into an
   arena, cycle collected inside an arena, deinit trap fires, `abandon`
   path); `tests/rc.test.yo`, `tests/dyn.test.yo` unchanged-green; ASan on
   the arena tests; self-compile RSS/time within noise of develop (the
   canary: the compiler's own 11-20 GB build, measured before/after).

### P3 — semantics hardening

1. Deinit trap message with per-allocator stats under `--debug-heap`;
   Send/parallelism audit (D1-D9) of allocator values crossing into spawn
   bodies; decide future-in-arena support (default: allowed, deinit trap is
   the backstop); `yo context`/skills/cheatsheet entries.
2. Gates: hollow sweep (`scripts/bootstrap/hollow_sweep69.sh`) ratchet;
   parallelism suite; the LSan/fixed-allocator leak oracles.

### P4 — docs and stability freeze

1. `docs/en-US/MEMORY_SAFETY.md` + `DESIGN.md` and `zh-CN` twins (allocator
   = placement, RC = lifetime, the deinit rule, `abandon`); yo-design
   instructions row; `std/allocator.yo` stability note resolved (second
   implementor shipped, trait frozen per its own criterion).
2. Gates: docs build both languages; release-notes curation.

## 5. Risks

| risk | shape | mitigation |
| --- | --- | --- |
| Blast radius of the T-bit | P2 touches the decr path of **every** compiled program | default fast path is one masked compare + one branch; self-compile A/B (time + RSS); fixpoint re-baseline is a single reviewable PR; canary tests in `tests/rc.test.yo` |
| Scoped form surprises | hidden allocations (dyn wrappers, temporaries, futures) land in the arena | documented as the contract (§3.3); routing makes it *correct*, docs make it *expected* |
| Header/word invariants | the packed word is perf-tuned; masks must not leak into hot incr paths | incr/decr writers preserve the bit arithmetically (no mask on write); count *readers* audited by grep (`ref_count` in `src/codegen/`) |
| std stability | private field addition to stable ref structs | D4 ruling recorded before P1; `_in` constructors are additive |
| fixpoint / goldens | any emitted-C change re-baselines | P1 is byte-identical by construction; P2 is the only re-baseline, gated |
| `build.Allocator` name collision | two `Allocator`s in the tree | different modules, qualified use; rename escape hatch (D6) |
| Self-build perf regression | TLS read per RC allocation | one null-check of a TLS word per alloc vs a malloc — noise; measured on the self-compile canary |

## 6. Open decisions

| # | decision | recommendation |
| --- | --- | --- |
| D1 | tag mechanism | refcount T-bit + 16 B prefix on tagged blocks (zero default-path cost); alternative "always-prefix for every block" rejected — it taxes every object in every program, including the compiler's own multi-GB self-build |
| D2 | language surface for RC construction | scoped `arena.scoped(f)` over TLS (zero constructor-signature churn, covers `Dyn`/futures); per-call sugar (`box_in(alloc, v)`) only if use demands it |
| D3 | thread-safety of explicit allocators | spinlock always (mirror of `FIXED_REGION_ALLOCATOR.md` §2.3) |
| D4 | std stability: private fields | private fields are not contract; adding `_alloc` is additive in practice — record the ruling in the stability policy |
| D5 | atomic RC from explicit allocators | rejected for P2 (clear error); revisit with a measured need |
| D6 | `Allocator` name collision with `std/build.yo` | keep both names; rename the runtime type to `Mem.Allocator` only if review finds real confusion |
| D7 | allocator-aware `Dispose` | not introduced — dispose stays allocator-blind; the buffer free routes through the stored `_alloc`, the object free routes through the prefix |
| D8 | nested arenas (arena backed by arena) | out of scope; explicit backing-allocator parameter on `Arena.new` as a later addition |

## 7. References

- `std/allocator.yo` — the trait surface whose freeze this plan completes;
  its stability note is this plan's opening question.
- `plans/reference/FIXED_REGION_ALLOCATOR.md` — the global allocator layer
  this builds on (TLSF, OOM policy, the leak oracle, `--debug-heap`).
- `plans/reference/MEMORY_SAFETY.md` — the safe/unsafe boundary the
  Allocator trait sits on (§Allocators).
- `plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md`,
  `plans/reference/REF_REFERENCE_SEMANTICS.md`,
  `plans/reference/ARC_TYPE.md` — the RC model that stays untouched.
- `src/codegen/c/collection.yo:500-512` (`__yo_rc_alloc`),
  `src/codegen/functions/gc_runtime.yo` (the nine free sites),
  `src/codegen/types/generation.yo:980-1047` (the three headers) — the
  codegen anchors of §3.3.
- `plans/archive/STD_API_STABILIZATION.md` — D9 (`push`/`try_push`): the
  fallible surface explicit allocators must preserve.
- Zig `std.mem.Allocator` / `std.heap.ArenaAllocator` — the ergonomics being
  borrowed, and (via the deinit trap) the bug class being declined.
