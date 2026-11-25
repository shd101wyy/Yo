# Allocator placement: global by default, placement by argument

> **Trued 2026-11-07 (plans audit after VBD):** Decided 2026-10-24. Trued 2026-11-07: A1 (#1572), A2 (#1613), B1 (#1614) and B2 (B2a with allocator v2, B2b #1757) have landed, and the `Box` layout L2/L3 ride decision 49 S2 (v0.2.78/v0.2.79). Step C, the root `global_allocator` declaration, has not started; it moved to `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7 (phase C0) on 2026-11-24, with its §6 C, §7 C tests, §9, §10.1 C1–C3 and C5–C7 and §11.2–§11.3. Examples spelled `rc(...)` predate static-argument inference B3: read them as `Rc.new(...)`.

> **Status: Landed (A1, A2, B1, B2); step C moved to `plans/backlog/ZIG_STYLE_ALLOCATORS.md`.** Decided 2026-10-24
> (maintainer adopted the advisor's verdict). A1 is #1572 (merged; it ships in v0.2.70). A2 and B1 are implemented
> for v0.2.71 (branches `vbd/alloc-placement-a2` and `vbd/alloc-placement-b1`, stacked; 2026-10-25). B2a is
> implemented with allocator v2 Generation B (branch `vbd/alloc-v2-gen-b-r2`, 2026-10-28; "As built" under §6 B2).
> B2b is implemented on `vbd/b2b-delete-current-allocator` (v0.2.75, stacked on V5 cells Generation B; "As built"
> under §6 B2). Releases: `plans/handover/VBD_RELEASE_SCHEDULE.md` (revision of 2026-10-24). Line numbers are develop's
> at `82671f612`. The maintainer's criterion: "Yo should be as explicit as possible because it is written by LLMs;
> no backward compatibility; do things right." His answer to the verdict: "Adopt as recommended". This plan
> replaces a same-day first draft (the "hybrid", §8 item 1). It amends `plans/reference/EXPLICIT_ALLOCATORS.md`
> (the scope goes), `plans/backlog/ZIG_STYLE_ALLOCATORS.md` (the catalog is selected by a root declaration) and
> `plans/VALUES_BY_DEFAULT.md` §3.11 (the containers' `alloc` question is decided).
>
> **Superseded 2026-11-05 by `plans/VALUES_BY_DEFAULT.md` decision 49:** `dyn` no longer synthesizes a cell. It
> erases the type behind a pointer the program built, so placement is that pointer's own argument:
> `dyn(Box.new(v, alloc : .Some(a))) : Box(Dyn(T))`, `dyn(Rc.new(v, alloc : .Some(a))) : Rc(Dyn(T))`. The
> correction below and §2.4 describe the model before that decision; there is still no `Dyn.new`.
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
> **Amended 2026-10-25:** the root `global_allocator` is a comptime choice and the instance a compiler-emitted
> static. That design (formerly §6 C, §11.2 and §10.1) is in `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7; §11 below keeps the
> two-faces table and §11.1.

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
   `Arc.new` inherit it (`plans/archive/STATIC_ARGUMENT_INFERENCE.md` A2). The containers take the same
   parameter, so `new_in`/`with_capacity_in` are deleted. A user function that passes placement on declares the
   same parameter, which a safe file can do once step A2 makes `Allocator` an opaque handle (§6).
3. **The global allocator is declared in the root module** (step C, `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7): `global_allocator :: heap.Mimalloc;`. Without a
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
| Which heap the program uses | explicit | the root's `global_allocator` (step C, `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7); `--allocator` until then |
| Every non-global placement | explicit | `alloc : .Some(a)` at the creation site; `clone_in(a)` for a copy |
| That a function allocates | implicit | 88 % of functions do (advisor's 2026-10-24 count), so a marker on 88 % carries no information; `noalloc` (§9; `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.6) marks the other side |
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
| Raw alloc/free misuse under `AllowUnsafe` | UB | still raw; checked under the debug allocator. After step C's C3 (`plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.3), a raw `GlobalAllocator.aligned_free(p, align)` with the wrong `align` mis-routes on Windows (`_aligned_free` against `free`) |
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

**B2b as built (2026-11-03, v0.2.75, right after V5 cells Generation B; Fable consultation #13 Task 2).** The
thread-local `__yo_current_allocator`, `__yo_scopes_ever_entered`, `__yo_scope_current` and the three
`__yo_scope_ctx`/`__yo_scope_vtable`/`__yo_scope_set` hooks are gone from the runtime preamble
(`src/codegen/types/generation.yo`), and with them the mutation summary's scope-slot special case
(`src/evaluator/effects/mutation_summary.yo`). `__yo_rc_alloc_scoped` is `__yo_rc_alloc_in`, called only by a cell
primitive's constructor with the allocator its first parameter carries; a NULL vtable (`alloc : .None`, `{0, 0}`
at the call site and in a comptime cell constant) is the global allocator. Every other RC block is global with no
check: a `ref` struct or enum constructor and `dyn`'s box call `__yo_rc_alloc`, and an `io.async` state machine
comes from its pool (or `__yo_rc_alloc` under the cycle collector) with no placed-task branch. The state machine's
`resume_scope_wrapper` is deleted: the two resume bodies are the resume functions. The boxed-`dyn` clone wrapper
(`src/codegen/functions/dyn.yo`, `_emit_dyn_clone_function`) is a conversion, not a deletion: the fresh cell of a
cell-handle payload gets `__yo_scope_of_object(self_ptr)` as its constructor's explicit allocator, and what the
impl's `clone` allocates itself is global. `__yo_scope_of_object`, `__yo_rc_tag_of` and the
`__yo_rc_owner_ctx`/`__yo_rc_owner_vtable` hooks stay (owner-prefix reads). Gate:
`git grep -nE '__yo_scope_(set|ctx|vtable)' -- std src tests` is empty. Tests (`tests/explicit_allocators.test.yo`):
a `Dyn(_Speak, Clone)` over a placed `Rc` cloned twice keeps all three cells in the placement allocator, and an
allocator whose `alloc` boxes a `dyn` places `Rc.new`, `Arc.new` and a `Dyn` clone without recursing (the clone
recursed before: its wrapper made the allocator current).

**As built, B2a (2026-10-28, branch `vbd/alloc-v2-gen-b-r2`, with allocator v2 Generation B; the v0.2.73
window).**

- `new`/`with_capacity` take the parameter on `ArrayList`, `HashMap`, `HashSet`, `StringBuilder`, and `new` on
  `Deque` (it has no `with_capacity`). `ArrayList.new`'s `ensures` contract follows the defaulted parameter. A placed
  constructor allocates its anchor block at once, as `new_in` did; `.None` allocates nothing, as before.
- `clone_in(a : Allocator)` lands on `ArrayList`, `HashMap`, `String` and `StringBuilder`. `clone()` and `clone_in`
  share one private `_clone_placed(alloc)` per type, so the two cannot drift.
- **No `yo fix` repair.** The plan asks for none, and no published release has a user outside the tree: the
  migration table (`docs/*/EXPLICIT_ALLOCATORS.md` "Containers") is the path. The 21 call sites in tests were
  rewritten by a script, std's own by hand.
- `HashMap._alloc_with_capacity_in(alloc, n)` became `_alloc_with_capacity(n, alloc)`, the one private constructor
  (the sibling tests call it).

### Related: `Box`'s layout (the verdict's §7, maintainer decision 2026-10-24; revised by VERDICTS-29, 2026-11-06)

**The rule (2026-11-06; maintainer-requested advisor consult VERDICTS-29).** Whether a block is placed is one bit, and
every owner stores it in a word it already has: `_capacity`'s top bit for a container, `ref_count`'s top bit for a
counted cell, **bit 0 of the cell pointer for a `Box`**. A global block carries nothing. A placed block carries
`Allocator.alloc`'s layout — a `max(16, align)` prefix ending in the owner record `{ctx, vtable}` — whoever owns
it; its drop reads the bit, then the record, and frees through the owner, telling it the block's size and alignment.

- **`Box(T) :: newtype(_cell : *V)`, 8 bytes.** Every cell is at least 16-byte aligned by construction
  (`__yo_malloc` and the aligned family for a global cell; `a.alloc(…, max(16, align))` for a placed one, whose
  contract is a result aligned to `max(align, 16)`), so bit 0 of the address is free. `Box.new(v)` stores the
  payload address; `Box.new(v, alloc : .Some(a))` stores it with bit 0 set. The payload is `_cell & ~1`, which
  codegen emits at every projection (`b.*`, `b.field`, `&b.*`, `addr_of(b.*)`, a `Box` pattern) and the prelude
  reads in `Drop`, `into_inner`, `allocator` and `Clone`. `Option(Box(T))` keeps the null niche. Under decision 49
  the handle of an unsized `V` is `{ptr, meta}`, the bit in `ptr`, the extent from `meta`.
- **Global cell: `[payload]`, exactly `size_of(T)` bytes** (Rust's allocation). A zero-sized payload allocates
  nothing: the handle is the dangling constant `16` (not the unit-place constant `(void*)1`, whose bit 0 is set),
  the drop runs the payload's `Drop` and frees nothing, and `allocator` is `.None`. `dyn(Box.new(f))` over a
  captureless closure therefore allocates nothing.
- **Placed cell: `[max(16, align) prefix ending in {ctx, vtable}][payload]`**, `max(16, align) + size_of(T)` bytes
  (24 for an `i64`, against 32 with the flags word). The drop frees `span + size_of(T)` at alignment `span` through
  the owner; no extent is stored, the size is static (`size_of_val` for an unsized payload). A placed zero-sized
  payload allocates the 16-byte prefix alone, so that `allocator` can answer — the rule a placed empty `ArrayList`
  follows.
- **A counted cell keeps its 8-byte count header and `__YO_RC_TAG`.** Its placed form also carries a 16-byte extent
  `{size, align}` before the owner (a 32-byte prefix) because `__yo_rc_free(void*)` is type-erased; once decision
  49 S2 types every release path (the handles' `Drop`, `Weak`, `try_unwrap`, `make_mut`) the extent is dropped (L3).
- **Raw round trips.** None exist. When one is added it is `Box.into_raw(b) -> (*T, Option(Allocator))` and
  `Box.from_raw(p, alloc)`; a bare `into_raw -> *T` would lose the owner of a placed box and is rejected.
- **Rejected:**
  - the in-cell flags word (the 2026-10-29 layout below): 8–16 bytes per global cell, 2× for small payloads under
    mimalloc, +50 % for a 24 B payload under glibc;
  - asking the global allocator `owns(ptr)` at drop: libc has no such query, mimalloc's (`mi_check_owned`,
    `mi_is_in_heap_region`) is deprecated in the vendored header and answers "in some mimalloc region", and a
    wrong answer corrupts the heap;
  - a registry of placed allocators: every drop pays, and malloc-backed allocators cannot answer;
  - an address-masked arena header: allocator-specific, and it answers "which" only after "whether";
  - `Box(T, A)`: it reverses placement by argument;
  - a fat handle carrying the allocator: paid by every box, placed or not;
  - a smaller in-cell header: still 8 bytes for an 8-aligned payload;
  - a high tag bit: breaks on 32-bit, wasm32 and pointer-authentication ABIs.
- **Schedule** (VERDICTS-29 Q5; inside the campaign with decision 49, `plans/handover/VBD_RELEASE_SCHEDULE.md` §5f
  decision 30; no `--migrate` mode, since the layout is invisible to source):
  - **L1, compiler:** codegen masks bit 0 at every `Box` payload projection (`src/codegen/exprs/property_access.yo`,
    `src/codegen/exprs/match.yo` and every other `(*cell)` projection of a unique `Box`). v0.2.77, beside decision
    49 S1. Seed-safe: the bit is clear today, so the mask is the identity. Gates: `check ./src`, an emit-diff of the
    compiler's own C showing only the projection sites, the fixpoint, the `Box`/`dyn`/`explicit_allocators`/`rc`
    tests.
    *As built (2026-11-08):* one helper, `box_payload_place_code` (`src/codegen/utils/index.yo`), spells the
    masked place `(*((T*)((uintptr_t)(cell) & ~(uintptr_t)1)))`; the `b.*` projection and the `Box(...)` match
    pattern use it, and every auto-deref, method receiver and `&b.*`/`addr_of(b.*)` reaches the payload through
    them. `tests/box_layout.test.yo` sets the bit by hand and reads and writes through each projection.
  - **L2, std:** the placed bit moves to the handle, a global cell becomes the payload, a ZST box allocates nothing,
    and the `Box` doc comment's layout paragraph is rewritten. It lands INSIDE decision 49 S2's rewrite of `Box`
    over `?Sized` (v0.2.78, Generation B on the v0.2.77 seed), so `Box` is rewritten once: S2 already replaces
    `size_of(T)`/`_align()` with `size_of_val`/`align_of_val` in the same code. Gates: through a recording
    allocator, a placed `Box(i64)` asks `16 + 8` at alignment 16 and a placed `Box(unit)` asks 16; a global
    `Box(i64)` asks 8 and a global `Box(unit)` asks nothing; `dyn(Box.new(<captureless closure>))` allocates
    nothing; the probe below rerun and recorded here; the memory ratchet moves down or holds.
    *As built (2026-11-13, `vbd/d49-s2`):* `Box(V : ?Sized)`'s `new`/`into_inner`/`Default` stay sized; the
    `?Sized` impl reads the handle's first word (`_word`), masks it (`_payload`, which keeps an unsized pointer's
    length or vtable) and frees by `size_of_val`/`align_of_val` (`_free_cell`); `Clone` allocates
    `size_of_val(src)` and writes through `CloneInto`. `tests/explicit_allocators.test.yo`: a placed `Box(i64)`
    asks 24, a placed 64-byte payload 80, a placed `Box(unit)` 16; a global `Box(unit)`'s handle is `16`;
    `into_inner` of a placed box frees through its owner. The `dyn(Box.new(<captureless closure>))` row waits for
    S2's flip (`Box(Dyn)` is still the legacy value), and the RSS probe is not rerun during VBD (no perf gates).
  - **L3, compiler:** a placed `Rc`/`Arc` cell drops its extent once S2 has typed every release path. v0.2.79, or
    with the cycle collector's deletion if its sweep still needs a type-erased free.

**Measured (2026-11-06, v0.2.75 seed against rustc 1.97.1; 4,000,000 live global boxes, peak RSS including the
32 MB handle list).** Under mimalloc, `Box(i64)` 100.6 MB against Rust's ≈ 64 MB (Yo's 16-byte request against
Rust's 8-byte bin), a 24-byte payload 164.1 MB against ≈ 160 MB, a 64-byte payload 352.6 MB against ≈ 288 MB
(80-byte against 64-byte requests). Under glibc, 159.9 / 222.1 / 347.1 MB against Rust's 158.5 / 158.5 / 346.0 MB.
Per cell: a global `Box(i64)` asks 16 bytes (Rust 8) and a placed one 32 (owner 16 + flags 8 + payload 8); a global
`Rc(i64)` asks 16 (Rust's `Rc<i64>` 24) and a placed one 48; a global `Box(unit)` asks 8 (Rust allocates nothing).
`ArrayList`/`String`/`HashMap` are at parity with Rust's global containers; a placed buffer adds the 16-byte prefix.

The 2026-10-24 decision and the 2026-10-29 build below are superseded by the rule above and kept as the record of
the layout v0.2.73–v0.2.77 ship. The 2026-10-24 decision: every `Box` cell then carried the 16-byte owner prefix
`{ctx, vtable}` with a `.None` vtable for the global allocator, and `Box` adopted `Rc`'s scheme — an 8-byte flags
word in front of the payload (at `max(8, align_of(V))`) with the tag bit set only when placed, and the owner prefix
only on a placed `Box` — taking a global `Box` from 16 bytes of header to 8.

**As built (2026-10-29, branch `vbd/box-layout`, stacked on allocator v2 Generation B).** std only: the compiler
knows `Box` through `unique_box_payload_type` (the stamped name and the `_cell : *V` newtype shape, unchanged),
and `Box`'s drop is std's `Drop` impl, so no compiler path reads the layout (a stale comment in
`src/codegen/exprs/return.yo` named the deleted `_box_owner_of`).

- **Global cell:** `[pad][flags : u64][payload]`, the header `max(8, align_of(T))` bytes, flags `0`, from
  `__yo_malloc` (alignment up to 16) or the aligned family above 16 (size rounded up to the alignment).
- **Placed cell:** `Allocator.alloc`'s layout, a `max(16, align_of(T))`-byte prefix ending in the owner record,
  then the header with the placed bit (`_BOX_PLACED`), then the payload. The block is asked for that span as its
  alignment, and the drop tells the allocator `span + header + size_of(T)` and the span.
- **The alignment is read without `align_of`**: `size_of(struct(_pad : u8, _v : T)) - size_of(T)`
  (`_BoxAlignProbe`), because the seed that compiles std leaves `align_of` of a type holding an extern type
  untranspiled (`plans/backlog/SEED_VERSION_AUTOMATION.md`, "`box` asks for its payload's alignment").
- **Measured** (4,000,000 live global boxes, peak RSS; the PR's own binary with its parent's std against its
  std): under mimalloc a `Box(i64)` or `Box(i32)` takes 16 bytes instead of 32 (164.1 MB → 100.6 MB), a 24-byte
  payload 32 instead of 48 (225.6 MB → 164.1 MB). glibc's `malloc` rounds both layouts to the same chunk (a 32-byte
  minimum, 48 for the 24-byte payload), so `--allocator system` programs see no change. A placed `Box(i64)` asks
  its allocator for 32 bytes instead of 24: the owner prefix and the flags word.

### C: the root declaration

Moved to `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7 (phase C0); not started.

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
- **Face 1 (§11.1).** `Counting`, as written there (version 1 now, version 2
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

Moved to `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.6.

## 10. Open questions

All of the verdict's questions are decided (its §6, adopted as recommended). Writing and reviewing this plan raised
three more; items 2 and 3 are resolved, and item 1 moved with step C:

1. **The portable-C arm's allocator.** Moved with step C: `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.3.
2. **User `ref` types lose placement from B1 until V5 Generation B deletes `ref` (v0.2.74).** A user `ref` object
   could be placed only by the scope. **Position:** accept it. The explicit form is a value struct in
   `rc(v, alloc : .Some(a))`, which is where V5 Generation B moves every `ref` type anyway.
3. **A missing `vendor/mimalloc`. Resolved 2026-10-24 (maintainer): a hard error.** The position was
   the question's own recommendation, option 2: a hard error that names the path, and `#error` in the emitted C. It
   landed for `--allocator mimalloc` (`issues/retired/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md`).

### 10.1 Custom allocators: DECIDED 2026-10-25 (maintainer adopted every recommendation)

Only C4 applies to what landed. C1–C3 and C5–C7 govern the global allocator and moved with step C to
`plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.3.

- **C4. A missing `vendor/mimalloc` is a hard error: DECIDED** (maintainer, 2026-10-24; implemented for today's
  `--allocator mimalloc`). This is §10 item 3.

## 11. Custom allocators: what a user writes

Added 2026-10-25, the maintainer's request: "lets be clear how user can define their own custom allocator". The
advisor confirmed the coordinator's answer to "is `global_allocator` a runtime or a comptime variable?", and
sharpened it. **The choice is comptime. The instance is a static that the compiler emits** (`plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.1). The two faces
of a custom allocator use **two interfaces, and each has one rule**:

| Face | What it serves | Interface | Who knows a block's size |
| --- | --- | --- | --- |
| placement (§11.1) | blocks created with `alloc : .Some(a)`, which carry the owner prefix | `AllocatorVTable`: version 1 today, version 2 (aligned `alloc`/`realloc`, sized `free`) from allocator v2 Generation B | std: the prefix and the extent hold it |
| global (`plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.4) | every block created without `alloc :`: untagged, with no prefix and no extent | the `GlobalAlloc` trait: the libc family, with an alignment and an unsized `free` | the allocator itself, as `malloc` does |

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

**`allocator` takes `self : &mut Self`, not `&Self`.** A `&T` parameter reaches C by value (`plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.3 C6), so with
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

Moved with step C to `plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.4 (and the comparison, §7.5).
