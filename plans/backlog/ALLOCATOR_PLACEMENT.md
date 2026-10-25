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
>
> **Amended 2026-10-24 (maintainer decision: `std/arena` deleted).** std ships no arena until
> `ZIG_STYLE_ALLOCATORS.md` A1/A3 land. The examples below use any `Allocator` value `a` instead of an `Arena`;
> §4's arena rows describe the deleted `std/arena` and apply to A3's `ArenaAllocator` when it lands; §5's
> `Arena.scoped` line went with the module; §7's arena tests use a counting allocator defined in the test file.
>
> **Amended 2026-10-25 (the maintainer's question "is `global_allocator` a runtime or a comptime variable?",
> answered by the coordinator and confirmed by the advisor).** The choice is comptime and the instance is a
> compiler-emitted static, like Rust's `#[global_allocator] static`. The global interface is not the placement
> vtable. New §11 says what a user writes for each face. §6 C states the declaration rule, §7 C gains the tests,
> and §10.1 records the maintainer's decisions (every recommendation adopted, 2026-10-25).

## 0. The verdict

`with_allocator(a, f)` is dynamic scoping, the property `plans/archive/EXPLICIT_EFFECTS.md` deleted `given` for.
Under it, a call site such as `ArrayList(T).new()`, `rc(v)`, an interpolated string or `io.async(…)` means two
different things, depending on a caller the callee cannot see. The scope also causes the tree's two live allocator
footguns:

- an allocator callback that allocates re-enters itself
  (`issues/retired/2026-10-21-should-allocator-callbacks-run-outside-the-allocation-scope.md`);
- a task carries an allocator scope across a suspension (`tests/explicit_allocators.test.yo:173`).

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

### 2.1 Today (v0.2.69; compiled and run 2026-10-24, over an `Arena` then, over any `Allocator` value since its deletion)

```yo
{ ArrayList } :: import("std/collections/array_list");
{ StringBuilder } :: import("std/string");
import("std/allocator");

main :: (fn() -> unit)({
  a := Allocator.global(); // or any other `Allocator` value
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

Three blocks live in `a` before the locals die (a counting allocator in place of `Allocator.global()` counts
them, as `tests/explicit_allocators.test.yo` does), and all three go back to `a` when they do. `g` is global.

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

// A placed subcomputation: every placement is visible at its site.
count_nodes :: (fn(tokens : &ArrayList(Token), a : Allocator) -> usize)({
  placed := Option(Allocator).Some(a);
  mut(nodes) := ArrayList(Rc(Node)).new(alloc : placed);
  for(&tokens, t => nodes.push(make_node(t.text.clone_in(a), alloc : placed)));
  nodes.len()
}); // `nodes` and its nodes die here, and every block goes back to `a`
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
directly. Probe (2026-10-24, v0.2.69, over the since-deleted `std/arena`): `r := rc(Sq(side : i32(3)), alloc :
.Some(arena.allocator()))`, then `(d : Dyn(Probe)) = dyn(r)`. `arena.live_blocks()` stays 1, and a call through `d` returns 9. The probe cannot
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
| Arena deinit with a live block | UB (use after free) | no arena in std since 2026-10-24; the deleted `std/arena` panicked (`std/arena.yo:477-487` at `82671f612`), and A3's `ArenaAllocator` keeps that rule; its message named `std/assert.yo:39`, not the caller (`issues/2026-10-24-a-std-panic-reports-the-assert-site-not-the-callers.md`, S3); a compile error once the real arena exists (`ZIG_STYLE_ALLOCATORS.md` §4, origins N2) |
| A stale allocator after its arena died | UB | no arena in std since 2026-10-24; the deleted `std/arena` panicked (generation-stamped states, `std/arena.yo:63-71` at `82671f612`); A1/A3 decide their rule |
| Raw alloc/free misuse under `AllowUnsafe` | UB | still raw; checked under the debug allocator. After step C's §10.1 C3, a raw `GlobalAllocator.aligned_free(p, align)` with the wrong `align` mis-routes on Windows (`_aligned_free` against `free`) |
| An allocator callback allocating "through the scope" | not applicable | today a stack overflow (the retired question's measurement); after B2 impossible, because there is no scope |
| A task placed in an explicit allocator and suspended past that allocator's end | not applicable | today possible (a task keeps its scope); after B1 tasks are always global |
| A cross-thread free into a thread-unsafe allocator | UB | unchanged and documented (VBD "allocator interface, version 2", "Documented, not changed") |
| A forgotten `alloc :` | not applicable: the call does not compile without an allocator | the block lands on the global heap; a performance issue, not a safety one |

## 5. What is deleted

**std (B1):**

- `std/allocator.yo`: `_ScopeGuard` (`:274-285`), `with_allocator` (`:286-311`), `current_allocator` (`:312-321`),
  their exports (`:329-330`) and the comment on the scope hooks (`:61-65`).
- ~~`std/arena.yo:441-445`, `Arena.scoped`, and its import of `with_allocator` (`:40`).~~ Gone with `std/arena`
  (deleted 2026-10-24).
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
  - Read `global_allocator` from the entry module. **The declaration's nature (2026-10-25):** the *choice* is
    comptime, the *instance* is a runtime static the compiler emits.
    - `global_allocator :: <expr>;` binds a comptime **value** whose **type** implements `GlobalAlloc` (§11.2).
      That type can be any type: one of std's `heap.*` or the user's own. A value, not a type, because the value
      carries the configuration and the initial state together (`heap.Tlsf(region : …)`). A parameterless
      allocator is a unit-struct constant (`System :: SystemAlloc();`).
    - The value must be **comptime-evaluable** and **constant-emittable**: no heap value anywhere in it, and a
      pointer only if it is null, a function, or `addr_of` of a `::` constant (all three are valid C static
      initializers; §11.1's `_VTABLE` constant emits as one). The compiler emits it once, as a C static
      initializer (`static <T> __yo_global_allocator = {…};`). It is not assigned in `__yo_main_module_init`:
      module-level initializers run inside that function, in an order no assignment can be guaranteed to
      precede (`src/codegen/functions/generation.yo:1630-1646`), and the runtime's own blocks and C static
      constructors allocate before it runs.
    - **Reaching the live static.** `addr_of(global_allocator)` names `__yo_global_allocator` itself, and std
      exports an accessor for other modules (a counter's `live(state : *Self)` reads through it). A by-value use
      of `global_allocator` is an error: it would copy the initial state. This differs from any other `::`
      constant, whose `addr_of` makes its own static and whose by-value read gives the initial value.
    - **Library builds.** In a library build the six entry points are `extern` declarations and the final
      program defines them, so a block made in the library and freed in the program goes through one
      allocator. A library that declares `global_allocator` is error 1. Today both sides resolve to libc, so the
      mismatch cannot show (the library's runtime helpers are already `static` duplicates,
      `src/codegen/c/collection.yo:259-266`).
    - State that needs runtime setup (a region's headers, an `mmap`, a lock word) is stored in its "not yet"
      form (zero, `.None`), and the allocator initializes it **lazily on its first call**, behind a flag it owns.
      There is no `init` hook (§11.2).
    - Why `::` and not `:=`: the binding is the comptime choice. Untagged blocks must all come from one allocator
      for the life of the process, allocation starts before `main`, and mimalloc is a link decision, so the choice
      can never change at run time. The mutable thing is the static's interior, which only the allocator's own
      methods touch.
  - Codegen: the six `__yo_*` entry points (`src/codegen/c/collection.yo:187-270`, today one `#define` arm per
    `--allocator`) become `static inline` wrappers that call `T`'s `GlobalAlloc` methods directly on
    `&__yo_global_allocator`, with no vtable (§11.2 "Wiring").
  - The ten codegen and build sites that compare an allocator name read its tag: `src/codegen/c/collection.yo:190`, `:197`, `:202`,
    `:267`; `src/codegen/functions/generation.yo:1154`, `:1587`, `:1815`; `src/codegen/functions/gc_runtime.yo:1296`;
    `src/codegen/types/generation.yo:1167`; `src/build_runner.yo:2013`. `src/main.yo`'s flag handling compares the
    name too: the compile path's validation (`:6996`, `:7003`, `:7016`), `:7136`, `:7169` and the link step
    (`:7817`, `:7837`, `:7844`); the test path's validation (`:9075`, `:9080`, `:9093`) and its debug-allocator
    reads (`:9336`, `:9675`, `:9892`, `:9993`). The compile path reads the declaration instead; the test path
    keeps only `debug`.
  - Errors:
    1. `global_allocator` declared outside the entry module, or in a library build (the message names the root).
    2. A value that is not comptime-evaluable, or not constant-emittable (it holds a heap value, or a pointer
       that is not null, a function or `addr_of` of a `::` constant); also a by-value use of `global_allocator`.
    3. A value whose type has no `GlobalAlloc` impl.
    4. `heap.Mimalloc` on wasm (today silently `system`, `src/main.yo:7169`).
    5. A `heap.Tlsf` region over 4 GiB on a 32-bit target (moved from `:7136`).
    6. A `GlobalAlloc` method that allocates through the global allocator: a runtime abort under the debug wrapper
       now, a compile error once §9's `noalloc` exists (§10.1 C5).
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
  E0401 rule in AGENTS.md). `GlobalAlloc` (§11.2) is declared in `std/heap/index.yo`, and the four modules are
  its first implementors. `heap.Tlsf` is `src/codegen/c/allocator_fixed.yo`'s C ported to Yo, the reference
  example of lazy initialization. `GlobalAllocator`'s static surface (`std/allocator.yo:94-176`) then calls the
  declared allocator, and `__yo_aligned_free` takes the alignment (§10.1 C3).
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
  places an `Rc` in a counting allocator defined in the test file, whose count sees it. In the same file, `a.alloc(n)` still fails with the
  raw-pointer error.
- **V5 Generation A (the `dyn` obligation, §2.4).** `dyn(rc(Sq(…), alloc : .Some(a)))` makes no global
  allocation: the test counts global allocations under the debug allocator, or reads the emitted C for a single
  cell constructor.
- **B1.** Every surviving placement test uses `alloc :`. `ArrayList.new()`, `HashMap.new()`, `Deque.new()` and
  `box(v)` report `allocator().is_none()`.
- **B2a.** `ArrayList(T).new(alloc : .Some(a))` grows inside `a`. `v.clone_in(Allocator.global())` of a list in a
  counting allocator leaves that allocator's count at zero once the source is dropped.
- **B2b.**
  - The retired question's re-entrant allocator runs `rc(v, alloc : .Some(a))` and `arc(…)` without recursing
    (today rc 139).
  - `dyn(rc(Sq(…), alloc : .Some(a)))` puts exactly one block in `a` (§2.4), and, once the S2 above is fixed, so
    does a closure literal.
  - An emit-diff shows no `__yo_current_allocator` in the C of `src/main.yo`.
- **C.** Each `heap.*` root runs a container, `rc`, `dyn` and `io.async` workload. The three declaration errors and
  mimalloc-on-wasm fail to compile. A cli-case without `vendor/` fails and names the path (if §10 item 3 is confirmed). `yo test --allocator
  debug` fails a leaking test (the existing Z11 case). Added 2026-10-25 for §11:
  - **A user-written global allocator.** The root declares §11.2's `LiveCount` example and reads the count
    through `addr_of(global_allocator)` (§6 C, "Reaching the live static"). Inside `main`, the count before and
    after a scoped workload is equal. A module-level initializer's allocation shows as a count ≥ 1 at `main`'s
    entry (module globals are never dropped, `src/codegen/c/allocator_debug.yo:18-19`). A spawned thread's
    workload leaves the count unchanged after `join`. A second root uses an allocator with lazily initialized
    state, and its first allocation comes from a module-level initializer.
  - **The declaration rules.** Each of §6 C's errors 1–3 is a compile error with its message: a declaration in a
    non-root module and one in a library build; a value holding a `String`, one holding a pointer that is not
    null, a function or `addr_of` of a `::` constant, and a by-value use of `global_allocator`; a type with no
    `GlobalAlloc` impl. A value holding a function pointer compiles.
  - **A library and a program.** A static library that returns a `String` to a program whose root declares
    `LiveCount` sees the count rise and fall by one: the library's entry points are the program's.
  - **The debug wrapper over a user allocator.** `yo test --allocator debug` over that root reports a leak, and its
    report counts blocks that came through `LiveCount`'s `alloc`. A `GlobalAlloc` whose `alloc` builds a `String`
    aborts with "the global allocator allocated through itself" (error 6).
  - **The hot path.** Under `--optimize 2`, the emitted C of a `heap.System` root calls `malloc` from
    `__yo_malloc` with no indirect call. `check src/main.yo` allocation counts and RSS stay within the
    ratchets.
  - **One family.** A `heap.System` block allocated with `align` 64 is released through the same `free`, which
    `align` routes (a Windows CI job).
  - **A user-written placement allocator.** §11.1's `Counting`, as written there (version 1 now, version 2
    after allocator v2 Generation B), places an `rc` and a container buffer and counts both. Dropping the state with
    a live block panics.

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

### 10.1 Custom allocators: DECIDED 2026-10-25 (maintainer adopted every recommendation)

C1–C5 come from the advisor's design (§11). C6 and C7 came up while the examples were checked against v0.2.70.
Each item states the recommendation the maintainer adopted on 2026-10-25.

- **C1. A value, not a type: DECIDED.** `global_allocator :: heap.X(...)` binds a comptime value whose type implements
  `GlobalAlloc`. **Recommendation:** adopt. A type alone cannot carry `Tlsf`'s region size or `Debug`'s report
  flag. A parameterless allocator is a unit-struct constant, so `global_allocator :: heap.Mimalloc;` reads the
  same as before.
- **C2. `GlobalAlloc` is a separate, unsized interface: DECIDED.** It is the three-function libc family of §11.2
  (`alloc` and `realloc` with an alignment, `free` with the alignment but no size), distinct from the placement
  vtable. **Recommendation:** adopt. A global block is untagged and has no extent, and `__yo_rc_free(void*)`
  (`src/codegen/types/generation.yo:1108`, `:1133`) knows neither its size nor its type. The alternative, a sized
  free for every global block, puts a per-type release path into every `__yo_rc_free` call.
- **C3. `__yo_aligned_free` gains an `align` argument: DECIDED.** **Recommendation:** adopt, as a small std change in
  step C's Generation A, so `GlobalAlloc` stays one family. It also removes the two-family hazard
  (`std/allocator.yo:77-93`) for every allocator except Windows' libc, where `heap.System` routes by `align`.
- **C4. A missing `vendor/mimalloc` is a hard error: DECIDED** (maintainer, 2026-10-24; implemented for today's `--allocator mimalloc` ahead of step C on `fix/mimalloc-missing-vendor-hard-error`). This is §10 item 3.
  **Recommendation:** as there.
- **C5. The re-entry check is runtime-only, under `--allocator debug`, until `noalloc`: DECIDED.**
  **Recommendation:** adopt, and do not delay step C on §9. The debug wrapper keeps a thread-local re-entry flag
  and aborts with "the global allocator allocated through itself". Once `noalloc` lands, every `GlobalAlloc`
  impl is implicitly `noalloc`, and re-entry becomes a compile error.
- **C6. How the `GlobalAlloc` methods reach the static: DECIDED (found while writing).** The advisor's draft
  takes `self : &Self`, as Rust's `GlobalAlloc` does. In Yo today a `&T` parameter reaches C **by value**. The
  probe (2026-10-25, v0.2.70, `--emit-c`): a method `(fn(self : &Self) -> Allocator)` on a one-field struct
  compiles to `f(__yo_t_… __yo_v_self)`, and `addr_of(self)` inside it is `(void*)(&__yo_v_self)`, the address
  of the parameter's copy. So an atomic update through `self` would change a copy of the static, and an address
  taken from `self` dangles. **Recommendation:** each method takes `state : *Self`, a raw pointer to the static.
  This is true on every seed, independent of how decision 43 and V5 lower `&T`. It is also honest: every write
  is already a raw or atomic store under `AllowUnsafe`, and the placement face's `ctx` is the same kind of pointer.
  Do not use `&mut Self`: every thread calls through the one static concurrently, so it would claim an exclusive
  access that does not exist. **This is final, not provisional:** decision 34 lowers `x : &T` to `T x` for a
  small `Copy` `T` permanently, and to `const T*` otherwise, where a write through it is E0908
  (`plans/VALUES_BY_DEFAULT.md:251`, `:2264-2267`, `:2598`). Neither form is a writable address of the static,
  so `&Self` can never be the `GlobalAlloc` receiver. The maintainer confirms the spelling, not a revisit date. Whether the compiler should reject `addr_of` of a `&T` parameter at all is filed as `issues/questions/2026-10-25-should-addr-of-a-borrowed-parameter-be-rejected.md`.
- **C7. Atomics in a `GlobalAlloc` state: DECIDED (found while writing).** The advisor's draft allows
  `std/sync/atomic`. Its types are `atomic(ref(struct((*) : …)))` (`std/sync/atomic.yo:1295`), heap cells, and
  **they stay cells after V5**: V5 Generation A rewrites every `Atomic*` type onto `__yo_atomic_cell(State)`
  (`plans/VALUES_BY_DEFAULT.md:731-734`, `:5456-5461`; `plans/handover/VBD_RELEASE_SCHEDULE.md:219`), which is
  one allocation with the count header (`:615-635`). So a state holding an `AtomicUsize` is never
  constant-emittable, and making one allocates. The supported state for a `GlobalAlloc` is
  `std/libc/stdatomic.yo`'s inline `atomic_size_t` (and its siblings) with the `__yo_atomic_*` externs; a probe
  (2026-10-25, v0.2.70) shows `LiveCount(live : atomic_size_t(usize(0)))` bound with `::` emitting
  `static … __yo_cptr_0 = { .__yo_v_live = 0 };`. §11.2's example uses it. **Recommendation:** add
  `__yo_atomic_fetch_add_size_t`/`__yo_atomic_fetch_sub_size_t` to `std/libc/stdatomic.yo` (today it has only
  load, store, exchange and compare-exchange, `:256-268`, hence the example's CAS loop) in step C's Generation A.
  The alternative, a std inline value-atomic type, is a larger decision that VBD has not taken; it is not needed
  for step C.

## 11. Custom allocators: what a user writes

Added 2026-10-25, the maintainer's request: "lets be clear how user can define their own custom allocator". The
advisor confirmed the coordinator's answer to "is `global_allocator` a runtime or a comptime variable?", and
sharpened it. **The choice is comptime. The instance is a static that the compiler emits** (§6 C). The two faces
of a custom allocator use **two interfaces, and each has one rule**:

| Face | What it serves | Interface | Who knows a block's size |
| --- | --- | --- | --- |
| placement (§11.1) | blocks created with `alloc : .Some(a)`, which carry the owner prefix | `AllocatorVTable`: version 1 today, version 2 (aligned `alloc`/`realloc`, sized `free`) from allocator v2 Generation B | std: the prefix and the extent hold it |
| global (§11.2) | every block created without `alloc :`: untagged, with no prefix and no extent | the `GlobalAlloc` trait: the libc family, with an alignment and an unsized `free` | the allocator itself, as `malloc` does |

A placement allocator is a value the program creates and passes around. A global allocator is a type the root
module names once. One type can implement both faces (`ZIG_STYLE_ALLOCATORS.md`'s "global face and value face"),
but each face is written against its own interface.

### 11.1 Face 1: a placement allocator

A user allocator has three parts: a state struct, three free functions in a module-level vtable, and a method that
packs `{ctx, vtable}` into an `Allocator`. The implementor's file needs `pragma(Pragma.AllowUnsafe)`, for three
reasons. `ctx` is a raw `?*void` that the functions cast to `*State`, `addr_of(_VTABLE)` is a raw pointer, and
writes through `*State` are raw. Nothing else needs the pragma. After A2 (§6), a caller that takes
`alloc : Option(Allocator)` is safe code.

**Today (version 1; type-checked 2026-10-25 with v0.2.70 and the tree's std):**

```yo
pragma(Pragma.AllowUnsafe);
{ GlobalAllocator } :: import("std/allocator");
{ AtomicUsize, MemoryOrder } :: import("std/sync/atomic");
{ ArrayList } :: import("std/collections/array_list");
{ assert } :: import("std/assert");

// The state. `live` is atomic because `free` can run on any thread.
Counting :: struct(live : AtomicUsize);

_alloc :: (fn(ctx : ?*void, size : usize) -> ?*void)({
  s := (*Counting)(ctx.unwrap());
  block := GlobalAllocator.malloc(size);
  cond(
    block.is_some() => {
      unsafe(s.*.live.fetch_add(usize(1), MemoryOrder.Relaxed));
    },
    true => ()
  );
  block
});
_realloc :: (fn(ctx : ?*void, ptr : ?*void, new_size : usize) -> ?*void)(
  GlobalAllocator.realloc(ptr, new_size)
);
_free :: (fn(ctx : ?*void, ptr : ?*void) -> unit)({
  s := (*Counting)(ctx.unwrap());
  cond(
    ptr.is_some() => {
      unsafe(s.*.live.fetch_sub(usize(1), MemoryOrder.Relaxed));
    },
    true => ()
  );
  GlobalAllocator.free(ptr);
});
// One vtable object for the program: the owner prefix stores its address. `::` makes it a
// constant-initialized C static, valid before any module-level initializer runs.
_VTABLE :: AllocatorVTable(alloc : _alloc, realloc : _realloc, free : _free);

impl(
  Counting,
  new : (fn() -> Self)(Counting(live : AtomicUsize.new(usize(0)))),
  allocator : (fn(self : &mut Self) -> Allocator)(
    Allocator(ctx : .Some((*void)(addr_of(self))), vtable : addr_of(_VTABLE))
  ),
  live_blocks : (fn(self : &Self) -> usize)(self.live.load(MemoryOrder.Relaxed)),
  Drop(
    drop : (fn(self : &mut Self) -> unit)(
      assert(self.live.load(MemoryOrder.Relaxed) == usize(0), "Counting dropped with live blocks")
    )
  )
);

main :: (fn() -> unit)({
  mut(c) := Counting.new();
  a := c.allocator();
  n := rc(i32(7), alloc : .Some(a));
  mut(xs) := ArrayList(i32).with_capacity_in(a, usize(8));
  xs.push(n.*);
  assert(c.live_blocks() == usize(2), "the cell and the buffer live in `c`");
});
export(main);
```

**`allocator` takes `self : &mut Self`, not `&Self`.** A `&T` parameter reaches C by value (§10.1 C6), so with
`&Self` the `ctx` would be the address of a copy of `c` that dies when `allocator` returns. The probe
(2026-10-25, `--emit-c`) shows `(void*)(&__yo_v_self)` on a by-value parameter under `&Self`, and
`(void*)(&(*__yo_v_self))` under `&mut Self`, which is `c`'s own address. The advisor's sketch wrote
`(*void)(self)` under `&Self` and has the same defect. The `&mut` receiver also makes the binding `mut(c)`, which
says that something holds the state's place.

**After allocator v2 Generation B (v0.2.72)**, only the three signatures change, and B2a respells the container
(`ArrayList(i32).new(alloc : .Some(a))`):

```yo ignore
{ memcpy } :: import("std/libc/string");

_alloc :: (fn(ctx : ?*void, size : usize, align : usize) -> ?*void)({
  s := (*Counting)(ctx.unwrap());
  block := GlobalAllocator.aligned_alloc(align, size); // `size` already includes std's prefix span
  cond(
    block.is_some() => {
      unsafe(s.*.live.fetch_add(usize(1), MemoryOrder.Relaxed));
    },
    true => ()
  );
  block
});
// One family: `aligned_alloc` blocks are never handed to `GlobalAllocator.realloc`
// (`std/allocator.yo:77-93`), so the block moves by hand, which `old_size` allows.
_realloc :: (fn(ctx : ?*void, ptr : ?*void, old_size : usize, new_size : usize, align : usize) -> ?*void)(
  match(
    GlobalAllocator.aligned_alloc(align, new_size),
    .Some(fresh) => {
      unsafe(memcpy(fresh, ptr.unwrap(), cond((old_size < new_size) => old_size, true => new_size)));
      GlobalAllocator.aligned_free(ptr);
      .Some(fresh)
    },
    .None => .None
  )
);
_free :: (fn(ctx : ?*void, ptr : ?*void, size : usize, align : usize) -> unit)({
  s := (*Counting)(ctx.unwrap());
  cond(
    ptr.is_some() => {
      unsafe(s.*.live.fetch_sub(usize(1), MemoryOrder.Relaxed));
    },
    true => ()
  );
  GlobalAllocator.aligned_free(ptr); // `size` and `align` are exact: a slab or pool needs no header
});
```

**Lifetime.** `ctx` is the raw address of the state. `Allocator` is a two-word `Copy` value, and std also writes it
into every block's prefix, so no reference count or origin can follow it. The rule is a documented contract with a
mechanical backstop. The contract: *the state outlives every block it handed out and every copy of its `Allocator`
value, and it does not move while either exists.* A local that is never moved, a module-level `:=` global or a
`Box` all qualify. The backstop is the `Drop` above. Every `free` arrives through the owner prefix, so `live` is
exact, and a state that dies with `live != 0` panics at the right place. Locals drop in reverse order, so `xs` and
`n` are released before `c`. A3's `ArenaAllocator` keeps the same rule, as the deleted `std/arena` did. Origins
give a compile-time version only to the real arena (`ZIG_STYLE_ALLOCATORS.md` §4), whose handles are not
`Escapable`. An `Allocator` value is escapable by design, so it never gets one. A generation table is not proposed:
it was the deleted arena's, and it only turned a dangling pointer into a late panic.

**Threads.** `Allocator` is `Send + Sync` unconditionally (`std/prelude.yo:399-400`), and that is a promise the
implementor makes. `free` and `realloc` can be called on any thread (an `Arc` dropped elsewhere, a container moved
into `spawn`), so they must be thread-safe, or the value must never cross a thread. `alloc` runs only where the
value is used.

**What an implementor must not do:**

- Touch the prefix. `alloc` returns a raw block of `size` bytes aligned to `align`, and std writes the owner (and,
  under version 2, the extent) in front of the pointer *it* returns. The `size` the implementor sees already
  includes that span.
- Free a block through a different family than the one it came from: `malloc` with `free`, `aligned_alloc` with
  `aligned_free`.
- Allocate through itself from inside a vtable function. After B2 there is no scope, so this happens only if the
  state holds its own `Allocator`, and the result is a stack overflow, as before.
- Keep `Allocator` values past the state's `Drop`, or move the state while one exists.

### 11.2 Face 2: the global allocator

**The declaration** (§6 C): the root module binds a comptime value whose type implements `GlobalAlloc`.

```yo ignore
// The root module.
heap :: import("std/heap");
global_allocator :: heap.Tlsf(region : (usize(64) * usize(1 << 20)), report_at_exit : true);
```

**The trait: the libc family, three functions, an unsized `free`, one family.** The receiver is `state : *Self`,
§10.1 C6's recommendation. The advisor's draft had `self : &Self`, which does not reach the static in Yo today.

```yo ignore
GlobalAlloc :: trait(
  alloc : (fn(state : *Self, size : usize, align : usize) -> ?*void),
  realloc : (fn(state : *Self, ptr : ?*void, new_size : usize, align : usize) -> ?*void),
  free : (fn(state : *Self, ptr : ?*void, align : usize) -> unit)
);
```

- **Shared, never exclusive.** Every thread calls through the one static concurrently, so all mutation is atomic,
  or a raw store under the implementor's own lock, under `AllowUnsafe`. Rust's `GlobalAlloc` takes `&self` for the
  same reason. Yo spells it as a raw pointer because a Yo `&T` is not an address (§10.1 C6).
- **`align` everywhere.** One family serves both `__yo_malloc` (`align = 16`) and `__yo_aligned_alloc`. `free`
  takes `align` so that `heap.System` on Windows can route `align > 16` to `_aligned_free` without a second
  family (§10.1 C3).
- **`__yo_calloc`** is `alloc` plus `memset` in the compiler's wrapper. It is not a trait method: `heap.System`
  loses nothing measurable, and the rule stays small.
- **Unsized `free`.** A global block is untagged and has no extent, and `__yo_rc_free` (`src/codegen/types/
  generation.yo:1108`, `:1133`) knows neither its size nor its type. So a global allocator keeps its own size
  bookkeeping, as `malloc` does. A sized global free would put a per-type release path into every untagged free
  (§10.1 C2).

**State and initialization.** The state is the declared value's fields, constant-initialized. Anything that needs
runtime setup (the TLSF region's headers, an `mmap`, a lock word) is stored in its "not yet" form (zero,
`.None`), and the allocator initializes it **lazily on its first call**, under a once-protocol it owns: a lock,
or a state word claimed by compare-exchange (`uninit → initializing → ready`, with the losers waiting for
`ready`). A bare "initialized" flag is not enough, because two threads can both see it clear and both initialize.
There is no `init` hook. The compiler cannot run one before the runtime's own first blocks, before `__yo_main_module_init`'s
module-level globals, or before C static constructors. mimalloc and Rust make the same choice. `heap.Tlsf` already
works this way in C (`src/codegen/c/allocator_fixed.yo:281-301`: `__yo_fixed_ensure_init` runs on first touch,
inside the `atomic_flag` spinlock every call already holds), and its port to Yo is the reference example.

**What a `GlobalAlloc` method may use.** It may not create any block: no container, no `String`, no interpolation,
no `rc`, no `Mutex` (its cell is a block). That also excludes `std/sync/atomic`'s types, which are heap cells and
stay cells after V5 (§10.1 C7). The method may use `std/libc/stdatomic.yo`'s inline atomics, raw memory,
`heap.Page` as backing (`ZIG_STYLE_ALLOCATORS.md` A1), `heap.System` and `extern` C. It must never back itself with
`GlobalAllocator.*`, which after step C *is* the declared allocator. Step C ships a runtime guard only in the
debug wrapper: a thread-local re-entry flag that aborts with "the global allocator allocated through itself". The
compile-time check is §9's `noalloc`, applied implicitly to `GlobalAlloc` impls once it lands. Without the debug
wrapper, re-entry is unbounded recursion, or a silent deadlock when the method holds its own lock.

**The contract the C wrappers rely on.**

- **Failure is `.None`.** `alloc` and `realloc` return `.None` (NULL) on failure and never panic; the wrapper
  calls `__yo_alloc_fail` (`src/codegen/c/collection.yo:270`), which reports and aborts.
- **Alignment.** The result is aligned to `max(align, 16)`.
- **`realloc` keeps `min(old, new)` bytes** and moves the block if it must; on failure it returns `.None` and
  leaves the old block untouched. The allocator learns `old` from its own bookkeeping (the unsized interface).
- **`free(.None)` does nothing.**
- **`__yo_calloc`** is the wrapper's: it checks `nmemb * size` for overflow (a failure, as above), then calls
  `alloc` and zeroes the block.
- **The static is never dropped.** A `Drop` on the type never runs for the global instance; a type that also
  serves as a placement allocator (§11.1) gets its `Drop` only on its placement values.

**Scope: what the declared allocator serves.** Only Yo's six `__yo_*` entry points: every untagged block, plus
`GlobalAllocator.*`. It does not see libc's own allocations, the runtime's C-side buffers (the Windows TLS shim's
raw `realloc`/`free`/`calloc`, `src/codegen/async/runtime_io_common.yo:2141`, `:2172`, `:2223`; the debug
tracker's tables, `src/codegen/c/allocator_debug.yo:247`, `:326`, `:588`), or any foreign C. A buffer that crosses
into or out of C is freed by the family that made it: `std/env.yo:400-415` hands `realpath` its own buffer for
exactly this reason.

**An example: a global heap that counts its live blocks over `heap.System`.** The method bodies are
the ones type-checked on 2026-10-25 (v0.2.70) as free functions over a module-level `:=` state. The `impl`,
`GlobalAlloc` and `heap` are step C's.

```yo ignore
// counting_heap.yo
pragma(Pragma.AllowUnsafe);
heap :: import("std/heap");
{ GlobalAlloc, SystemAlloc } :: import("std/heap");
{ atomic_size_t, memory_order_relaxed, __yo_atomic_load_size_t, __yo_atomic_compare_exchange_size_t } ::
  import("std/libc/stdatomic");

// Configuration and state in one constant-emittable value: no heap value, no non-null pointer.
LiveCount :: struct(live : atomic_size_t);

_bump :: (fn(cell : *atomic_size_t, up : bool) -> unit)({
  (mut(current) : usize) = unsafe(__yo_atomic_load_size_t(cell, memory_order_relaxed));
  (mut(swapped) : bool) = false;
  while(!swapped, {
    next := cond(up => current.wrapping_add(usize(1)), true => current.wrapping_sub(usize(1)));
    swapped = unsafe(
      __yo_atomic_compare_exchange_size_t(cell, addr_of(current), next, memory_order_relaxed, memory_order_relaxed)
    );
  });
});

impl(
  LiveCount,
  GlobalAlloc(
    alloc : (fn(state : *Self, size : usize, align : usize) -> ?*void)({
      block := SystemAlloc.alloc(addr_of(heap.System), size, align);
      cond(
        block.is_some() => _bump(addr_of(state.*.live), true),
        true => ()
      );
      block
    }),
    realloc : (fn(state : *Self, ptr : ?*void, new_size : usize, align : usize) -> ?*void)(
      SystemAlloc.realloc(addr_of(heap.System), ptr, new_size, align)
    ),
    free : (fn(state : *Self, ptr : ?*void, align : usize) -> unit)({
      cond(
        ptr.is_some() => _bump(addr_of(state.*.live), false),
        true => ()
      );
      SystemAlloc.free(addr_of(heap.System), ptr, align);
    })
  ),
  live : (fn(state : *Self) -> usize)(unsafe(__yo_atomic_load_size_t(addr_of(state.*.live), memory_order_relaxed)))
);
export(LiveCount);

// The root module.
{ LiveCount } :: import("./counting_heap.yo");
{ atomic_size_t } :: import("std/libc/stdatomic");
global_allocator :: LiveCount(live : atomic_size_t(usize(0)));
// `addr_of(global_allocator)` is the running static; `LiveCount.live(global_allocator)` would be an error.
live_blocks :: (fn() -> usize)(LiveCount.live(addr_of(global_allocator)));
```

**Wiring and the hot path.** The calls are direct, with no vtable. The compiler emits
`static <T> __yo_global_allocator = {…};` and, for each of the six names that `src/codegen/c/collection.yo:187-270`
defines today, a wrapper such as
`static inline void* __yo_malloc(size_t n) { return <mangled T.alloc>(&__yo_global_allocator, n, 16); }`. These
wrappers replace the per-`--allocator` `#define` arms. `heap.System`'s `alloc` is one extern call, so under `-O2`
the wrapper folds to `malloc`, and the self-hosted compiler pays nothing. `heap.Mimalloc` is the same struct with
methods that call `mi_*`. Its module's link-source declaration pulls `vendor/mimalloc/src/static.c` into the link
(`src/main.yo:7815`), and §10 item 3 decides what a missing `vendor/` does.

**`yo test --allocator debug` does not replace the declaration.** `heap.Debug` is Z11's tracker. Under the flag,
the compiler emits the debug arm with its backing calls bound to the declared `GlobalAlloc` instead of libc. A leak
report is then still about the user's heap, and the re-entry guard runs on it.

**Errors.** These are §6 C's list, items 1–6.

### 11.3 Comparison

- **Rust.** `GlobalAlloc` on a `static`, with `&self` and a sized `dealloc`. Rust knows every layout statically.
  Yo's untagged RC blocks do not know theirs, hence the unsized `free`. A Rust `&self` is an address and a Yo `&T`
  is not, hence `*Self` (§10.1 C6).
- **Zig.** There is no global allocator at all: every call takes an allocator. That was rejected (§8 item 2)
  because interpolation, tasks and `dyn` have no slot for one.
- **Odin.** An implicit `context.allocator`, the dynamic scoping this plan deleted.
- **C.** Link-time `malloc` interposition replaces every caller's heap, libc's and foreign code's included. Yo's
  declaration replaces only Yo's `__yo_*` entry points (§11.2 "Scope"), as mimalloc's link line does today:
  `vendor/mimalloc/src/alloc-override.c` compiles only under `MI_MALLOC_OVERRIDE`, which the link step does not
  define (`src/main.yo:7815-7833`), and the emitted C renames `__yo_malloc` to `mi_malloc`
  (`src/codegen/c/collection.yo:207-212`).
