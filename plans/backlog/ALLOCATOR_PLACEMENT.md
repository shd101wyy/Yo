# Allocator placement: global by default, placement by argument

> **Status: Backlog — decided 2026-10-24 (maintainer adopted the advisor's verdict); steps A1/B1/B2 are VBD
> campaign items, step C follows v0.2.75.** A1 is #1572 (merged; it ships in v0.2.70). A2, B1, B2 and C are not
> started. Releases: `plans/handover/VBD_RELEASE_SCHEDULE.md` (revision of 2026-10-24). Line numbers are develop's
> at `82671f612`. The maintainer's criterion: "Yo should be as explicit as possible because it is written by LLMs;
> no backward compatibility; do things right." His answer to the verdict: "Adopt as recommended". This plan
> replaces a same-day first draft (the "hybrid", §8 item 1). It amends `plans/reference/EXPLICIT_ALLOCATORS.md`
> (the scope goes), `plans/backlog/ZIG_STYLE_ALLOCATORS.md` (the catalog is selected by a root declaration) and
> `plans/VALUES_BY_DEFAULT.md` §3.11 (the containers' `alloc` question is decided).
>
> **Coordinator correction (2026-10-24, maintainer-visible): there is no `Dyn.new`.** `dyn(...)` keeps its
> spelling, and the cell it synthesizes is global. Placement is `dyn(rc(f, alloc : .Some(a)))` today and
> `dyn(Rc.new(f, alloc : .Some(a)))` after static-argument inference. Today `dyn` wraps a payload that is already
> an `Rc`/`Arc` without a second cell (§2.4), so V2b B13 gains nothing for placement. V5 Generation A must keep
> that true once `Rc`/`Arc` stop being `ref` structs (§2.4, §7).

## 0. The verdict

`with_allocator(a, f)` is dynamic scoping, the property `plans/archive/EXPLICIT_EFFECTS.md` deleted `given` for.
Under it, a call site such as `ArrayList(T).new()`, `rc(v)`, an interpolated string or `io.async(…)` means two
different things, depending on a caller the callee cannot see. The scope also causes the tree's two live allocator
footguns:

- an allocator callback that allocates re-enters itself
  (`issues/retired/2026-10-21-should-allocator-callbacks-run-outside-the-allocation-scope.md`);
- a task carries an arena scope across a suspension (`tests/explicit_allocators.test.yo:122`).

Owner-prefix routing makes where a block lives independent of when it dies. An allocator is therefore never needed
for correctness, only for placement. Placement is one argument at the creation site.

## 1. The four rules

1. **A creation with no `alloc :` goes to the global allocator.** There is no thread state and no scope. The
   implicit creations are all global: interpolated `String`s, `io.async` state machines, the cell `dyn`
   synthesizes, closure environments, derive-generated code and the runtime's own blocks. `clone()` lands where
   its source lives (VBD decision 12, unchanged). `clone_in(a)` places a copy explicitly.
2. **There is one spelling for placement: a defaulted `(alloc : Option(Allocator)) ?= .None`.** It is the
   parameter `rc`/`box`/`arc` already have (`std/prelude.yo:9763`, `:9966`, `:10108`), and `Rc.new`/`Box.new`/
   `Arc.new` inherit it (`plans/backlog/STATIC_ARGUMENT_INFERENCE.md` A2). The containers take the same
   parameter, so `new_in`/`with_capacity_in` are deleted. A user function that passes placement on declares the
   same parameter, which a safe file can do once step A2 makes `Allocator` an opaque handle (§6).
3. **The global allocator is declared in the root module** (step C): `global_allocator :: heap.Mimalloc;`. Without a
   declaration it is `heap.System`. `--allocator` survives only as `yo test --allocator debug`, which wraps the
   declared allocator in Z11's tracker.
4. **Frees route by owner prefix** (landed: `std/allocator.yo:234-268`, codegen's `__YO_RC_TAG`). Mixing placements
   inside one value is legal and safe.

## 2. Examples

### 2.1 Today (v0.2.69; compiled and run 2026-10-24)

```yo
{ Arena } :: import("std/arena");
{ ArrayList } :: import("std/collections/array_list");
{ StringBuilder } :: import("std/string");

main :: (fn() -> unit)({
  arena := Arena.new(usize(1) << usize(16));
  a := arena.allocator();
  n := rc(i32(7), alloc : .Some(a));
  xs := ArrayList(i32).with_capacity_in(a, usize(8));
  xs.push(n.*);
  sb := StringBuilder.new_in(a);
  sb.write_str("placed");
  g := ArrayList(i32).new();
  g.push(i32(1));
});
export(main);
```

`arena.live_blocks()` is 3 before the locals die, and the arena's own drop then succeeds. `g` is global.

### 2.2 After A2 and B2 (v0.2.72): one spelling

```yo ignore
// A library function: global, nothing to declare, nothing to thread.
tokenize :: (fn(src : &String) -> ArrayList(Token))({
  mut(out) := ArrayList(Token).new();
  …
  out
});

// A constructor that can be placed takes the same defaulted argument and passes it on.
Node :: struct(name : String, kids : ArrayList(Rc(Self)));
make_node :: (fn(name : String, (alloc : Option(Allocator)) ?= .None) -> Rc(Node))(
  rc(Node(name : name, kids : ArrayList(Rc(Node)).new(alloc : alloc)), alloc : alloc)
);

// An arena subcomputation: every placement is visible at its site.
count_nodes :: (fn(tokens : &ArrayList(Token)) -> usize)({
  arena := Arena.new(usize(1) << usize(20));
  a := Option(Allocator).Some(arena.allocator());
  mut(nodes) := ArrayList(Rc(Node)).new(alloc : a);
  for(&tokens, t => nodes.push(make_node(t.text.clone_in(arena.allocator()), alloc : a)));
  nodes.len()
}); // `nodes` dies before `arena`; a node stored anywhere longer-lived makes the arena's drop panic
```

After static-argument inference's Generation B (v0.2.73), `rc(…, alloc : alloc)` is spelled
`Rc.new(…, alloc : alloc)`. `make_node`'s parameter is legal in a safe file only after A2. Today the raw-view
gate rejects it: "Raw-pointer-carrying types ('Option(Allocator)') are not available in safe code" (probe,
2026-10-24, v0.2.69). Without A2 this example needs `pragma(Pragma.AllowUnsafe)`. With `Rc(Self)` and the
pragma, the shape type-checks today (except `clone_in`, which B2a adds).

### 2.3 The implicit creations

```yo ignore
s := `n = ${n}`;                                   // a temporary String: global
sb := StringBuilder.new(alloc : a);                // a placed string is built explicitly
sb.write_str("n = ");
t := io.async(() => work(io));                     // a task: always the global task pool
(d : Dyn(Probe)) = dyn(rc(Sq(side : i32(3)), alloc : a)); // one cell, in `a`
```

### 2.4 `dyn` over a placed `Rc`

**Today** `evaluate_dyn_value` auto-boxes only a payload that is neither a `ref` object nor a `Dyn`
(`src/evaluator/values/dyn.yo:1141`, non-executing path, and `:1234`, executing path). Both tests go through
`is_reference_struct_type`, which reads `is_reference_semantics` (`src/types/guards.yo:318-319`). While `Rc(V)` is
`ref(struct((*) : V))` (`std/prelude.yo:9737`), an `Rc`/`Arc` payload is used as the `Dyn`'s data object
directly. Probe (2026-10-24, v0.2.69): `r := rc(Sq(side : i32(3)), alloc : .Some(arena.allocator()))`, then
`(d : Dyn(Probe)) = dyn(r)`. `arena.live_blocks()` stays 1, and a call through `d` returns 9. The probe cannot
see a second cell on the global heap; the code path above is the evidence that none is made.

**After V5 Generation A** (v0.2.72) `Rc`/`Arc` are value wrappers around `_cell : __yo_cell(V)`
(`plans/VALUES_BY_DEFAULT.md` §3.5, "Left to V5"). They fail `is_reference_struct_type`, so `dyn` would box the
`Rc` again, into a second, global cell, and the placement would be lost. **V5 Generation A's obligation:** `dyn`'s
auto-box test treats an `Rc`/`Arc` wrapper as the data object and reuses its cell. VBD already lists "the `dyn`
cell" among the predicates V5's compiler half teaches; this names the placement consequence. Its test is in §7.
The spelling `dyn(Rc.new(f, alloc : …))` reaches user code with static-argument inference's Generation B
(v0.2.73), after V5 Generation A, so it depends on this obligation.

One gap found by the same probe: a **closure literal** inside `dyn(rc(<closure>, alloc : …))` is rejected
("Expected a function type"). The contextual typing that `dyn(rc(u => …))` relies on matches only a one-argument
cell call (`src/evaluator/values/dyn.yo:986`). Filed as
`issues/2026-10-24-dyn-of-a-placed-rc-closure-literal-is-not-typed-from-the-dyn.md` (S2). Workaround: bind the
closure with a type first.

## 3. Explicit and implicit

| What | Explicit or implicit | Spelling, or why it stays implicit |
| --- | --- | --- |
| Which heap the program uses | explicit | the root's `global_allocator` (step C); `--allocator` until then |
| Every non-global placement | explicit | `alloc : .Some(a)` at the creation site; `clone_in(a)` for a copy |
| That a function allocates | implicit | 88 % of functions do (advisor's 2026-10-24 count), so a marker on 88 % carries no information; `noalloc` (§9) marks the other side |
| Interpolation, tasks, the `dyn` cell, closure environments, derived code | implicit, global | no argument slot; they are temporaries or runtime-owned; spell the owned form to place it (`StringBuilder`, `rc(v, alloc :)` under `dyn`) |
| `clone()` | implicit: where its source lives | the one non-lexical rule. Following the caller instead would move data out of an arena without a mark. |
| Growth and free | implicit: the owner prefix | a block always returns to the allocator that made it |

## 4. Safety: undefined behavior, Yo against Zig

| Hazard | Zig | Yo after B2 |
| --- | --- | --- |
| Free through the wrong allocator | UB: the caller must pass the same allocator | impossible: frees route by owner prefix |
| Double free | UB (`DebugAllocator` detects it) | impossible in safe code; a raw `AllowUnsafe` double free aborts under `--allocator debug` (Z11, #1580) |
| Size or alignment mismatch on free | UB (`DebugAllocator` detects it) | impossible once allocator v2's sized free takes both from the type |
| Arena deinit with a live block | UB (use after free) | a defined panic (`std/arena.yo:477-487`); its message names `std/assert.yo:39`, not the caller (`issues/2026-10-24-arena-deinit-panic-reports-the-assert-site-not-the-callers.md`, S3); a compile error once the real arena exists (`ZIG_STYLE_ALLOCATORS.md` §4, origins N2) |
| A stale allocator after its arena died | UB | a panic: arena states are generation-stamped (`std/arena.yo:63-71`; panics at `:177`, `:204`, `:232`) |
| Raw alloc/free misuse under `AllowUnsafe` | UB | still raw; checked under the debug allocator |
| An allocator callback allocating "through the scope" | not applicable | today a stack overflow (the retired question's measurement); after B2 impossible, because there is no scope |
| A task placed in an arena and suspended across `deinit` | not applicable | today possible (a task keeps its scope); after B1 tasks are always global |
| A cross-thread free into a thread-unsafe allocator | UB | unchanged and documented (VBD "allocator interface, version 2", "Documented, not changed") |
| A forgotten `alloc :` | not applicable: the call does not compile without an allocator | the block lands on the global heap; a performance issue, not a safety one |

## 5. What is deleted

**std (B1):**

- `std/allocator.yo`: `_ScopeGuard` (`:274-285`), `with_allocator` (`:286-311`), `current_allocator` (`:312-321`),
  their exports (`:329-330`) and the comment on the scope hooks (`:61-65`).
- `std/arena.yo:441-445`, `Arena.scoped`, and its import of `with_allocator` (`:40`).
- The scope readers in std: `ArrayList.new`/`with_capacity` (`std/collections/array_list.yo:171-176`, `:254-256`),
  `Deque.new` (`std/collections/deque.yo:57-60`), and `HashMap.new` and `_alloc_with_capacity`
  (`std/collections/hash_map.yo:147-149`, `:252-257`). Each `.None` becomes the global allocator.
- `box`'s scope default (`std/prelude.yo:9969-9973`). `box` keeps its `.Some(a)` path, which already calls the
  vtable directly.

**std (with V5 Generation A):** `rc`'s and `arc`'s scope swap (`std/prelude.yo:9774-9782`, `:10117-10125`), and
the three `__yo_scope_*` externs (`std/prelude.yo:9932-9939`).

**std (B2):** `new_in`/`with_capacity_in` on `ArrayList` (`std/collections/array_list.yo:290`, `:294`), `HashMap`
(`std/collections/hash_map.yo:355`, `:357`), `HashSet` (`std/collections/hash_set.yo:113`, `:117`), `Deque`
(`std/collections/deque.yo:69`) and `StringBuilder` (`std/string/string_builder.yo:100`, `:104`). That is 60 lines
in std and tests (std 39, tests 21; 44 outside comments). src has none: `src/version_cache.yo:659` calls
`TempDir.new_in`, which takes a parent directory, not an allocator, and stays.

**Codegen (B2, after V5 Generation A):**

- The thread scope (`src/codegen/types/generation.yo:1093-1152`): the `_Thread_local __yo_current_allocator`
  (`:1102`, `:1106`), `__yo_scopes_ever_entered` (`:1103`, `:1107`), `__yo_scope_current` (`:1110-1116`) and
  `__yo_scope_ctx`/`__yo_scope_vtable`/`__yo_scope_set` (`:1146-1152`).
- `__yo_rc_alloc_scoped(s, size)` (`:1130`) becomes `__yo_rc_alloc_in(a, size)`, called only with an explicit
  allocator.
- The seven sites that read the scope become global: `src/codegen/functions/constructors.yo:234`, `:783`;
  `src/codegen/functions/dyn.yo:146`; `src/codegen/exprs/async.yo:1477`, `:3987`;
  `src/codegen/exprs/other_fn_call.yo:1040` (a cell's `.None`); `src/codegen/exprs/comptime_value.yo:499`.
- The state machine's scope save and restore, `resume_scope_wrapper` (`src/codegen/async/state_machine.yo:2024-2041`;
  emitted at `:2018` and `src/codegen/exprs/async.yo:3855`), and the placed-task branch of `_sm_alloc_call`
  (`src/codegen/exprs/async.yo:1447-1452`). A task is never placed.

**Tests:**

- `tests/explicit_allocators.test.yo`: 18 `.scoped(` sites and 3 `with_allocator` lines. Its scope tests are
  rewritten to `alloc :` where a placement form exists. The ones with no counterpart are deleted: a task keeps
  its scope (`:122`), a placed task (`:148`, `:157`), a thread does not inherit the scope (`:111`), nested scopes
  (`:97`), an unwind inside the scope (`:168`).
- The other `with_allocator` sites: `tests/rc.test.yo:2264`, `:2758`; `tests/arc.test.yo:107`;
  `tests/string/string.test.yo:2558`, `:2565`; `tests/yo_cell.test.yo:99`, `:110`.
- The advisor's count is 12 `with_allocator(` lines in 6 test files and 7 in std, comments included. Verified.

**Docs (B1, both languages):** `EXPLICIT_ALLOCATORS.md` (22 lines each), `MEMORY_SAFETY.md`, `DESIGN.md`, `ARC.md`.
Also `README.md` and `docs/zh-CN/README.md`, `.github/instructions/yo-design.instructions.md` and
`c-codegen.instructions.md`, and `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`. A skills edit moves
seven cli-case goldens. `plans/reference/EXPLICIT_ALLOCATORS.md` is amended when B2 lands.

## 6. Migration

### A1: the cell takes the allocator (#1572, merged; in v0.2.70)

PR #1572 (`8a16d5553`) landed after the v0.2.69 tag, so v0.2.70 is the first seed that carries it.
`__yo_cell(V)(v, alloc)` passes `.Some(a)` to the allocation helper with no scope switch
(`src/codegen/exprs/other_fn_call.yo:1008-1046`). Two limits remain:

1. **`rc` and `arc` still swap the thread scope** (`std/prelude.yo:9774-9782`, `:10117-10125`). `Rc(V)` is still
   `ref(struct((*) : V))` (`std/prelude.yo:9737`), not a `__yo_cell`. Only a cell's C constructor takes the scope as
   a parameter (`src/codegen/functions/constructors.yo:221-235`, `src/codegen/functions/declarations.yo:363-369`).
   Every other `ref` constructor reads the thread-local. So no seed lets std place an `Rc`/`Arc` without the swap
   until `Rc`/`Arc` hold a `__yo_cell`. That is V5 Generation A (v0.2.72, ceiling v0.2.73), which needs V5's seed
   predicates from the v0.2.71 cut.
2. **A cell's `.None` still follows the scope** (`:1040`). Step B2 changes it, with no seed involved.

**The smallest alternative, considered and not proposed:** give `Rc(V)`'s and `Arc(V)`'s constructors the cell's
scope parameter, by extending the `is_cell_primitive_type` branch to the two wrapper types. That change is a
compiler Generation A at v0.2.71, so std could use it at v0.2.72 at the earliest. V5 Generation A delivers the
same thing in the same release. So **A1 needs nothing more**, and "`rc`/`arc` stop swapping" is a line in V5
Generation A's rewrite of `rc`/`arc` onto the cell.

**Fallback:** if the v0.2.70 cut predates `8a16d5553` (it cannot: the commit is already on develop), A1 rides
v0.2.71, and V5 Generation A's need for the v0.2.71 seed is unchanged.

### A2: `Allocator` is an opaque handle in safe code (v0.2.71; compiler only)

Added 2026-10-24 by the design review. Rule 2 assumes that user code can take an allocator as a parameter, and a
safe file cannot. The raw-view parameter gate (`src/evaluator/types/function.yo:1871-1885`) rejects every
parameter type whose representation carries a raw pointer, and `Allocator` is `struct(ctx : ?*void, vtable :
*AllocatorVTable)` (`std/prelude.yo:390-393`). Probe (2026-10-24, v0.2.69), in a file without
`pragma(Pragma.AllowUnsafe)`:

- `make_node :: (fn(name : i32, (alloc : Option(Allocator)) ?= .None) -> Rc(Node))(…)` fails with
  "Raw-pointer-carrying types ('Option(Allocator)') are not available in safe code"; `a : Allocator` fails the
  same way;
- an `Option(Allocator)` return type, a struct field of that type and a local all pass, so only the parameter gate
  is in the way;
- `a.alloc(usize(8))` fails with "Raw pointer values are not available in safe code", so the raw uses stay gated
  without the parameter gate's help. Building an `Allocator` needs a raw vtable pointer as well.

Today every test file that names these types as parameters carries the pragma.

**The change:** the parameter gate treats the prelude's `Allocator`, identified by its definition and not by its
name, as an opaque handle, so `Allocator`, `Option(Allocator)` and a struct holding one pass. **No seed gate:**
std and src never need it (std is unsafe-capable), only safe user code and tests do, and those run on the tree
binary. It lands before B2a, whose examples and tests use it. If it is not adopted, §2.2's `make_node` needs
`pragma(Pragma.AllowUnsafe)`, and §3's "explicit" row must say that passing placement on needs it.

### B1: delete the scope API (v0.2.71; std, tests and docs only)

B1 deletes what §5 lists under "std (B1)". It rewrites or deletes the scope tests (§5) and updates the docs. The
only scope setter left is `rc`/`arc`'s swap around one constructor call. **No seed gate:** std only stops calling
functions and lowers nothing new. It lands in the v0.2.71 window because v0.2.70 is
being cut. On a slip it moves one release, and nothing but B2 waits for it.

### B2: one spelling, no thread-local (v0.2.72, with allocator v2 Generation B)

B2 ships as two PRs:

- **B2a (std and tests).** The containers take `(alloc : Option(Allocator)) ?= .None` on `new`/`with_capacity`
  (`HashMap`, `HashSet`, `Deque`, `StringBuilder`, `ArrayList`). `new_in`/`with_capacity_in` are deleted, along
  with their 44 code lines. `clone_in(a : Allocator)` lands on `ArrayList`, `HashMap`, `String` and
  `StringBuilder`: decision 12's planned API, which is not in std today. It rides allocator v2 Generation B's std
  move, because both rewrite the same buffer-allocation paths. It is not seed-gated, since the default argument
  keeps every `new()` call valid.
- **B2b (codegen).** The deletions §5 lists under "Codegen". B2b merges after V5 Generation A has moved `rc`/`arc`
  onto the cell, because until then the swap needs `__yo_scope_set`. No seed gate: the tree's std no longer names
  the hooks, and src never did.

If V5 Generation A slips to v0.2.73, B2b slips with it. B2a stays at v0.2.72.

### Related: `Box`'s layout (the verdict's §7, maintainer decision 2026-10-24)

Not a placement step, recorded here because the verdict carries it. Today every `Box` cell carries the 16-byte
owner prefix `{ctx, vtable}` (`_BoxOwner`, `_BOX_PREFIX_SIZE`, `std/prelude.yo:9945-9950`), with a `.None` vtable
for the global allocator. `Rc`/`Arc` instead keep their count header with the `__YO_RC_TAG` bit and pay the prefix
only when placed. **Decision:** `Box` adopts `Rc`'s scheme. An 8-byte flags word sits in front of the payload (at
`max(8, align_of(V))`), with the tag bit set only when the box is placed, and only a placed `Box` carries the owner
prefix. A global `Box` goes from 16 bytes of header to 8 (or the payload's alignment). It lands as its own PR right
after allocator v2 Generation B, in the v0.2.72 window, measured (Box allocations, malloc size classes, the
check/compile RSS ratchets) with its own emit-diff. It is std-only if the compiler's `Box` predicate and drop paths
need no change (`unique_box_payload_type` in `src/types/guards.yo`, `src/codegen/exprs/drop_dup.yo`); that is to
be verified in the PR.

### C: the root declaration (after v0.2.75; outside VBD)

- **Generation A (compiler).**
  - Read `global_allocator` from the entry module. The value is a `heap.*` comptime value. The ten codegen and
    build sites that compare an allocator name read its tag: `src/codegen/c/collection.yo:190`, `:197`, `:202`,
    `:267`; `src/codegen/functions/generation.yo:1154`, `:1587`, `:1815`; `src/codegen/functions/gc_runtime.yo:1296`;
    `src/codegen/types/generation.yo:1167`; `src/build_runner.yo:2013`. `src/main.yo`'s flag handling compares the
    name too: the compile path's validation (`:6996`, `:7003`, `:7016`), `:7136`, `:7169` and the link step
    (`:7817`, `:7837`, `:7844`); the test path's validation (`:9075`, `:9080`, `:9093`) and its debug-allocator
    reads (`:9336`, `:9675`, `:9892`, `:9993`). The compile path reads the declaration instead; the test path
    keeps only `debug`.
  - Errors: a declaration outside the root, a value of the wrong type, `heap.Mimalloc` on wasm (today silently
    `system`, `src/main.yo:7169`), and a `heap.Tlsf` region over 4 GiB on a 32-bit target (moved from `:7136`).
  - Add a module-level link-source declaration, so that reaching `std/heap/mimalloc` links
    `vendor/mimalloc/src/static.c`. **Proposed, not decided:** a missing `vendor/` becomes a hard error (today a
    warning and libc, `src/main.yo:7815-7835`), and the emitted C's `__has_include(<mimalloc.h>)` fallback
    (`src/codegen/c/collection.yo:205`) becomes `#error`. That is this plan's reading of the verdict's
    "link-source"; the verdict itself does not address the open question
    `issues/questions/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md` (§10 item 3).
  - `__yo_build_executable` accepts both arities: slot 4 is the allocator and slot 8 the heap size
    (`src/evaluator/builtins/build.yo:1228-1229`; `std/build.yo:355`).
- **std.** `std/heap/{system,mimalloc,tlsf,debug}.yo` plus `index.yo`, the catalog's first face
  (`ZIG_STYLE_ALLOCATORS.md` A1). `heap.Tlsf(region : …, report_at_exit : …)` replaces `--allocator fixed`,
  `--heap-size` and `--debug-heap`. A std use of the link-source builtin waits for a seed that carries it (the
  E0401 rule in AGENTS.md).
- **Generation B (on that seed).**
  - `src/main.yo` declares its allocator, and `build.yo` drops `host_allocator` (`build.yo:39-53`).
  - Deleted: `--allocator` on compile and build, `--heap-size`, `--debug-heap`, `build.AllocatorKind`
    (`std/build.yo:57-78`, default `:146`) and the ten-argument arity.
  - Kept: `yo test --allocator debug`, the one surviving spelling.
  - The sweep covers 13 `--allocator` uses in `test.yml`, 10 in `release.yml` and 2 in `fixpoint-arm64.yml`, 16
    cli-cases, 6 docs files per language, 2 instruction files and 3 skills. `markdown_yo`'s `build.yo` drops its
    two `AllocatorKind.System` lines (16 and 25) in a companion release.
- **Seed steps.** `release.yml:623` and `:1090` run the seed with `--allocator mimalloc`. They keep the flag until
  `SEED_VERSION` carries Generation B, then a follow-up drops it.

## 7. Tests

- **A2.** A safe test file (no pragma) declares `make_node(…, (alloc : Option(Allocator)) ?= .None)` and
  places an `Rc` in an arena; `arena.live_blocks()` counts it. In the same file, `a.alloc(n)` still fails with the
  raw-pointer error.
- **V5 Generation A (the `dyn` obligation, §2.4).** `dyn(rc(Sq(…), alloc : .Some(a)))` makes no global
  allocation: the test counts global allocations under the debug allocator, or reads the emitted C for a single
  cell constructor.
- **B1.** Every surviving placement test uses `alloc :`. `ArrayList.new()`, `HashMap.new()`, `Deque.new()` and
  `box(v)` report `allocator().is_none()`.
- **B2a.** `ArrayList(T).new(alloc : .Some(a))` grows inside `a`. `v.clone_in(Allocator.global())` of an arena list
  lets `arena.deinit()` succeed while the source is dropped.
- **B2b.**
  - The retired question's re-entrant allocator runs `rc(v, alloc : .Some(a))` and `arc(…)` without recursing
    (today rc 139).
  - `dyn(rc(Sq(…), alloc : .Some(a)))` puts exactly one block in `a` (§2.4), and, once the S2 above is fixed, so
    does a closure literal.
  - An emit-diff shows no `__yo_current_allocator` in the C of `src/main.yo`.
- **C.** Each `heap.*` root runs a container, `rc`, `dyn` and `io.async` workload. The three declaration errors and
  mimalloc-on-wasm fail to compile. A cli-case without `vendor/` fails and names the path (if §10 item 3 is confirmed). `yo test --allocator
  debug` fails a leaking test (the existing Z11 case).

## 8. Rejected alternatives

1. **The superseded hybrid** (this file's first draft, 2026-10-24, titled "global allocator and Alloc effect"):
   - what it proposed:
     - keep `with_allocator` as a scoped, always-resuming handler with thread-local evidence;
     - make `clone()` follow the current scope, which reversed decision 12;
     - add a `yo effects` allocation report;
     - add `yo test --leak-check`;
     - place `global_allocator` as VBD riders at v0.2.73 and v0.2.75;
   - why it was rejected:
     - it keeps dynamic scoping, together with both footguns of §0;
     - following the caller lets `clone()` move data into or out of an arena with no mark at the site;
     - the riders shared windows with origins steps 2–3 and the retirement;
     - `--leak-check` was a second spelling of `yo test --allocator debug`.
2. **Zig's threading of an allocator parameter.** About 5,600 of 6,400 definitions would gain a parameter, and
   about 24,500 closures a slot (advisor's counts). Interpolation, tasks and `dyn` would still need a global, so the
   result is "Zig with holes". The parameter buys nothing the owner prefix does not already give.
3. **A declared `Alloc` effect.** It needs function-type and `Dyn` marking (as `ctl` does) and generic bounds that
   spread (a `T`'s `clone` may allocate), and it would mark 88 % of functions. The useful side is the other 12 %:
   §9's `noalloc`.
4. **A `ctl` algebraic `Alloc` effect.** A control-bound value may not be a heap-allocation type parameter or a
   module-level binding (`plans/archive/EXPLICIT_EFFECTS.md:360`, "Handler value unwind-escape restrictions"), so a growable container could not keep the
   allocator its growth needs. Allocation never discards its continuation, so `ctl` buys nothing.
5. **An inferred effect row.** It contradicts the landed explicit-effects decision, and it puts a row on every `dyn`
   and function-pointer type.
6. **`Vec<T, A>`.** Already rejected: there is one `ArrayList(T)` type, and the prefix is its price (VBD "allocator
   interface, version 2", "What stays").
7. **Zig 0.16's `main(init)` handing out `init.gpa` with no global.** It is impossible while interpolation, tasks and
   `dyn` have no slot. The root declaration is the honest equivalent.
8. **Koka's or Odin's implicit context.** It is the same dynamic scoping.
9. **`Dyn.new(f, alloc :)`** (the verdict's B13 item, struck by the coordinator). `dyn` already wraps a placed
   `Rc`/`Arc` without a second cell (§2.4; V5 Generation A keeps it so), so `Dyn.new` would be a second spelling of `dyn(rc(f, alloc : .Some(a)))`.

## 9. Backlog note: `noalloc`

A checked `noalloc` function marker would mark the side that carries information: the 12 % of functions that never
allocate. It would serve real-time code and fixed-region users. A `noalloc` function may call only `noalloc`
functions and may create no block. A `dyn` or function-pointer call is not `noalloc` unless its type says so. It
is designed after decision 43 N1 (`plans/backlog/REFERENCES_AND_ORIGINS.md`), whose function-type machinery it
reuses. Nothing is scheduled.

## 10. Open questions

All of the verdict's questions are decided (its §6, adopted as recommended). Writing and reviewing this plan raised
three more:

1. **The portable-C arm's allocator.** `release.yml:643` emits the portable C with `--allocator system` for a Linux
   triple, while `src/main.yo`'s step-C declaration picks mimalloc on Linux. **Position:** a second root file
   declares `global_allocator :: heap.System;` and runs `src/main.yo`'s `main`. The release emits the portable C
   from that root, so no flag survives for it. Decide in step C's Generation B.
2. **User `ref` types lose placement from B1 until V5 Generation B deletes `ref` (v0.2.74).** A user `ref` object
   could be placed only by the scope. **Position:** accept it. The explicit form is a value struct in
   `rc(v, alloc : .Some(a))`, which is where V5 Generation B moves every `ref` type anyway.
3. **A missing `vendor/mimalloc` under step C** (flagged for the maintainer). The verdict says only "link-source
   for std/heap/mimalloc"; it does not answer
   `issues/questions/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md`. **Position:** that
   question's own recommendation, option 2: a hard error that names the path, and `#error` in the emitted C. The
   question stays open until the maintainer confirms.
