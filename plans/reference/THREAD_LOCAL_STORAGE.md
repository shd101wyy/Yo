# Thread-local storage

**Status:** LANDED 2026-09-17 — `thread_local` in #741 (with #746 fixing the
wasm/emscripten storage class and #749 the effectful-initializer accessor),
shipped in **v0.2.36**, and adopted by `std/rand.yo` in #748, which closes the
`rand.thread_rng` row of `plans/STD_API_STABILIZATION.md`.

Option 1 only: a thread-local may not hold a reference-counted value. Option 3
(keyed storage with a generated destructor) branches on the same condition and
is still unbuilt.

Written 2026-09-10, when the std row it blocked was `rand`'s missing
`thread_rng`. The seed gate it describes is now HISTORY rather than a
constraint: the two-release sequencing played out exactly as written —
`thread_local` shipped in v0.2.36, and `std/rand.yo` adopted it afterwards.

## What landed (2026-09-17)

Evaluator and codegen together behind one build, as the sequencing note below
requires — neither half is independently testable.

| file | change |
| --- | --- |
| `src/expr.yo` | `BK_THREAD_LOCAL` beside the other builtin-keyword strings |
| `src/expr_info.yo` | `register_thread_local` / `is_thread_local`, a SUBSET of `g_module_level_globals` with the same key shape, so `module_global_c_suffix` names storage, flag and accessor identically; the `comptime_expect_error` rollback clears both |
| `src/evaluator/exprs/assignment.yo` | the TYPED form `(thread_local(name) : T) = init`: strip the modifier from the `:` pair's name position and let the typed-binding path run unchanged, then validate module-level position and the RC-free restriction and register |
| `src/evaluator/exprs/initialization_assignment.yo` | the INFERRED form `thread_local(name) := init`: the same strip beside the existing `given(name)` unwrap, with the same two checks and the registry call |
| `src/codegen/functions/generation.yo` | per-thread storage + a per-thread `bool` init flag + an accessor prototype in the declarations section; thread-locals excluded from `__yo_main_module_init`; `emit_thread_local_accessors` emits the lazy accessor bodies. The storage class matches what `src/codegen/async/runtime_core.yo` already emits — `__declspec(thread)` on Windows, `_Thread_local` everywhere else INCLUDING wasm. An earlier revision dropped it on wasm; `wasm32-unknown-emscripten` has pthreads and CI caught every thread sharing one instance |
| `src/codegen/codegen_c.yo` | calls the accessor emitter UNCONDITIONALLY — `generate_main_wrapper` is executable-only, so emitting the bodies there would leave a `--static-library` archive with declared-but-undefined accessors |
| `src/codegen/utils/index.yo` | a thread-local read resolves to `(*name__tl_get())`. The dereference is an lvalue, so the same substitution is valid in write position, which is what lets the rest of codegen keep treating it as an ordinary module-level global |
| `tests/thread.test.yo` | per-thread independence across two spawns, the main thread's instance surviving both, BOTH binding forms (they take different evaluator paths), and the two rejections |

Two decisions worth recording because they are not obvious from the diff:

- **`get_uses_tls` in `src/codegen/` is TRANSPORT-layer security**, not
  thread-local storage — an unrelated use of the same three letters, and the
  first thing that looks like existing machinery to reuse here. There was none.
- **The init flag is set BEFORE the initializer runs.** An initializer that
  reads the same thread-local then sees the zeroed storage and terminates,
  rather than recursing until the stack is gone.
- **The modifier spelling is what makes this cheap.** Wrapping the NAME means
  the LHS stays an ordinary `:` pair (or an ordinary atom, for `:=`), so
  stripping the modifier hands both paths a shape they already handle. The
  first implementation wrapped the whole BINDING (`thread_local(x : T) = v`),
  which put the type inside the modifier, matched none of the three existing
  LHS shapes, and had no `:=` form at all.
- **`thread_local(...)` in a binding NAME position is reserved.** A one-argument
  `thread_local(...)` there must wrap an atom or it is an error, rather than
  falling through — a typo'd declaration otherwise reports
  `Variable "thread_local" not found`, which is exactly the confusing message
  this feature exists to remove.
- **The declaration site must NOT go through the read substitution.**
  `get_variable_name_for_codegen` rewrites a thread-local read to the accessor
  call, which is correct everywhere except where the name is being declared —
  so `emit_module_level_variable_declarations` builds the declaration name
  straight from the sanitized identifier plus the module suffix.

## The problem

Yo has no thread-local storage. `std/rand.yo` records the consequence at the
point where it bites (`std/rand.yo:225`):

> **This is NOT Rust's `thread_rng`, and is deliberately not named that.**

and `plans/STD_API_STABILIZATION.md`:

> `thread_rng`: Yo has no thread-local storage, so per-thread generators are
> not expressible; the doc says to take an own `Rng.from_entropy()` in a hot
> loop instead.

So the process-global generator is shared, and a caller who wants a
non-contended one must construct and carry it. The same absence is why
`std/encoding/html`'s entity tables were an unsynchronised lazy global (a §3
P0 row), and why `Once` exists at all.

## What it blocks

| want | today |
| --- | --- |
| `rand.thread_rng()` — a per-thread generator, no contention, no plumbing | a process-global generator plus advice to construct your own |
| per-thread scratch buffers (a formatter's, a hasher's) | allocate per call, or thread a buffer parameter through |
| per-thread caches in the COMPILER (`src/`) — the evaluator's memo tables are process-global | `_Thread_local` in emitted C, reachable only from codegen |

The third is worth noting: the emitted C runtime already uses
`_Thread_local` (`src/codegen/async/runtime_io_common.yo` declares
`static _Thread_local __yo_poll_t* __yo_active_polls`), so the C-level
mechanism is in the tree and proven. What is missing is a Yo-level spelling.

## Design

### The declaration

A module-level binding marked thread-local, initialized lazily per thread:

```rust
(thread_local(rng) : Rng) = Rng.from_entropy();
thread_local(counter) := i32(0);          // inferred form
```

`thread_local` is a **modifier on the variable NAME**, the way `comptime(v) : i32`
is on a parameter — it wraps the name, not the binding. Both binding forms take
it. (Corrected 2026-09-17: the first implementation wrapped the whole binding,
`thread_local(rng : Rng) = …`, which put the type inside the modifier and did
not compose with `:=` at all.)

- **Module-level only.** A thread-local inside a function has no meaning Yo
  needs, and restricting it keeps the lowering trivial.
- **Lazily initialized, per thread, on first access.** This is what makes
  `Rng.from_entropy()` legal as an initializer — it is a syscall, and running
  it eagerly for every thread at spawn would be both wasteful and a
  first-touch hazard. Rust's `thread_local!` has the same semantics.
- **Access is ordinary.** Reading `rng` reads this thread's instance. No
  `.with(|r| …)` closure dance: Yo has no borrow checker to appease, which is
  the reason Rust needs the closure.

### The lowering

`_Thread_local` on the emitted C global, plus a per-thread `bool` init flag
and the initializer inlined behind it:

```c
static _Thread_local Rng __yo_tl_rng;
static _Thread_local bool __yo_tl_rng__init = false;
static inline Rng* __yo_tl_rng__get(void) {
  if (!__yo_tl_rng__init) { __yo_tl_rng = /* initializer */; __yo_tl_rng__init = true; }
  return &__yo_tl_rng;
}
```

`_Thread_local` is C11 and available on every target Yo ships
(`plans/reference/TARGET_TRIPLES.md`), including the wasm targets — with a
caveat below.

### Destruction

This is the hard part, and the design should NOT pretend otherwise.

A thread-local holding an RC value (`String`, `ArrayList`, any `ref` struct)
must be released when the thread exits, or every spawned thread leaks its
instance. C11 `_Thread_local` has no destructor hook;
`pthread_key_create`'s destructor does, and Windows has
`FlsAlloc`/`FlsSetValue`.

Three options:

1. **Restrict to `Acyclic`, non-RC value types** (integers, floats, plain
   structs of them). No destruction needed, so nothing to get wrong. Covers
   `thread_rng` — `Rng` is a plain state struct — and the scratch-integer
   cases, and nothing else.
2. **`pthread_key_create` + `FlsAlloc` with a generated destructor** per
   thread-local whose type has a `Dispose` or an RC field. Correct, and the
   full feature; it also means every access goes through
   `pthread_getspecific` rather than a direct `_Thread_local` read, which is
   slower.
3. **`_Thread_local` for the trivial case, keyed storage for the rest**,
   chosen by the declared type. Fast where it can be, correct where it must
   be, and the compiler decides — no user-visible difference.

**Recommend (1) first, then (3).** Option 1 closes the `thread_rng` row in a
small, obviously-correct change, and refuses everything it cannot release
with a diagnostic that names the restriction. Option 3 is the eventual shape,
and Option 1's restriction is exactly the condition Option 3 branches on, so
the first is not wasted work.

### WASM

> **This section was WRONG, and the implementation believed it. Corrected
> 2026-09-17 after CI caught it.** It is kept because it is a clean example of
> an unverified claim in a plan doc propagating straight into code: the design
> asserted a conclusion, the implementation encoded it as "an explicit branch
> with a comment, not an accident", and nobody measured it until
> `test-wasm32_emscripten` failed with *"a spawned thread starts from the
> initializer"*.
>
> **What is actually true.** `wasm32-unknown-emscripten` **has pthreads** — Yo
> spawns real threads there, which is why `tests/thread.test.yo` runs on that
> target and only `wasm32-wasip1` carries `pragma(Pragma.SkipWasm32Wasi)`.
> Lowering a thread-local to an ordinary global there makes every thread share
> one instance, which is the exact bug a thread-local exists to prevent — and
> it fails silently anywhere a test does not look.
>
> The tree had already answered the question: `src/codegen/async/runtime_core.yo`
> emits `_Thread_local` for wasm **unconditionally**, and the async I/O runtime
> depends on it. So there is no wasm carve-out: `__declspec(thread)` on
> Windows, `_Thread_local` everywhere else. One branch fewer than the wrong
> version.

~~`emscripten` supports `_Thread_local` only with pthreads enabled;
`wasm32-wasip1` is single-threaded in Yo's configuration. On both, a
thread-local can lower to an ordinary global — correct, because there is one
thread. That must be an explicit branch in codegen with a comment, not an
accident.~~

## Implementation sketch

1. ~~**Parser**~~ — **NO PARSER CHANGE IS NEEDED. Measured 2026-09-17.**

   **(Spelling superseded 2026-09-17 — see the header. The finding survives it:
   the adopted `(thread_local(x) : T) = v` and `thread_local(x) := v` are the
   shapes `comptime(v) : T` and `given(x) := v` already use, so they need no
   grammar change either. The probe below used the original spelling.)**

   `thread_local(counter : i32) = 0;` at module level ALREADY parses on the
   released v0.2.35 seed. It fails at NAME RESOLUTION, not at parse:

   ```
   error[E0401]: Variable "thread_local" not found.
     --> tl_parse.yo:2:1
     | thread_local(counter : i32) = 0;
     | ^^^^^^^^^^^^
   ```

   The form is an ordinary assignment whose LHS is a call expression, which
   the grammar already accepts — the same shape as `(g : T) = v` with a
   named head. So the work is EVALUATOR recognition plus codegen, and the
   parser is untouched.

   **This changes the sequencing story materially.** A new parser form is the
   hardest seed gate there is; this feature does not have one. `std/` adoption
   is still two-release, because the SEED's evaluator must know
   `thread_local` before `std/rand.yo` can use it — but the implementation
   itself is smaller than the plan assumed, and nothing about the grammar has
   to be designed, reviewed or frozen.

   (Probed rather than assumed, which this document's own §4b advises: three
   "Yo has no X" claims in `plans/STD_API_STABILIZATION.md` were measured and
   found false the same way.)

   **The open question here is now ANSWERED: the existing global path CAN
   carry it, as a registry entry rather than a new node type** (surveyed
   2026-09-17 against develop `987c2b420`). `src/expr_info.yo` already has the
   whole mechanism:

   - `register_module_level_global(module_path, name)` — the registry;
   - `is_module_level_global(module_path, name)` — the predicate codegen asks;
   - `module_global_c_suffix(module_path)` — `_m<hash>` appended to the C
     name, hashing the CANONICAL path so the declaration and every read agree
     regardless of which path spelling the resolved variable's token carries
     (this is what closed the unmangled-global-name aliasing defect).

   Codegen already consumes all three — `src/codegen/utils/index.yo:1772` and
   `src/codegen/functions/generation.yo:1142` both append the suffix at a read
   site. So a thread-local wants a SIBLING registry with the same shape
   (`register_thread_local` / `is_thread_local`) reusing the same suffix
   function, not a parallel naming scheme: the C name must stay identical
   between the storage, the init flag and the accessor, and the suffix is what
   already guarantees that.

   That also bounds the codegen change: the read path is the two suffix sites
   above, which is where the accessor call has to be substituted for a direct
   read.
2. **Evaluator** — treat it as a runtime global for typing and name
   resolution; reject a non-module-level declaration; under Option 1, reject
   a type that is not `Acyclic` and RC-free, naming the restriction.

   **Interception point located 2026-09-17** (`src/evaluator/exprs/assignment.yo`,
   `evaluate_assignment`, ~line 313). That function already branches three
   ways on the LHS shape:

   ```rust
   is_atom_lhs           := ast_expr_is_atom(lhs);                                   // x = rhs
   is_typed_binding_lhs  := ast_expr_is_fn_call_of(lhs, BK_COLON, .Some(usize(2)));   // (x : T) = rhs
   // else -> property/index LHS: x.a = rhs, arr(0) = rhs
   ```

   `thread_local(counter : i32) = 0` is a FnCall whose head atom is
   `thread_local` with ONE argument that is itself a `BK_COLON` 2-arg call. It
   matches neither of the first two, so it falls into the property/index
   branch, which evaluates the head and produces the observed
   `E0401 Variable "thread_local" not found`.

   So the change is a fourth shape test beside those two — unwrap to the inner
   colon pair, mark it thread-local, and reuse the existing typed-binding path
   rather than duplicating it. The module-level registration those paths
   already perform (`binding.yo:427`, `initialization_assignment.yo:1076`) is
   where the sibling `register_thread_local` call goes.

   **Sequencing note, and it decides the order of work.** The evaluator change
   is NOT independently testable, even with a build: with no codegen there is
   nothing to run, and `yo check` never evaluates bodies
   ([[yo-check-src-std-are-a-filter-not-a-gate]]). So evaluator and codegen
   want to land together behind one build, not as two separately "verified"
   halves — writing the evaluator half alone buys no verification it would not
   get later, and risks a plausible-but-wrong change that reviews as correct.
   Four mechanisms in adjacent defects were refuted by measurement on
   2026-09-16/17 for exactly that reason.
3. **Codegen** — emit `_Thread_local` storage, the init flag and the accessor;
   route reads through the accessor. ~~Single global on the WASM targets.~~
   (No wasm carve-out — see the WASM section above.)
4. **`std/rand.yo`** — `thread_rng()` returning a pointer/reference to this
   thread's generator, and the module doc's "deliberately not named that"
   paragraph replaced by the real thing.

## Acceptance

- Two threads each drawing from `thread_rng()` produce independent sequences,
  and neither observes the other's state. The test must SPAWN
  (`tests/thread*.test.yo` style) — a single-threaded test proves nothing.
- A thread-local read from the main thread before any spawn works (first
  touch initializes).
- `comptime_expect_error` on a thread-local of a type carrying an RC field,
  under Option 1's restriction.
- The wasm32 legs pass, exercising the single-global branch.
