# Explicit allocators (Zig-style) beside reference counting

> **Status: ACTIVE — implementation started 2026-09-29 (stacked PRs on
> #1015; P0 and P1 implemented).** Design audited 2026-09-29 (two passes). Verdict:
> **feasible**. An explicit allocator in Yo selects *where* a block lives;
> reference counting keeps *whether and when* it dies. Every allocation
> falls back to the global allocator when no
> explicit allocator is named, so `ref(struct(...))`, `ref(enum(...))`,
> `Box`, `Dyn`, `Arc`, `String`, closures and all of std behave exactly as
> today unless a program asks otherwise. This document answers the open
> question in `std/allocator.yo`'s stability note ("a decision on whether
> containers take an allocator parameter the way Zig's and Rust's do …
> freezing needs a second implementor — an arena or a counting allocator").
> It is the per-object layer **on top of** — not a replacement for — the
> compile-time global allocator choice of
> [`FIXED_REGION_ALLOCATOR.md`](reference/FIXED_REGION_ALLOCATOR.md) §0
> (which scoped itself to "Yo keeps one global allocator" and recorded the
> Zig-style parameter as out of that plan's scope).
>
> The second audit pass corrected seven load-bearing claims of the first
> draft (inventory counts, the tag write site, the reader list, the atomic
> path, the container layout cost, unwind safety, async scoping). They are
> listed in §8 so a reader of the PR history can see what moved and why.

## 0. Verdict

**Yes, the two compose**, because of where each mechanism sits:

| concern | owner | mechanism |
| --- | --- | --- |
| which pool a block comes from | explicit `Allocator` (opt-in) | allocation-site parameter (containers) or dynamic scope (RC objects) |
| when it is released | reference counting (always) | compiler-inserted dup/drop, refcount-0 dispose, cycle GC |
| released **back to the right pool** | automatic | the block records its owner in a 16-byte prefix; every free site routes on it |

That third row is the whole trick. In Zig the programmer must pair every
`free` with the allocator the block came from, and the largest allocator bug
class (wrong-allocator free, use-after-arena-deinit) exists because the
pairing is manual. In Yo, frees are compiler-inserted at a small, closed set
of points (§1.3) that already hold the block's header. If the block records
its owner, routing frees back is mechanical, and the Zig bug class is
impossible by construction rather than by discipline.

**Rule 1 (fallback).** Absent an explicit allocator, every allocation uses
the global allocator. Absence is never an error and never a behavior change.

**Rule 2 (inverted default).** The runtime's own allocations — async I/O
futures, continuations, waker tokens, parallelism task records, GC state —
are *never* placeable. Only the six user-visible constructor emission sites
(§1.2) consult the scope. This is the opposite polarity from the first
draft, and it is what makes the design safe by omission: a runtime site
nobody touched cannot be mis-routed, because it never looked.

**What does NOT carry over from Zig.** Zig's allocator parameter is also a
*lifetime* statement: `arena.deinit()` frees everything instantly and nobody
tracks liveness. Under RC, a block lives exactly as long as its refcount (and
the cycle collector) says — an arena cannot bulk-free what RC still counts.
Yo therefore gets the *placement* benefits (locality, a second TLSF region,
scoped scratch space, per-subsystem budgets, test/counting allocators) and
pays for them with one rule: **arena `deinit` verifies emptiness** — live
blocks at deinit are a tier-3 trap (`plans/SAFE_MODE.md`: defined behavior,
`file:line:col`, identical at every `-O`), and a process-lifetime arena
uses the explicit `abandon()` escape hatch instead. Bulk-free-without-check
is the one Zig capability declined, deliberately: it cannot be made sound
under dynamic refcounts without a proof RC does not have.

### 0.1 What to expect on performance (and what not to)

An arena under RC changes **where** bytes come from, not **how much RC
work runs**. Every dup/drop the compiler inserts still executes, every
`dispose_fn` still runs, every free still walks to the block — it just
ends in a counter decrement instead of `mi_free`. The only measured
self-compile profile on record (`plans/archive/PERCEUS_REUSE.md` §0,
release v0.2.38, 40 s `sample`, 29,987 busy samples):

| share | what | reachable by an arena? |
| ---: | --- | --- |
| 15.2 % | malloc/free family | partially: the alloc side becomes a bump; the free side keeps dispose + routing |
| 20.5 % | `__yo_decr_rc` | no |
| 24.4 % | `_tlv_get_addr` (TLS reads under the tracked decr tail) | no — and §3.4 adds one guarded TLS read per user-visible allocation |
| 2.1 % | memset | no (constructors still zero the block) |

So the ceiling for a program that puts *everything* in arenas is a single-
digit percentage of wall, and the realistic case is smaller: mimalloc's
fast path is already a thread-local free-list pop, a bump arena never
reuses a freed block until `deinit` (churn-heavy code grows without bound),
and each tagged block carries a 16-byte prefix. The compiler itself is the
worst customer: its AST, types and `ExprInfo` live for the whole run and
cross every subsystem, which is exactly the working set an arena cannot
release early.

What the design *does* buy, and why it is still worth having:

- **Bounded, short-lived subsystems** (parse one file, build a graph, answer
  one LSP request, run one test): contiguous placement, frees that are a
  decrement, one region returned at `deinit`. Locality on graph walks is
  the measurable part.
- **Budgets and embedded targets**: a second region with its own OOM
  boundary (`FIXED_REGION_ALLOCATOR.md` §6), per-subsystem accounting under
  `--debug-heap`.
- **Test and counting allocators**: the second implementor the stability
  note needs, and leak/allocation-count assertions per test.

The Zig-level win — skip every individual free and drop the region — is
the one thing RC cannot give without a proof that no reference crosses the
arena boundary in either direction. That proof is escape analysis or a
verifier obligation, out of scope here (the position of
`plans/backlog/DEPENDENT_TYPES_POSITION.md`: runtime properties go through
the verifier). If self-compile speed is the goal, the levers on record are
the two rows above that an arena cannot reach.

**Go/no-go gate (P0, before any codegen work).** P0 is std-only and ships
the bump arena, so measure before P2/P3 the way `PERCEUS_REUSE.md` §0 did:
the `scratch/bench` churn programs with their container buffers in an
arena (Layer 1), plus one graph-shaped benchmark, against develop. Proceed
to Layer 2 only if the buffers-only number shows the locality/alloc win is
real (≥ 5 % of wall on a churn program, the Perceus threshold); otherwise
Layer 2 stays a placement/budget feature and its phases are justified by
§0's other rows, not by speed.

## 1. What exists today (measured 2026-09-29)

### 1.1 One allocator, chosen at compile time

Every allocation in a compiled program flows through one function family,
selected at compile time by `--allocator mimalloc|system|fixed`
(`src/codegen/c/collection.yo:173-236`; the fixed arm's TLSF lives in
`src/codegen/c/allocator_fixed.yo`). `__yo_malloc`, `__yo_realloc`,
`__yo_free`, `__yo_aligned_alloc`, `__yo_aligned_free` are **`#define`s**
over `mi_*` / libc / `_aligned_*` — there is no function to hook, which is
why routing needs a new inline helper rather than a redefinition. Above
them, one helper is the entry point for RC blocks:

- `__yo_rc_alloc(size)` — `src/codegen/c/collection.yo:500-512`:
  `__yo_malloc` + `__yo_alloc_fail` (OOM abort) + the
  `__asm__ volatile("" : "+r"(p))` barrier that keeps clang from fusing
  malloc+memset into a tcache-bypassing calloc
  (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.4). Any variant must keep
  the barrier.
- std reaches the same family through `GlobalAllocator`
  (`std/allocator.yo`, an `impl({...})` of the `__yo_*` externs).

### 1.2 `__yo_rc_alloc` has 133 callers; six construct user-visible objects

| class | sites | freed by |
| --- | ---: | --- |
| **User-visible RC constructors** — `ref(struct(...))` ctor (also `atomic(ref(struct))`, `Box`/`Arc` = one-field ref structs, `JoinHandle`) `src/codegen/functions/constructors.yo:182`; `ref(enum(...))` variant ctors `constructors.yo:670`; `Dyn(Trait)` boxes `src/codegen/functions/dyn.yo:142`; `Iso(T)` create `src/codegen/types/generation.yo:1667`; async-block / `io.async` state machines `src/codegen/exprs/async.yo:1428`, `:3067` | **6** | `__yo_decr_rc*` → `dispose_fn` → free (§1.3) |
| Async runtime internals — continuations, I/O futures, waker tokens, yield nodes (`src/codegen/async/runtime_core.yo:299,722,742,991,998`; `runtime_io_common.yo` ×21, `runtime_io_linux.yo` ×23, `runtime_io_macos.yo` ×26, `runtime_io_windows.yo` ×43, `runtime_io_wasm.yo` ×3) | ~121 | plain `__yo_free`, or decr on a runtime-owned header |
| Parallelism runtime — thread-entry args, worker table, task records (`src/codegen/parallelism/runtime.yo:190,364,525`) and the spawn closure-capture copy (`src/codegen/exprs/parallelism.yo:330`) | 4 | plain `__yo_free` |
| GC per-thread state (`src/codegen/functions/gc_runtime.yo:762`) | 1 | plain `__yo_free` at thread exit |

The first draft counted "eight constructs" and proposed that `__yo_rc_alloc`
itself consult the scope with the internal sites opting out. With ~126
internal sites — freed with an *untagged* `__yo_free` — one missed opt-out
inside a user scope would hand an arena block to `mi_free`. Rule 2 inverts
this: `__yo_rc_alloc` keeps today's body verbatim and a **new**
`__yo_rc_alloc_scoped` is called from the six constructor sites only.

**Constructors initialize the header AFTER allocation.** Every one of the
six sites writes `obj->header.ref_count = 1` (and, under cycle GC,
`gc_flags = 0`, `gc_mark`, list pointers) after the `__yo_rc_alloc` call
(`constructors.yo:187`, `:671`, `dyn.yo:143`, `generation.yo:1668`,
`async.yo:1433`, `:3069`); the two async sites `memset` the whole block
first. A tag written inside the allocation helper would be overwritten, so
the tag is written **by the constructor emission**, after its header init
(§3.4).

Template strings, `String`, `StringBuilder`, `Regex`, `std/hash` allocate no
other way: they bottom out in the ref-struct ctor (String is a newtype over
`Option(ArrayList(u8))`, `std/string/string.yo:86-88`) or in container
buffers (§1.6). Capturing closures do **not** allocate (stack capture
struct, `src/codegen/exprs/closures.yo:160-268`); a closure becomes heap
state only when boxed (`box`/`arc` → ref-struct ctor, or `Dyn(Fn)` → dyn
box).

### 1.3 Eight RC free sites, all in `gc_runtime.yo`

When a refcount hits zero the runtime calls `dispose_fn` (or
`__yo_dispose_dispatch`) and then `__yo_free(ptr)` at exactly:

| site | function |
| --- | --- |
| `gc_runtime.yo:400` | `__yo_decr_rc`, lightweight header |
| `:441` | `__yo_decr_rc_atomic`, lightweight header |
| `:556` | `__yo_decr_rc`, full/small header fast path (untracked) |
| `:609` | `__yo_decr_rc_tracked` (out-of-line tail) |
| `:650` | `__yo_decr_rc_atomic`, full/small header |
| `:1041` | `__yo_gc_collect_incremental` (Bacon-Rajan white set) |
| `:1117` | `__yo_gc_collect` (full trial deletion) |
| `:1172` | `__yo_cleanup_thread_gc` pass 2 (thread exit) |

The other three `__yo_free` calls in the file are not RC objects: `:269` and
`:302` free unwind-value copies in the task-abort registry, `:1189` frees the
per-thread GC state. The collectors and the thread-exit sweep free through
the **same** dispose → free sequence as a normal drop, so routing these eight
sites routes everything. **No header records an owner today** — there is
one allocator per process, so none was needed.

### 1.4 The RC headers, and every reader of the count

Three layouts, selected per type by `compute_needs_cycle_gc`
(`src/codegen/codegen_c.yo:192-215`), emitted in
`src/codegen/types/generation.yo`:

| layout | size | fields | used by |
| --- | ---: | --- | --- |
| full | 56 B | packed word (`ref_count : u32`, `gc_flags : u8`, `gc_mark : u8`, `borrow_count : u16`), `dispose_fn`, `traverse_fn`, gc/roots list links (`:980-1001`) | cycle-GC-capable ref types |
| small | 16 B | packed word + `dispose_fn` (`:1014-1021`); a strict prefix of full | cycle-incapable ref types |
| lightweight | 8 B | `ref_count : u32`, `type_id : u16`, `borrow_count : u16` (`:1043-1047`) | no-cycle-GC builds |

`gc_flags` uses two bits (`__YO_GC_TRACKED 0x01`, `__YO_GC_BUFFERED 0x02`,
`generation.yo:588-589`); the lightweight header has no flags byte at all.
That asymmetry is why the tag goes in the **high bit of `ref_count`** on all
three layouts (§3.4) rather than in `gc_flags`: one mechanism, one mask.

`ref_count` is 32 bits and never approaches 2^31 live references. The
**complete** list of places that *test* the count (all must mask):

| reader | file | test |
| --- | --- | --- |
| `__yo_decr_rc` (lightweight; full/small fast path) | `gc_runtime.yo:396`, `:551` | `ref_count == 1` |
| `__yo_decr_rc_tracked` | `:598` | `ref_count == 1` |
| `__yo_decr_rc_atomic` (both layouts) | `:437`, `:644` | `old_count == 1` on the `atomic_fetch_sub` result |
| `__yo_gc_mark_gray_visitor` | `:937` | `ref_count > 0` before trial decrement |
| `__yo_gc_scan` | `:974` | `ref_count > 0` (live vs garbage) |
| `__yo_gc_trial_delete_visitor` | `:1065` | `ref_count > 0` |
| `__yo_gc_collect` classification | `:1098` | `ref_count == 0` |
| `__yo_iso_uq_visit` (Iso uniqueness walk) | `constructors.yo:783` | `ref_count != 1` |
| `rc()` builtin lowering (`generate_rc_call`) | `src/codegen/exprs/rc_fns.yo:401-430` | returned to user code; the `rc(self) == 1` copy-on-write checks in `std/imm/*` (9 sites) read it |
| `GC_DEBUG` traces | throughout | cosmetic |

The first draft listed only the decr tests, `rc()` and the Iso walk. The
four collector readers are the important omission: with an unmasked
`ref_count > 0`, a tagged object could never be classified garbage and
**cycles inside an arena would never be collected**. Writers
(`ref_count++`, `ref_count--`, `atomic_fetch_add/sub`) preserve a high bit
arithmetically as long as the count never crosses zero, which the death
tests guarantee.

**The atomic path is `atomic_fetch_sub`, not a CAS loop** (`:437`, `:644`).
Supporting the tag there is masking the returned old count — one line per
site. The first draft's "atomic RC types opt out" rested on a CAS-loop
premise the code does not have, and (§3.5) the scoped form could not have
produced its promised compile error anyway, because whether an
`atomic(ref(...))` ctor runs inside a scope is a runtime fact.

### 1.5 The async continuation trampoline and flag-propagated `unwind`

- A suspended task is a `__yo_continuation_t { resume_fn, state_machine,
  next }` (`src/codegen/async/runtime_core.yo:27-31`), created at one site
  (`__yo_async_enqueue_continuation`, `:292`) and run at one site
  (`__yo_async_run_task`, `:355-359`: `cont->resume_fn(cont->state_machine)`
  followed by the `__yo_handoff_fn` hop loop). Any "scope follows the task"
  rule (§3.5) is therefore two edits, not a runtime rewrite.
- `unwind` is **not** `longjmp`: it sets the thread-local
  `__yo_unwind_target` (`gc_runtime.yo:230`, `src/codegen/exprs/return.yo:1375`)
  and every frame on the way out returns early after checking it. Consequence
  for this plan: a scope wrapper written in plain Yo as
  `prev := set(a); r := f(); set(prev); r` skips its restore when `f`
  unwinds through it — the early return leaves `set(prev)` unexecuted and the
  thread's current allocator dangling on a dead arena. The scope must be
  lowered by codegen so the restore is emitted *before* the unwind check
  (§3.5).

### 1.6 std containers hold no allocator state — and cannot afford a word

`ArrayList(T) :: ref(struct(_ptr, _length, _capacity))`
(`std/collections/array_list.yo:36-44`) reaches the allocator through
destructured `GlobalAllocator` names — `malloc`/`realloc` on growth
(`:231-238`, `:764-771`), shrink (`:353`, `:367-370`), `free` inside the
`Dispose` impl (`:885-896`). Same shape in `hash_map.yo` (7 sites, two
buffers), `deque.yo` (3), `std/imm/{vec,map,string}` (~10); `HashSet`,
`BTreeMap`, `LinkedList`, `StringBuilder`, `imm/{list,set,sorted_*}`
allocate only through these. No std API takes an allocator parameter; no
`Arena`, bump or pool allocator type exists anywhere in the tree.

**The layout is size-tuned and the number is on record.** The packed RC
header's own comment (`generation.yo:981-984`): "ArrayList 88 -> 80 crosses
the 96 -> 80 malloc class (~0.4 GB at self-compile scale)". Adding an
`_alloc : Allocator` field (the first draft: ctx + four fn pointers, 40 B)
or even an 8-byte pointer moves `ArrayList` — and therefore every `String`
in the compiler — back across that class boundary. §3.3 stores the
allocator in the *buffer's* prefix and keeps one bit in the container.

### 1.7 Docs promise nothing

`docs/en-US/MEMORY_SAFETY.md` and `docs/zh-CN/MEMORY_SAFETY.md` describe RC +
gated unsafe and mention "writing a custom allocator" only as an
unsafe-mode activity; `DESIGN.md` (en+zh) presents reference counting as
"Yo's universal object model". Allocator parameterization appears nowhere —
the feature is docs-additive, not docs-breaking.

## 2. Why this composes with RC (the compatibility argument)

1. **Frees are never manual, so pairing is never manual.** All eight free
   sites (§1.3) already hold the header pointer; adding "read tag, route" is
   local. The programmer states an allocator at *allocation* only.
2. **The RC machinery is allocator-agnostic.** Dup/drop insertion,
   borrow-by-default parameters, the dup/drop pair optimizer
   (`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`), the cycle
   collectors, `Dispose` synthesis, atomic RC, `Iso` uniqueness — none of it
   looks below `__yo_rc_alloc`. An explicit allocator changes the six
   constructor sites and the eight free sites.
3. **The fallback keeps the default path stable**: containers keep their
   layout (§3.3), the runtime's ~126 internal allocations are untouched
   (Rule 2), and the default free path gains one masked compare.
4. **The hazard unique to explicit allocators gets a defined-behavior
   answer.** "Allocator dies while blocks are live" is a *trap* (arena
   `deinit` emptiness check), not UB. Everything else (raw pointers, block
   bytes) stays behind the existing safe/unsafe boundary: *using* an
   `Allocator` through `_in` constructors and scopes is safe (the position of
   `plans/reference/MEMORY_SAFETY.md` §Allocators); *implementing* one, or
   calling its raw `alloc`/`free`, needs `pragma(Pragma.AllowUnsafe)`.

## 3. Design

Two layers, each independently shippable, sharing one **owner prefix**:

- **Layer 1 (std-only):** containers take an `Allocator` for their
  **buffers** (§3.3).
- **Layer 2 (codegen):** RC **objects** can be allocated from an explicit
  allocator with automatic free routing (§3.4–3.5).

### 3.1 The `Allocator` value type (P0)

Zig's `std.mem.Allocator` shape — a context pointer plus a pointer to an
immortal vtable — chosen over "ctx + inline fn pointers" because the *same
two words* are what the block prefix (§3.2) stores, and a prefix must never
point at a stack copy of a value type.

```rust
// std/allocator.yo — added beside the existing externs
AllocatorVTable :: struct(
  alloc : (fn(ctx : ?*void, size : usize) -> ?*void),
  realloc : (fn(ctx : ?*void, ptr : ?*void, new_size : usize) -> ?*void),
  free : (fn(ctx : ?*void, ptr : ?*void) -> unit)
);
Allocator :: struct(
  ctx : ?*void,
  vtable : *(AllocatorVTable)
);
impl(Allocator, Send());   // the audited base (§3.8)

// Public methods (the ONLY way user code touches an allocator):
//   Allocator.alloc(self, size) -> ?*void        writes the prefix (§3.2)
//   Allocator.realloc(self, ptr, new_size) -> ?*void
//   Allocator.free(self, ptr)                    the raw, non-routed release
//   Allocator.free_routed(ptr)                   static: reads the prefix
// and `global :: Allocator` whose vtable forwards to __yo_malloc et al.
```

Decisions baked in:

- **`realloc` is required** (every container grows; a defaulting
  `malloc+memcpy+free` fallback invites silent O(n) growth). This answers the
  stability note's "is `realloc` required or defaulted?".
- **No `aligned_alloc` in the vtable** (the first draft required it). The
  two-family rule (`std/allocator.yo:64-79`) makes alignment a property of
  the *pair*, and a vtable with one `free` cannot honor an aligned family on
  Windows. Nothing in std needs it: every container buffer and every RC
  block is allocated with the plain family today, so the contract is "blocks
  are `max_align_t`-aligned", exactly as now. Over-aligned buffers stay out
  of scope (D10).
- **No size at `free`.** A general-purpose allocator (TLSF, malloc) knows
  its sizes; an arena does not need one; a counting allocator keeps its own.
  Requiring the size would force every routed free site (§1.3) to know
  `sizeof` the object, which the generic decr does not.
- `Allocator` is a **value type** (two words, copied, not RC'd): an
  allocator must not itself need an allocator. `ctx` is opaque; the vtable
  pointer is immortal (D9).
- `global` is a module-level `::` value: a struct of two words evaluated at
  compile time, which is fine — only *calling* through it is runtime-only
  (§3.7).

**Name collision, noted:** `std/build.yo:53` already has
`Allocator :: enum(Mimalloc, System, Fixed)` — the link-time *choice* of
global allocator. Both are legal (separate modules), and build files don't
import `std/allocator.yo`; the doc-level distinction is "build allocator =
which global one, runtime `Allocator` = a value you pass". Rename escape
hatch: D6.

P0 also ships the **second implementor** the stability note asks for:

- `std/arena.yo` — `Arena`, a bump allocator over one region from
  `GlobalAllocator.aligned_alloc` (released with `aligned_free`, one family
  used consistently), with a live-block counter, a spinlock (§3.8), and
  `deinit`/`abandon` (§3.6).
- a counting allocator in `tests/` (asserts alloc/free balance and byte
  totals) — the test-side implementor that freezes the vtable surface.

### 3.2 The owner prefix (shared by both layers)

Every block handed out through `Allocator.alloc` carries, **immediately
before the returned pointer**, a 16-byte prefix:

```c
typedef struct { void* ctx; const void* vtable; } __yo_alloc_prefix_t;  // 16 B keeps max_align_t
```

- `Allocator.alloc(self, size)` = `vtable.alloc(ctx, size + 16)`, write
  `{ctx, vtable}`, return `raw + 16`. `Allocator.realloc` re-writes the
  prefix on the new block. Implementors never see the prefix: they hand out
  raw blocks, and the generic wrapper in `std/allocator.yo` owns the layout.
- `Allocator.free_routed(ptr)` (static) = `pre = ptr - 16;
  pre->vtable->free(pre->ctx, pre)`. Codegen's `__yo_rc_free` (§3.4) does the
  same in C.
- The layout is a **std ↔ codegen ABI**, like `__yo_ref_header_t`: emitted
  once in the C header as `__yo_alloc_prefix_t`, mirrored in std as a private
  struct, and pinned by a test that asserts `sizeof` = 16 and the field
  offsets (P0 for std, P3 for the codegen twin).
- The global allocator **never** writes prefixes. A block from `global`
  is a plain `__yo_malloc` block, which is why nothing on the default path
  changes and why every holder needs exactly one bit to say "prefixed".

### 3.3 Layer 1 — containers take an allocator (P1, std-only)

```rust
arena := Arena.new(usize(4) * usize(1024) * usize(1024));
list := ArrayList(i32).new_in(arena.allocator());
list.push(i32(1));                          // buffer grows inside the arena
map := HashMap(str, i32).with_capacity_in(arena.allocator(), usize(16));

// Fallback: the existing constructors are unchanged and default to global
plain := ArrayList(i32).new();
```

- **No new field.** The holder's bit lives in the **high bit of the capacity
  word** (`_capacity` for `ArrayList`/`Deque`, the bucket-capacity word for
  `HashMap`, `_cap` for the `imm` nodes): set ⇒ "this buffer came from an
  explicit allocator; its owner is in the prefix". Element access never
  reads capacity. The readers that do — the grow check in `push`/
  `ensure_total_capacity`, `capacity()`, shrink, dispose — mask with a
  private `_CAP_MASK`; growth and dispose route on the bit:
  `Allocator.realloc`/`free_routed` when set, today's `realloc`/`free` when
  clear. One AND on the push fast path; `sizeof` of every container
  unchanged.
- Each container gains `_in` constructor variants (`new_in`,
  `with_capacity_in`; no overloading, so distinct names — the D2 naming
  discipline gets a new row, "allocator-parameterized constructor suffix
  `_in`"). The `_in` constructor allocates the first buffer through the
  allocator and sets the bit; a container that has never allocated (`.None`
  buffer) stores the allocator nowhere — so `new_in` **must** allocate its
  first buffer eagerly (capacity 4 today) to remember the owner. Document
  this as the one observable difference from `new()`.
- The RC *object* (the ArrayList itself) still comes from the global
  allocator in P1 — Layer 2 makes the object placeable. Buffers are the
  volume; the object is one block.
- ZST anchors, `try_*` fallible variants and `AllocError` flow through
  unchanged — OOM inside an explicit allocator is `.None` → `try_push`
  returns `AllocError.OutOfMemory`; the infallible `push` still panics via
  the path it uses today.
- **Stability ruling (D4):** no public-surface change, no layout change,
  one private bit inside an existing word. Record the verdict in this doc
  when P1 opens.

### 3.4 Layer 2 — RC objects from an explicit allocator (P2 + P3, codegen)

**The tag: the high bit of `ref_count`, on all three headers.**

```c
#define __YO_RC_TAG    0x80000000u   // block has an owner prefix
#define __YO_RC_COUNT  0x7fffffffu
```

- Writers (`++`, `--`, `atomic_fetch_add/sub`) preserve the bit
  arithmetically. Every reader in §1.4 masks: `(h->ref_count &
  __YO_RC_COUNT) == 1` in the five decr tests, `> 0` / `== 0` in the four
  collector sites, `!= 1` in the Iso walk, `& __YO_RC_COUNT` in
  `generate_rc_call` (both the plain and the `atomic_load_explicit` arms).
  The grep `ref_count` over `src/codegen/` is the audit; §1.4 is its
  expected result.
- **`__yo_rc_free(ptr)`** replaces `__yo_free(ptr)` at the eight sites:
  tag clear → `__yo_free` (today's macro; one predictable branch); tag set →
  `pre = (__yo_alloc_prefix_t*)ptr - 1; pre->vtable->free(pre->ctx, pre)`.
  It reads only the header word the death test just loaded, no TLS.
- **Atomic types are supported** (D5): `__yo_decr_rc_atomic` masks the
  `atomic_fetch_sub` result. `Arc`, `Iso`, `AtomicBool` and friends place
  like everything else.

**The tag write belongs to the six constructor sites** (§1.2). Each emits:

```c
__yo_alloc_scope_t __scope = __yo_scope_current();          // {ctx, vtable} or {0, 0}
T* obj = (T*)__yo_rc_alloc_scoped(__scope, sizeof(T));      // global body when vtable == 0
/* header init exactly as today, then: */
obj->header.ref_count = 1u | __yo_rc_tag_of(__scope);       // 0 or __YO_RC_TAG
```

`__yo_rc_alloc_scoped` with an empty scope is `__yo_rc_alloc`'s body
(barrier included); with a scope it is `vtable->alloc(ctx, size + 16)` +
`__yo_alloc_fail` on NULL + prefix write + `raw + 16` + the same barrier.
`__yo_rc_alloc` itself is untouched, and the ~126 runtime-internal callers
never change (Rule 2).

**`__yo_scope_current()` and the cost of asking.** The scope is a
thread-local `__yo_alloc_scope_t __yo_current_allocator`. On Darwin every
`_Thread_local` read is a `_tlv_get_addr` call (the decr fast path was
restructured to avoid exactly that, `gc_runtime.yo:540-548`), so the read is
guarded by a plain process-global `__yo_scopes_ever_entered` flag set by the
first scope entry: a program that never enters a scope pays one non-TLS
load per user-visible allocation, and the self-compile canary (P2/P3 gates)
measures it.

**Infallibility is preserved:** the RC path stays allocate-or-abort
(`__yo_alloc_fail` with the owning allocator named in the message). A
program that must survive OOM keeps using the existing fallible surface
(`try_*`, direct `Allocator` calls returning `?*void`) — unchanged from
D9 (`plans/archive/STD_API_STABILIZATION.md`).

### 3.5 The scoped form: `with_allocator`, and the scope follows the task

**User surface: one std function, `with_allocator(alloc, f)`**
(`std/allocator.yo`) — "evaluate `f()` with `alloc` as the thread's current
allocator" — plus `arena.scoped(f)`, its one-line `Arena` spelling.

```rust
Point :: ref(struct(x : i32, y : i32));

p := with_allocator(arena.allocator(), () => Point(x : i32(3), y : i32(4)));
graph := arena.scoped(() => build_graph(input));
     // every user-visible RC allocation while the closure runs — ref ctors,
     // box/arc, dyn, Iso, futures, the objects std creates on your behalf —
     // comes from the arena

// The `_in` convention for a type's own constructor is the user's one-liner,
// the same shape std's containers use:
Point.new_in :: (fn(a : Allocator, x : i32, y : i32) -> Point)(with_allocator(a, () => Point(x : x, y : y)));
```

**Implemented as a function with a closure, not the lazy-expression builtin
D2 first proposed (changed 2026-09-29, P3).** The builtin existed for one
reason: a plain `prev := set(a); r := f(); set(prev)` skips its restore when
`f` unwinds (§1.5). An RAII guard removes that reason — `with_allocator`
holds a `_ScopeGuard` whose `Dispose` restores the saved scope, and drops run
on every exit, a normal return and an `unwind` alike: the `Mutex.with_lock`
pattern (`std/sync/mutex.yo`'s `__MutexUnlocker`). With the guard, the whole
surface is plain std and a closure is the language's existing spelling of a
lazily evaluated argument (`io.async`, `Mutex.with_lock`). Two things the
builtin design had are gone, both deliberately:

- the constructor-call peephole (a direct `T(...)` placed with no scope
  read): its only benefit was skipping one thread-local read, which the
  `__yo_scopes_ever_entered` guard already keeps off every program that never
  enters a scope;
- a CTFE rule: `with_allocator` calls externs, so a compile-time call is the
  ordinary "extern call at compile time" error (§3.7).

In today's language no `unwind` can actually leave a `with_allocator` body: a
closure may not capture a control-bound value (`ctl` handlers and structs
holding them), so a handler installed outside the body is unreachable from
inside it, and one installed inside unwinds to a frame inside the body. The
guard is what keeps the restore correct if that rule is ever relaxed; the
test pins the reachable case (an unwind handled inside the body).

**The runtime side** (emitted beside `__yo_rc_free`,
`src/codegen/types/generation.yo`): `__yo_alloc_scope_t` (= the prefix
layout), the thread-local `__yo_current_allocator`, the process-wide
`atomic_int __yo_scopes_ever_entered` (set on the first non-global scope,
read relaxed), `__yo_scope_current()`, `__yo_rc_tag_of(s)`,
`__yo_scope_of_object(p)`, `__yo_rc_alloc_scoped(s, size)`, and std's hooks
`__yo_scope_ctx` / `__yo_scope_vtable` / `__yo_scope_set`. The six
constructor sites of §1.2 read the scope once, allocate through
`__yo_rc_alloc_scoped` and OR `__yo_rc_tag_of` into their `ref_count = 1`.

**The scope is a property of the task, not of the C stack.** An `io.async`
body created inside a scope suspends at its first `await`; `with_allocator`
returns and restores; the continuation runs later from the event loop.
Without a rule, everything the body allocates after its first suspension
would silently land in the global allocator — not unsound (routing is per
block) but a broken contract. **The rule needs no new state: a task created
in a scope was itself placed by it**, so its own owner prefix already holds
that scope. Every state machine's resume function is emitted as a
`<name>__body` plus a `<name>` wrapper (`resume_scope_wrapper`,
`src/codegen/async/state_machine.yo`) that, when any scope was ever entered,
sets the thread-local to `__yo_scope_of_object(sm)` around the body and
restores it after. Every path that runs a task — the queue, waiter
hand-offs, inline completions, a sync future's lazy start — enters through
that function pointer, so all of them are covered, and no future grows a
field. (The first draft's "continuation carries the scope" would have needed
a field on every continuation and waiter, and a hand-off path it could miss.)
A task spawned inside a scope therefore *stays* in the scope for its whole
life, including work after the scope's creator has returned; an arena whose
tasks are still alive at `deinit` trips the trap — loud, defined (§3.6).

**Parallelism does not inherit.** A `spawn` body runs on a worker whose
thread-local scope is empty → global. Passing an allocator *into* a task is
explicit — pass the `Allocator` value (it is `Send`, §3.8) and call
`with_allocator` inside. The spawn closure-capture copy
(`exprs/parallelism.yo:330`) is runtime-internal and stays global (Rule 2).

Semantics, stated loudly because it differs from Zig (where hidden
allocations do not exist): the scope captures **all user-visible** RC
allocations dynamically inside it — temporaries, `dyn` wrappers, boxed
closures, state machines, deferred dups the compiler creates — not just the
ones spelled in the source. That is correct by routing (every such block
frees back to its owner), usually *desired* (the whole subsystem's garbage
lands in the arena), and it is the documented contract. Container
**buffers** follow their constructor: `new_in(a)` puts one in `a`, and from
P3b the default constructors consult the scope too (see P3b). Either way the
owner is recorded in the buffer's prefix at creation, so a container's buffer
stays with one allocator for its whole life, wherever it later grows.

### 3.6 Arena semantics under RC (P0, P4)

```rust
arena := Arena.new(bytes);
{
  list := ArrayList(i32).new_in(arena.allocator());
  result := with_allocator(arena.allocator(), parse_into_graph(input));
  use(result);
}                                          // last refs drop; blocks route back
arena.deinit();                            // traps if any block is still live
```

- `Arena` is itself a `ref(struct)`: its **`Dispose` impl is the deinit
  check**, so an arena handle that dies with live blocks traps even when
  nobody called `deinit()` explicitly, and an arena stays alive as long as
  anything holds it. `deinit()` is the explicit early release (idempotent,
  marks the arena dead so a later `alloc` traps too). The arena's state
  block is never freed: dead states are pooled for reuse, so a stale
  `Allocator` copy reaches a flagged state rather than freed memory (P0).
- **The emptiness trap.** Live blocks → tier-3 trap
  `Arena.deinit: 3 block(s) still live (96 of 1024 bytes in use)`, then
  abort. Under `--debug-heap` every arena still live or abandoned at exit is
  listed in the exit report (P4). This is
  what makes "allocator outlives its blocks" a *checked* invariant instead
  of the use-after-free it is in Zig.
- `abandon()` — the escape hatch for process-lifetime arenas (startup
  tables, interners): release tracking, never free; the region stays live
  and shows up in the `--debug-heap` leak oracle at exit as intended. The
  mirror of Zig's "arena that lives forever" idiom, but explicit.
- Individual drops before deinit: a *bump* arena's `free` decrements the
  live counter and reclaims only a block that is the current top;
  `realloc` grows the top block in place and otherwise allocates fresh
  (the old bytes stay until deinit — fine, arenas are short-lived by
  design). A *general-purpose* explicit allocator (a second TLSF region, a
  pool) frees for real. Both route by the same prefix.
- **Cycles**: arena-allocated objects participate in cycle GC exactly as
  today; the collectors' free sites are routed and their readers masked
  (§1.4), so a collected cycle in an arena frees correctly, and anything the
  collector cannot prove dead is caught by the deinit trap. No new cycle
  rules.
- An `Arena` handle created inside another arena's scope is placed by that
  scope like any ref struct (and routes back to it); its *region* always
  comes from `GlobalAllocator.aligned_alloc`, which is an extern call, never
  a scoped constructor. Nested backing (an arena carving from another
  allocator) is D8, out of scope.

### 3.7 Safe mode and CTFE

- Using `Allocator`/`Arena`/`with_allocator`/`_in` constructors is safe;
  implementing a vtable, or calling `Allocator.alloc`/`free` directly (they
  return and take `?*void`), requires `pragma(Pragma.AllowUnsafe)` — the
  existing rule, unchanged (`plans/reference/MEMORY_SAFETY.md` §Allocators).
  The new trap kinds join tier 3.
- **CTFE**: an `Allocator` *value* is an ordinary comptime struct (that is
  how `global` is defined); *calling* through one is an extern call, which
  is already a compile-time error. `with_allocator(a, f)` at comptime
  evaluates `f()`: the evaluator's object model has no block placement and
  there is nothing to route. The first draft's "allocator-typed values are a
  comptime error" would have rejected `global` itself.

### 3.8 Threading

- Routing is **process-global**: the owner lives in the block's prefix, so a
  block freed on any thread reaches the right allocator. Necessary anyway:
  an `Iso` graph can cross to a worker and die there.
- std's explicit allocators are **thread-safe by default** — the same
  decision and the same reasoning as the fixed allocator's §2.3 ("always
  guard; revisit only with a number"): correctness must not depend on which
  thread's drop fires last. `Arena` guards its counter and bump pointer with
  `std/sync/atomic`'s `AtomicBool` as a spinlock (an RC object from the
  global allocator, created in `Arena.new`, never scoped).
- `impl(Allocator, Send())` in the pragma'd module is the audited base, the
  D1 precedent (`std/log.yo`, `std/sync/mutex.yo:47`). D9 says a bare `fn`
  field is *not* `Send` on its own, so without the impl no allocator could
  cross into a spawn body. The promise the impl makes: every std vtable
  function reaches no thread-affine global, and every std implementor's
  `ctx` is guarded. A user implementor is under `AllowUnsafe` and inherits
  the obligation — the same standing as any other pragma'd code.
- The thread-local scope is per-thread by construction (§3.5).

### 3.9 Chunked emission and per-TU duplication

`__yo_decr_rc` is emitted `static inline` per translation unit
(`gc_runtime.yo:528-535`, `:383-387`); `__yo_rc_free`, the two `#define`s
and `__yo_scope_current` must sit in the same header-routable range so
`--emit-chunks` builds stay consistent. `__yo_current_allocator` and
`__yo_scopes_ever_entered` are declared `extern` in the header and defined
once in chunk 0, the `__yo_unwind_target` pattern (`gc_runtime.yo:230-233`).
The `--emit-c` single-file output stays self-contained.

## 4. Phases

Each phase is one PR (or a short stack), gated by its acceptance tests. The
order isolates the one re-baseline (P2) from every semantic change: P2 is
byte-different but behavior-identical, so its diff is pure mechanism.
Nothing below starts until the release freeze lifts (match adoption waves
#997/#1000 are parked ahead of it in the same queue).

### P0 — `Allocator`, the prefix, `Arena`, the counting allocator (std-only)

**Status: implemented 2026-09-29** (branch `explicit-allocators-p0`).

Files: `std/allocator.yo`, new `std/arena.yo`, new `tests/arena.test.yo`,
two new CLI cases.

1. `std/allocator.yo`: `AllocatorVTable` (`alloc`/`realloc`/`free`),
   `Allocator {ctx, vtable}`, `impl(Allocator, Send())`,
   `ALLOC_PREFIX_SIZE = 16`, the private `_AllocPrefix`, and the methods
   `Allocator.global()`, `a.alloc(size)` (writes the prefix),
   `Allocator.realloc(ptr, size)` and `Allocator.free(ptr)` (both route
   through the prefix, so they are static — the owner is in the block),
   `Allocator.owner_of(ptr)`, `a.same(b)`. The first draft's
   `free(self, ptr)` / `free_routed(ptr)` split is gone: every release routes.
   **D9 resolved**: the vtables are module-level `:=` runtime globals
   (`_GLOBAL_VTABLE`, `_ARENA_VTABLE`), addressed with `&(...)`. Addressing
   a `::` constant emitted invalid C when P0 was written; that bug and its
   element/field twin were fixed on the way
   (`issues/fixed/address-of-a-module-level-constant-emits-a-placeholder.md`,
   `issues/fixed/address-of-an-element-of-a-compile-time-constant-emits-a-placeholder.md`),
   but the seed that compiles `std/allocator.yo` into the compiler predates the
   fix, so the vtables stay `:=` globals.
   The pragma'd module is the audited base for the D1 reach walk, so a spawn
   body may reach them.
2. `std/arena.yo`: `Arena.new(capacity)`, `allocator()`, `live_blocks()`,
   `used_bytes()`, `capacity()`, `is_released()`, `deinit()`, `abandon()`,
   `Dispose` = `deinit()`. The state is a plain block (`_ArenaState`) so the
   `Allocator` value can point at it; a per-arena `atomic_bool` spinlock
   guards it. Bump `alloc`, top-block reclaim on `free`, in-place growth of
   the top block on `realloc` (a moved block copies up to the bump offset,
   because a bump arena records no block sizes). Two lifecycle rules the
   design did not spell out:
   - **A state is never freed.** A dead arena's state goes to a
     mutex-guarded global pool reused by the next `Arena.new`, because a
     stale `Allocator` copy may still reach it; its `dead` flag turns that
     into a panic ("allocation from an arena after deinit") instead of a
     use-after-free. A pooled state stays reachable, so LeakSanitizer does
     not report it; the pool is bounded by the peak number of live arenas.
   - **`abandon()` keeps the state reachable** on a second global list, so
     a process-lifetime arena is not a leak report either.
3. The counting allocator lives in `tests/arena.test.yo` (a third
   implementor, forwarding to the global allocator).
4. Gates (all green 2026-09-29):
   - `tests/arena.test.yo` (9 cases, run under the test runner's default
     ASan): the counting allocator's totals include the prefix; the prefix
     ABI (word 0 = `ctx`, word 1 = `vtable`, 16 bytes before the block);
     `global` round-trip; live counter and top reclaim; in-place and moving
     realloc; exhaustion returns `.None`; `abandon`; 200 arenas through the
     state pool; two threads churning one arena.
   - `tests/cli-cases/arena-deinit-with-live-blocks-panics` and
     `tests/cli-cases/arena-allocation-after-deinit-panics` (rc 1 + the
     diagnostic).
   - `tests/allocator.test.yo` unchanged-green; `yo check ./std`
     (177/177); `yo test ./std --bail`; `yo fmt --check`; a stage-1 built
     with `--std-path ./std` (the compiler imports `std/allocator.yo` through
     `ArrayList`, so the seed must lower the new code).

### P1 — containers take allocators (std-only)

**Status: implemented 2026-09-29** (branch `explicit-allocators-p1`).

Files: `std/collections/{array_list,hash_map,hash_set,deque}.yo`,
`std/string/string_builder.yo`, their test files.

1. **Where the owner bit lives**, one private word per container, chosen so
   the hot path pays at most one AND:
   - `ArrayList`: the top bit of `_capacity`. The ZST anchor's capacity moves
     from `SIZE_MAX` (whose top bit is set) to `_CAP_MASK`; `capacity()` still
     reports `SIZE_MAX` for a zero-sized `T`. `with_capacity` /
     `ensure_total_capacity` treat a capacity above `_CAP_MASK` as capacity
     overflow, so a count can never reach the tag.
   - `HashMap`: the top bit of the tombstone count, NOT `capacity` — the
     bucket count feeds every probe (`% capacity`), the tombstone count is read
     only by the load check. The field becomes private (`_tombstones`) and
     `tombstones()` a method, matching `HashSet.tombstones()`; the five test
     reads move to the method.
   - `Deque`: the top bit of `_capacity`, masked at each index computation
     (the compiler uses `Deque` in one place, so the AND costs nothing
     measurable).
   - `HashSet` and `StringBuilder` inherit through the container they wrap.
2. `new_in(alloc)` / `with_capacity_in(alloc, n)` on all five, plus
   `allocator() -> Option(Allocator)`. **`new_in` allocates only the owner
   prefix** (a zero-byte `Allocator.alloc`), not a four-element buffer: that
   block is how the container remembers its allocator at capacity zero. An
   arena list's `shrink_to_fit` on an empty list shrinks to that prefix
   instead of freeing, so the list keeps its allocator.
3. **Derived containers**: `clone` keeps the source's allocator (Rust's
   `Vec<T, A>: Clone`); a `HashMap` resize allocates the new tables from the
   old ones' owner; `StringBuilder.to_string` hands the buffer to the
   `String` and takes its next buffer from the same allocator. Every other
   method that builds a new container (`slice_copy`, `drain`, `map`, …) builds
   it on the global allocator, which P3's scope can redirect.
4. **The `imm` family moves to P3.** A persistent container builds new nodes
   on every update, so an explicit `_in` constructor would have to thread the
   allocator through every derived version. Because each buffer records its
   owner in its prefix, P3 instead lets the default constructors consult the
   current scope (see P3 step 3), which covers `imm/{vec,map,string}` and
   every derived version at once.
5. Gates (green 2026-09-29, stage-1 built from P0 with the tree std):
   `tests/collections/{array_list,array_list_convenience,hash_map,hash_set,deque}.test.yo`,
   `tests/string/{string_builder,string}.test.yo`, `tests/arena.test.yo`,
   `tests/allocator.test.yo` all green (new cases: growth inside the arena,
   `capacity()` / `tombstones()` never report the tag, clone keeps the
   allocator, shrink keeps it, `try_push` against an exhausted arena returns
   `OutOfMemory`, a ZST list in an arena, every buffer back in the arena at
   dispose); the verifier outcome lines of `yo check
   std/collections/array_list.yo` identical to develop. **Layout gate** and
   **self-compile A/B**: see the P1 PR.

### P2 — the tag bit and routed frees (codegen, behavior-identical)

Files: `src/codegen/types/generation.yo` (the two `#define`s beside the
header typedefs, `__yo_alloc_prefix_t`), `src/codegen/functions/gc_runtime.yo`,
`src/codegen/functions/constructors.yo:783`, `src/codegen/exprs/rc_fns.yo`.

1. `__YO_RC_TAG`/`__YO_RC_COUNT`; `__yo_alloc_prefix_t` (with a
   `_Static_assert(sizeof == 16)`); `__yo_rc_free` in the header-routable
   range; the eight free sites switched; the twelve readers of §1.4 masked
   (`GC_DEBUG` included, so traces stay truthful).
2. **Nothing can produce a tagged block yet** — this PR is pure mechanism,
   which is what makes its fixpoint re-baseline reviewable: every hunk in
   the emitted-C diff is a mask or the helper.
3. Gates:
   - `yo check ./src`; `yo compile src/main.yo --skip-c-compiler`;
     `yo build`.
   - Fixpoint re-baseline (`scripts/bootstrap/fixpoint_only.sh`) +
     determinism green; hollow sweep ratchet unchanged.
   - `tests/rc.test.yo`, `tests/dyn.test.yo`, `tests/iso*.test.yo`, the
     cycle-GC tests, `yo test ./std` all unchanged-green; the imm
     copy-on-write tests specifically (they read `rc()`).
   - `--emit-chunks auto` self-build green (the helper is per-TU).
   - Self-compile A/B within noise (one masked compare on the decr path;
     `__yo_decr_rc` is 54% of a self-compile, so this is the phase whose
     number matters most).

### P3 — the scoped form (codegen + std)

**Status: implemented 2026-09-29** (branch `explicit-allocators-p3`).

Files: `src/codegen/types/generation.yo` (the scope runtime beside
`__yo_rc_free`; the Iso create site), `src/codegen/functions/constructors.yo`
(struct and enum constructors), `src/codegen/functions/dyn.yo` (dyn boxes),
`src/codegen/exprs/async.yo` (both state-machine constructors, the sync
future's resume), `src/codegen/async/state_machine.yo`
(`resume_scope_wrapper`), `std/allocator.yo` (`with_allocator`,
`_ScopeGuard`, the three hooks), `std/arena.yo` (`scoped`), new
`tests/explicit_allocators.test.yo`.

1. The scope runtime (§3.5): `__yo_alloc_scope_t`, the thread-local, the
   `__yo_scopes_ever_entered` flag (a chunk global under `--emit-chunks`),
   `__yo_scope_current`, `__yo_rc_tag_of`, `__yo_scope_of_object`,
   `__yo_rc_alloc_scoped` (same asm barrier as `__yo_rc_alloc`; it writes
   the prefix exactly as `Allocator.alloc` does), and the std hooks.
2. The six constructor sites: scope read, scoped alloc, tag OR-ed into the
   `ref_count = 1` write.
3. The resume wrapper on both state-machine kinds.
4. `with_allocator(alloc, f)` + `_ScopeGuard`, a plain `ref` struct, and
   `Arena.scoped`. An unused struct and its `Dispose` are not emitted, so the
   seed-built compiler never references hooks the seed runtime lacks
   (measured: a seed build of a program importing `std/collections` emits
   neither). A first version made the guard generic in `T` and stored a
   `?*T`, which ran into two pre-existing future-in-aggregate codegen bugs once
   `T` could be an `io.async` future. One is fixed,
   `issues/fixed/an-io-async-future-stored-in-an-enum-payload-emits-a-nested-typedef.md`.
   One is open, `issues/an-io-async-future-in-a-generic-struct-field-lowers-to-two-c-types.md`.
5. `tests/explicit_allocators.test.yo`: a ref struct (and `rc()` masking);
   objects outside the scope stay global; ref enum, `box`, `arc`,
   `AtomicBool` (an atomic ref struct — the D5 reversal), `dyn`; an `Iso`
   extracted and dropped on a worker thread; a cycle collected by
   `Gc.collect()` into the arena; nested scopes; a spawned thread does not
   inherit; a task keeps its scope across a suspension; an `unwind` handled
   inside the body; `with_allocator` with `Allocator.global()`.
6. Gates: P2's list re-run on this stage-1; ASan (the runner's default) on
   the new file; `tests/algebraic_effects.test.yo`, `tests/async*.test.yo`,
   `tests/rc.test.yo`, `tests/dyn.test.yo`, `tests/iso.test.yo`,
   `tests/cycle_collector.test.yo` green; self-compile A/B.

### P3b — default containers follow the scope (std; waits for the seed)

`ArrayList.new()` / `with_capacity`, `HashMap.new()` / `with_capacity`,
`Deque.new()`, `StringBuilder.new()`, `String`'s buffer and the `imm`
family's node buffers consult the current scope: under `with_allocator(a, …)`
they behave as `new_in(a)`; outside any scope, exactly as today. This is what
makes "the whole subsystem, there" cover buffers too, and it is how the
`imm` family gets explicit placement at all (P1 step 4).

**Seed gate.** These containers are compiled into the compiler by the seed,
so their new calls to `__yo_scope_current` would reference a runtime hook the
seed's emitted runtime does not define, and the stage-1 build would not link.
P3b therefore lands only once `SEED_VERSION` carries P3
(`plans/backlog/SEED_VERSION_AUTOMATION.md`, the two-step rule in
`.github/instructions/c-codegen.instructions.md`). It is testable before
then: a P3 stage-1 runs the container tests against the P3b std.

1. One private `_scope_allocator() -> Option(Allocator)` in
   `std/allocator.yo` (reads `__yo_scope_ctx`/`__yo_scope_vtable`); each
   default constructor that allocates calls the `_in` path when it is
   `.Some`. `ArrayList.new()` itself stays allocation-free outside a scope.
2. The `imm` nodes: the buffer allocations take the scope allocator, tagging
   the node's capacity word as P1 does.
3. Gates: the P1 container tests plus scope cases (a list created in a
   scope grows in the arena after the scope ends; an `imm` vector's derived
   versions live in the arena), the P1 layout gate, a self-compile A/B once
   the seed allows the build.

### P4 — hardening and tooling

**Status: implemented** (branch `explicit-allocators-p4`). What changed
against the original list, and why:

1. **`--debug-heap`.** The flag belongs to the fixed-region allocator
   (`plans/reference/FIXED_REGION_ALLOCATOR.md`), so there is no
   "per-allocator" report for the other two to join. What landed: codegen
   emits `__yo_debug_heap_on()` (`src/codegen/types/generation.yo`); under it
   every `Arena` sits on a live list from `new` until `deinit`/`abandon`, and
   the first `Arena.new` installs an exit reporter that prints one line per
   arena that was never deinit, then one per abandoned arena —
   `arena (never deinit): live at exit: N block(s), T of C bytes in use`,
   `arena (abandoned): …` — ahead of the heap line. The list stays off without the flag, so a leaked
   arena stays unreachable and LSan keeps reporting its region. The `deinit`
   trap message carries the same numbers:
   `Arena.deinit: N block(s) still live (T of C bytes in use)`.
2. **Parallelism.** `Allocator` is `Send` (two words, no RC); the `Arena`
   handle is a `ref` and is NOT, pinned by a negative test in
   `tests/arena.test.yo`. `Mutex(Arena)` is not the sanctioned pattern after
   all: every arena operation already takes the arena's own spinlock, so the
   shared form is the `Allocator` value (`arena.allocator()` passed into the
   spawn body, `with_allocator` there — a thread does not inherit the scope).
   Tests: two threads churning one arena; an `Iso` built in a scope released
   on another thread; a spawned thread starting on the global allocator.
3. **Agent tooling.** `pack/context.md` (ownership section), the
   core-patterns cheatsheet, and a yo-design instructions section. `yo context
   std/arena` / `std/allocator` come from the module doc comments with no
   extra entry. `yo explain` does not apply: its registry holds compile-time
   diagnostics, and the arena traps are runtime panics whose message names
   the arena state.
4. Gates: `tests/arena.test.yo` and `tests/explicit_allocators.test.yo`
   under the default LSan run and under `--allocator fixed --debug-heap`; the
   parallelism suite; the hollow sweep on the stack's top.

### P5 — docs and stability freeze

1. `docs/en-US/MEMORY_SAFETY.md` + `DESIGN.md` and `zh-CN` twins (allocator
   = placement, RC = lifetime, the deinit rule, `abandon`, the scope-follows-
   the-task rule, what `scoped` captures); `std/allocator.yo` stability note
   resolved (second implementor shipped, vtable frozen per its own
   criterion); `plans/reference/` entry for the landed decisions.
2. Gates: docs build both languages; release-notes curation.

## 5. Risks

| risk | shape | mitigation |
| --- | --- | --- |
| Blast radius of the tag bit | P2 touches the decr path of **every** compiled program | default path is one masked compare + one branch; P2 carries no semantic change, so its re-baseline diff is mechanism only; self-compile A/B on P2 alone |
| A missed count reader | an unmasked `> 0`/`== 1` on a tagged block: a leak (never dies) or a never-collected cycle | §1.4 is the grep-derived list; the P3 tests exercise every reader class (decr, atomic decr, collector, Iso walk, `rc()`) on tagged blocks |
| Runtime-internal block mis-routed | an internal `__yo_rc_alloc` block landing in an arena and freed with `mi_free` | Rule 2: `__yo_rc_alloc` never consults the scope; only six named sites call `__yo_rc_alloc_scoped` |
| Scope leaks past an `unwind` | thread stays on a dead arena | the builtin's restore is emitted before the unwind check; a dedicated test |
| Async body escapes its scope | allocations after the first `await` go global, silently | the continuation carries the scope (§3.5); a dedicated test |
| Container layout regression | +8 B on `ArrayList` re-crosses the 96 → 80 class (~0.4 GB at self-compile scale) | capacity high bit + prefix: `sizeof` unchanged, gated by the P1 layout diff |
| Header/word invariants | the packed word is perf-tuned | writers untouched; readers masked; A/B on P2 |
| Darwin TLS cost | `_tlv_get_addr` per user-visible allocation | `__yo_scopes_ever_entered` guard; A/B on P3 |
| std stability | `_in` constructors, one private bit | additive; D4 recorded before P1 |
| `build.Allocator` name collision | two `Allocator`s in the tree | different modules, qualified use; rename escape hatch (D6) |

## 6. Open decisions

| # | decision | recommendation |
| --- | --- | --- |
| D1 | tag mechanism | `ref_count` high bit on all three headers + 16 B prefix on tagged blocks only. A `gc_flags` bit was considered: zero hot-path cost on GC builds, but the lightweight header has no flags byte, so it would be two mechanisms. "Always-prefix every block" rejected — it taxes every object in every program, including the compiler's own multi-GB self-build |
| D2 | language surface for RC construction | **decided in P3**: the std function `with_allocator(alloc, f)` with a closure, unwind-safe through an RAII guard (§3.5); the lazy-expression builtin and its constructor peephole were dropped. Type authors write `T.new_in(a, ...)` over it, the containers' convention |
| D3 | thread-safety of explicit allocators | spinlock always (mirror of `FIXED_REGION_ALLOCATOR.md` §2.3) |
| D4 | std stability: containers | no field, no layout change, one private bit in the capacity word; `_in` constructors additive; `new_in` allocates eagerly — record the ruling in the stability policy |
| D5 | atomic RC from explicit allocators | **supported** from P3 (the path is `fetch_sub`, masked in one line); the first draft's rejection is withdrawn |
| D6 | `Allocator` name collision with `std/build.yo` | keep both names; rename the runtime type to `Mem.Allocator` only if review finds real confusion |
| D7 | allocator-aware `Dispose` | not introduced — dispose stays allocator-blind; the buffer routes through its prefix, the object through its prefix |
| D8 | nested arenas (arena backed by arena) | out of scope; explicit backing-allocator parameter on `Arena.new` as a later addition |
| D9 | how std obtains an immortal `*(AllocatorVTable)` | **resolved in P0**: a module-level `:=` runtime global addressed with `&(...)`. Addressing a `::` constant emitted invalid C until `issues/fixed/address-of-a-module-level-constant-emits-a-placeholder.md` |
| D10 | over-aligned buffers (`alignof(T) > max_align_t`) | out of scope, as today (containers use the plain family); if added, it is an `aligned_alloc`/`aligned_free` **pair** on the vtable, never a single `free` |

## 7. References

- `std/allocator.yo` — the trait surface whose freeze this plan completes;
  its stability note is this plan's opening question.
- `plans/reference/FIXED_REGION_ALLOCATOR.md` — the global allocator layer
  this builds on (TLSF, OOM policy, the leak oracle, `--debug-heap`).
- `plans/reference/MEMORY_SAFETY.md` — the safe/unsafe boundary the
  Allocator trait sits on (§Allocators); `plans/SAFE_MODE.md` — the trap
  tiers.
- `plans/reference/PARALLELISM_RULES.md` — D1/D4/D9: why `Allocator` needs
  an explicit `Send` impl and what it promises.
- `plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md`,
  `plans/reference/REF_REFERENCE_SEMANTICS.md`,
  `plans/reference/ARC_TYPE.md` — the RC model that stays untouched.
- `src/codegen/c/collection.yo:500-512` (`__yo_rc_alloc`),
  `src/codegen/functions/gc_runtime.yo` (the eight free sites, the readers),
  `src/codegen/types/generation.yo:980-1047` (the three headers),
  `src/codegen/async/runtime_core.yo:27-31,292,355` (the continuation) —
  the codegen anchors of §3.4–3.5.
- `plans/archive/STD_API_STABILIZATION.md` — D9 (`push`/`try_push`): the
  fallible surface explicit allocators must preserve.
- Zig `std.mem.Allocator` / `std.heap.ArenaAllocator` — the ergonomics being
  borrowed, and (via the deinit trap) the bug class being declined.

## 8. Corrections from the second audit (2026-09-29)

Kept so the PR history explains itself; each row names the section that now
carries the corrected design.

| first draft said | measured | consequence |
| --- | --- | --- |
| eight RC-allocating constructs; `__yo_rc_alloc` consults the scope, internal sites opt out | 133 callers, 6 user-visible; ~126 runtime-internal blocks freed untagged | Rule 2: inverted default, `__yo_rc_alloc` untouched (§1.2, §3.4) |
| the tag is set inside `__yo_rc_alloc` (`ref_count = 1 \| T`) | every ctor writes `ref_count = 1` *after* the call; async SMs `memset` | the tag is OR-ed in at the six ctor sites (§3.4) |
| nine free sites, incl. `gc_runtime.yo:1189` | eight RC free sites; `:1189` frees GC state, `:269`/`:302` unwind values | §1.3 |
| count readers = decr tests, `rc()`, Iso walk ("the full list") | plus four collector readers (`> 0`/`== 0`) | unmasked, arena cycles are never collected (§1.4) |
| atomic decr is a CAS loop; atomic types rejected with a compile error | `atomic_fetch_sub`; the scoped form cannot know statically | atomic supported, D5 reversed (§1.4, §3.4) |
| `_alloc : Allocator` field per container; P1 emitted C byte-identical | 40 B (or 8 B) re-crosses the measured 96 → 80 class; C cannot be byte-identical | capacity high bit + buffer prefix, layout-diff gate (§1.6, §3.3) |
| `arena.scoped(f)` is a std wrapper over a TLS setter | `unwind` is flag-propagated: a Yo wrapper skips its restore | `with_allocator` builtin lowered by codegen (§1.5, §3.5) |
| (unstated) | a task suspended inside a scope resumes outside it | the continuation carries the scope (§3.5) |
| `aligned_alloc` required on the trait | one `free` cannot honor the two-family rule on Windows | dropped; D10 |
| allocator values are a CTFE error | `global :: Allocator(...)` is itself a comptime value | only calls are runtime-only (§3.7) |
| `Allocator` is `Send` iff `ctx` is | D9: a bare `fn` field is never `Send` | explicit `impl(Allocator, Send())` (§3.8) |
