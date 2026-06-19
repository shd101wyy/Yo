# Phase 6 (self-host fixpoint): stage-2 self-compile crashes on the full self-source

## Status

**CORE CYCLE CRASH FIXED (2026-06-20, commits a822b16dd + 6ec332472).** The
self-host stack-overflow (rc=138) is resolved: `derive(TypeValue, Clone)` is
replaced with a manual cycle-aware clone (path-based `g_tv_clone_path` guard on
the `EnumT` arm; on a self-reference it returns the FULL enum with SHARED
variant_fields — finite, collectable). Validated: corpus 77/77 zero diffs;
yo-self-bin builds clean; lexer.yo no longer crashes rc=138. `EvalValue` clones
fixed transitively. See `yo-self-phase6-stage2-crash-root.md` (memory) for the
full diagnosis chain that led here (disproved the "memory wall"; eliminated
compare/substitute/enum-finalization by test).

**REMAINING (now reachable since the cycle is fixed):** lexer.yo reaches CODEGEN
and aborts (rc=134) on a SEPARATE pre-existing collection gap:
`get_type_string: no C type name found for <enum:enum_yo_id_5628> (type not
collected before lowering)` — an enum (empty name, id 5628) referenced during
lowering but never registered in `context.types` by the codegen type-collection
pass (collect_type, codegen/types/collection.yo). This is the same CLASS of
per-module codegen gap fixed for token.yo (true/false, enum-monomorphization,
enum `==` dispatch), not the cycle. NEXT: identify enum 5628 (instrument the
`_lookup_named_c_type` failure in codegen/utils/index.yo to dump its variant
names — note: avoid `.to_string()`/label-destructure pitfalls there) and find why
collect_type misses it (likely an enum reached only via a position the collection
walk doesn't cover — a specialized return type, a comptime value's type, or a
generic instantiation).

OPEN (2026-06-19). Phase 5 is DONE (parallelism keystone + Thread.spawn work
end-to-end, corpus 76/76, commit 88d060546). Phase 6's first step — the stage-2
self-compile (`yo-self-bin compile yo-self/main.yo`) — crashes before producing C.

## BREAKTHROUGH (2026-06-20): the crash is a FIXABLE specialization-recursion bug, NOT a memory wall

An **overflow-surviving depth probe** (a temporary global counter in
`_evaluate_expression` that `eprintln`s — and thus flushes — each new maximum
depth) overturned the long-standing "memory wall / needs 24 GB" diagnosis for
PER-MODULE compiles:

- **token.yo** self-compiles to clean C now (after the runtime-operator-dispatch
  fix, commit 590735ea3); peak eval-depth 105.
- **lexer.yo** crashes (rc=138) at eval-depth **107 — IDENTICALLY at 2 GB, 6 GB,
  and 8 GB stacks**. Stack exhaustion scales with stack size; a stack-INVARIANT
  crash depth does not.
- The env var IS honored: token.yo @256 MB crashes at depth 33, @1 GB succeeds at
  max 105 (~8 MB/eval-level). So at 8 GB the eval ceiling is ~1000 levels —
  eval-depth 107 is NOT the eval ceiling. The crash is a SEPARATE, stack-invariant
  (effectively unbounded/cyclic) recursion triggered AT eval-depth 107.

**Crash site (lldb):** frame #0 = `ArrayList(TypeValue).get` (mangled
`fn_yo51ba7706_id_121_get_specialized_T_TypeValue_Self_ArrayList(TypeValue)`),
faulting in its PROLOGUE (giant frame — returns `Option(TypeValue)` by value, and
`sizeof(TypeValue)` is enormous). lldb can only unwind 2 frames (prologue crash).

**Trigger (probe token trace):** depths 92-100 = a repeating `n`/`usize`/`usize`
3-cycle = the `__yo_comptime_fold_range` `n - usize(1)` recursion = the DERIVE
machinery unrolling once per enum variant (the CLAUDE.md derive(Eq)-fold-range
pitfall); then `.variants`/`.`/`v`/`a`/`lhs` = a derived `==` executing at
comptime. So lexer.yo's compile runs derive comptime-folding →
`create_specialized_function_inline` (helper.yo:993), which **deep-clones** the
callee's TypeValues (the auto-generated `clone_specialized_T_TypeValue`, ≈half of
round-3's `sample` profile), iterating an `ArrayList(TypeValue)` via `get` and
recursing unboundedly over a pathological/cyclic TypeValue → overflow in `get`.
(Note `type_to_string`/`_tts` is NOT the culprit — `_tts` already has a depth-40
guard, `types/string.yo:20`; the unguarded recursion is the CLONE.)

**Root (CONFIRMED 2026-06-20):** `create_specialized_function_inline` deep-CLONES
TypeValues with no cycle guard, and the cyclic type is **the compiler's own
recursive `TypeValue` enum**. Chain: instrumenting create_specialized's entry
shows the last specialization before the crash is a generic over
`Bucket(String, FuncCapturedVarInfo)` (the capture-analysis HashMap's bucket).
`FuncCapturedVarInfo` (closure.yo:59) has a field `ty : TypeValue` (and
`value : Option(EvalValue)`). To specialize over that bucket, the clone descends
into the field type `TypeValue` — which AS A TYPE is an `EnumT` whose own variants
hold `Box(Self)` (`Pointer(pointee: Box(Self))`, `result: Box(Self)`, etc.,
definitions.yo:63/70/93) ⇒ a **self-referential EnumT**. Deep-cloning it recurses
forever (iterating each variant's `ArrayList(TypeValue)` field via `get` — the
crash frame). TS shares the EnumT reference (a cycle in the object graph that is
never deep-cloned), so it never loops. token.yo self-compiles because it never
specializes a generic over a `TypeValue`-bearing type; lexer.yo is the first
module whose compilation does (via the capture-analysis `HashMap`). Same class as
the `substitute()` self-referential-trait cycle bug already fixed
(`yo-self-substitute-cycle-guard`, commit 9b67b199), but in the clone-during-
specialize path.

**REFINED (2026-06-20, tested): the recursion is the auto-CLONE, not the compare.**
Added a backstop in `_compat_impl` (the structural type-comparison core,
compatibility.yo:101) bailing to `false` when its shared `visited` list (ArrayList
is `object` ⇒ passed by reference, so it DOES accumulate) exceeds 1000 — under
`require_exact` only. Rebuilt; lexer.yo STILL crashes rc=138 in the SAME frame
(`ArrayList(TypeValue).get`), and the cap never changed behavior ⇒ the comparison
is NOT the unbounded recursion. Reverted the backstop (ineffective). Therefore the
loop is the **auto-generated `clone` of `TypeValue`** (`clone_specialized_T_TypeValue`,
≈half of round-3's sample), which has no cycle guard, cloning the inherently-cyclic
`TypeValue` EnumT (variants hold `Box(Self)`). `spec_ret_ty.clone()` in
create_specialized (helper.yo:1116/1125/1165/1205) and/or the specialized body's
type substitution clone the return/param type, which for the culprit (`yo_id_3835`
over `Bucket(String, FuncCapturedVarInfo)`) transitively contains `TypeValue`.
Can't just drop the `.clone()`: `TypeValue` is a value-type enum, so the multiple
uses genuinely need copies (move semantics).

**ALSO TESTED + REVERTED (2026-06-20): a `substitute` cycle guard.** Added a
path-based (push/pop) `visited_type_ids` guard to `substitute`'s `EnumT` and
`Struct` arms (substitution.yo), mirroring the existing `visited_trait_ids`
TraitT guard, so substitute returns a self-referential struct/enum unchanged on
the recursion path. Rebuilt; lexer.yo STILL crashed rc=138 in the same
`ArrayList(TypeValue).get` frame. Reverted (ineffective). With BOTH the
comparison (`_compat_impl`) and `substitute` guards now ruled out by test, the
unbounded recursion is **purely the auto-generated `derive(Clone)` of an
already-cyclic `TypeValue`** — the cycle exists in the input value before the
clone, and the generated clone (no cycle guard, not user-editable) loops on it.
Neither a compare-side nor substitute-side guard helps because neither is on the
loop. The fix must therefore break the cycle EARLIER (where the recursive type's
self-reference is materialized as a full back-edge instead of a finite-DAG
shell — recursive types are normally shells, so some path during lexer.yo's
specialization resolves one to its full cyclic form) OR replace the specific
`.clone()` of that type in the specialization path with a manual cycle-aware
clone. Both are blocked on PINPOINTING the exact site: lldb only unwinds the 2
prologue frames of the overflow, and the clone is compiler-generated (not in
source to instrument). NEXT TOOLING STEP: instrument `resolve_enum_shell` /
`resolve_recursive_type_ref` / the enum-definition materialization to print when
a recursive self-reference is expanded to its full form during lexer.yo's
compile, to catch where the cycle is created.

**RULED OUT (static analysis): enum finalization is NOT the cycle source.**
`evaluate_enum_type` (enum.yo:662-706) builds the finalized EnumT as a FINITE
one-level DAG: `_patch_self_shell` (enum.yo:180) replaces a self-shell with
`pre_final_ty` ONE level deep, and `pre_final_ty`'s own self-fields stay SHELLS
(empty variants); deeper nesting resolves lazily via `resolve_enum_shell`
(creators.yo:333). So a derived `clone` of the finalized enum is bounded. The
true cycle must form later — when something eagerly RESOLVES the inner shells in
place (each `resolve_enum_shell` returns the full `pre_final_ty`, whose inner is
again a shell that resolves to the full…), producing an unboundedly deep / truly
cyclic value that the derived clone then loops on.

**GLOBAL FIX CANDIDATE: replace `derive(TypeValue, Clone)` (definitions.yo:323)
with a MANUAL cycle-aware `Clone` impl** that, on revisiting a type id already on
the clone path, emits a shell (empty-variant EnumT / empty-field Struct) instead
of recursing. This fixes EVERY `.clone()` site at once (sidesteps having to
pinpoint the specific one). HIGH RISK: `clone` is fundamental and called
everywhere; the manual impl must be byte-for-byte equivalent to the derived clone
for all NON-cyclic types or it regresses the whole compiler. Requires careful
implementation + full validation (corpus 76/76 + check ./std 151/151 + check
./yo-self 227/227) in a focused session. Same idea applies to `EvalValue`.

**THIRD FIX TESTED + REVERTED (2026-06-20): `substitute`-normalize `spec_ret_ty`.**
Re-added the `substitute` cycle guard (`visited_type_ids`, path-based push/pop on
EnumT/Struct) AND normalized `spec_ret_ty` via `substitute(subst_new(), …)` in
`create_specialized` (a cycle-safe structural clone) before the 4 derived
`.clone()` sites. Rebuilt; lexer.yo STILL crashed rc=138. Reverted. CONCLUSION:
the crashing derived clone is NOT `spec_ret_ty.clone()` — it is in the
SPECIALIZED-BODY EVAL (helper.yo ~1209+), which clones the cyclic type at one of
the evaluator's many `.clone()` sites (param/arg types, EvalValues carrying
TypeValues, etc.). Normalizing individual sites is whack-a-mole and does not
scale.

**THE ONLY SCALABLE FIX (next session — large + must validate hard): replace
`derive(TypeValue, Clone)` (definitions.yo:323) with a MANUAL cycle-aware clone.**
This fixes EVERY `.clone()` site at once, including `EvalValue` clones TRANSITIVELY
(derived `EvalValue.clone` delegates to its fields' `.clone()`, so a cycle-aware
`TypeValue.clone` makes `EvalValue.clone` bounded too — no separate EvalValue fix
needed). Recipe:
  - Add `_clone_tv :: (fn(t : TypeValue, visited : ArrayList(String)) -> TypeValue)`
    in definitions.yo (it already imports ArrayList; `box`/`Option` are prelude).
    Mirror `substitute`'s variant-by-variant structure (substitution.yo:93-339) but
    with NO substitution — just reconstruct each variant, using `recur(child,
    visited)` for `Box(Self)` and inline loops with `recur` for `ArrayList(Self)` /
    `ArrayList(ArrayList(Self))`; `.clone()` the non-TypeValue lists
    (ArrayList(String)/usize/bool/i64). 39 variants; the first ~22 are fieldless
    leaves (reconstruct directly). Field ORDER must match definitions.yo EXACTLY
    (esp. `Func`'s 17 positional fields).
  - On EnumT/Struct: `cond(((id.len()>0) && _path_visited(visited, id)) => <SHELL
    with same id+name, empty variants/fields>, true => { visited.push(id);
    <reconstruct with recurs>; visited.pop(); <full> })`. Path-based push/pop so
    sibling repeats of a generic type still fully clone; only a type containing
    ITSELF on the path collapses to a shell (which resolve_enum_shell re-expands).
  - Replace `derive(TypeValue, Clone)` with `impl(TypeValue, Clone(TypeValue),
    clone : (fn(ref(self) : TypeValue) -> TypeValue)(_clone_tv(self,
    ArrayList(String).new())))`.
  - VALIDATE before commit: `bun run build`, diff-test corpus (76/76), `check
    ./std` (151/151), `check ./yo-self` (227/227), then `compile yo-self/lexer.yo`
    (must produce C, no rc=138), then ideally `compile yo-self/main.yo`.
  RISK: the manual clone must be byte-equivalent to the derived one for all
  ACYCLIC types (the guard never fires there). A single wrong field silently
  corrupts the compiler — hence the full validation sweep is mandatory, which is
  why this is a focused-session task, not an end-of-session change.

**NEXT FIX (focused; must keep corpus 76/76 + std 151):**
0. The compat backstop, the substitute guard, AND spec_ret_ty normalization are
   all NOT the fix (three tested-ineffective attempts). Enum finalization is ruled
   out (finite DAG). The crash is the derived clone in the specialized-body eval.
   THE fix is the global manual cycle-aware `TypeValue.clone` recipe above. The fix is a
   cycle-aware CLONE of `TypeValue` used by the specialization path: a manual
   `clone_type_acyclic(t, visited)` that deep-clones but, on revisiting a
   type id already on the path, returns a shell/leaf (mirroring how
   `resolve_recursive_type_ref` keeps recursive refs as finite-DAG leaves), then
   use it for `spec_ret_ty` and any specialized param/body type clone. (Or, like
   TS, restructure so recursive EnumTs are never deep-cloned at all.)
1. Identify the exact pathological/cyclic TypeValue lexer.yo's derive-fold
   instantiates — instrument the clone / `create_specialized_function_inline`
   entry with a depth-guarded type print (bail+print past depth ~200 to survive).
2. Either (a) avoid the deep-clone (share/reuse the TypeValue ref like TS where
   the specialization doesn't actually substitute that sub-type), or (b) add a
   visited-set cycle guard to the TypeValue clone used by specialization. Prefer
   the narrowest change that breaks the cycle without altering specialization
   identity (a blind depth-cap on clone risks producing distinct-but-equal
   specializations → cache anomalies; std 151→17 regressed on a cache-key edit
   before).
3. Validate: corpus 76/76 (diff-test), `check ./std` 151/151, then re-run
   `yo-self-bin compile yo-self/lexer.yo` (should produce C, no rc=138).

## Symptom

- `YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin compile yo-self/main.yo` (the -O0 binary):
  rc=138 (SIGBUS), ZERO output.
- `YO_MAIN_STACK_MB=16384 ... check yo-self/main.yo` (-O0, eval-only, 16 GB stack):
  rc=138, zero output → the crash is in EVAL/module-load of the full self-source,
  not codegen-specific.
- `YO_MAIN_STACK_MB=8192 /tmp/yo-self-rel compile yo-self/main.yo` (the **--release**
  binary, -O2 small frames): STILL rc=138, zero output.

## Key conclusion: NOT (just) deep-recursion stack exhaustion

CLAUDE.md attributes the rc=139/138 deep-recursion crash to -O0 multi-MB frames and
prescribes `--release` (LLVM stack coloring, ~100× smaller frames → 1000s of levels).
Here the **--release binary crashes identically** (rc=138, 8 GB stack), so it is NOT
stack depth — it is a GENUINE crash (null/misaligned access, or a memory/resource
limit manifesting as SIGBUS) triggered by loading+evaluating the ENTIRE self-source
graph in one process. (The --release binary is otherwise healthy: it compiles +
runs the spawn repro → `thread sees 42` / `main done`.)

Note `check ./yo-self` (Phase-3 milestone, 227/227) checks each file in ISOLATION;
`check yo-self/main.yo` loads main + ALL transitive imports together — the harsher
unified load is what crashes.

## lldb backtrace (2026-06-19) — pinned to `get_specialized` frame

`lldb -b -o run -o bt -- /tmp/yo-self-rel compile yo-self/main.yo`:
```
thread #2, stop reason = EXC_BAD_ACCESS (code=2, address=0x300003ff0)
frame #0: fn_yo51ba7706_id_121_get_specialized_T_TypeValue_Self_ArrayList_(enum(Unit,BoolT,Void,Str,Int(...),Float(...),...,Pointer(Box(enum(...))),Array(Box(enum(...)),length,length_var))...)  +4
->  stp x24, x23, [sp, #0x10]   ; (function PROLOGUE — store to the stack)
```
The fault is a WRITE (code=2) at a stack-pointer-relative store in the function
PROLOGUE → a STACK OVERFLOW, in `get_specialized` specialized over the GIANT nested
`TypeValue` enum (the `Self` = `ArrayList(enum(... the whole TypeValue ...))`). It
runs on thread #2 (the `__yo_main_stack` worker that runs `main`; YO_MAIN_STACK_MB
applies to it), yet 8 GB overflowed at --release — so this is NOT ordinary
deep-recursion-with-small-frames. Likely cause: `get_specialized`'s frame holds the
giant `TypeValue`/`ArrayList(enum…)` BY VALUE (a multi-KB+ frame even at -O2), and it
recurses over the deeply self-referential `TypeValue` (`Box(enum(...Box(enum...)))`),
so a moderate depth × giant frame blows the stack — OR it is genuine unbounded
recursion in `get_specialized` for this self-referential type. NOTE: `get_specialized`
(types/...:id_121, the `Type.get_specialized` method) is unrelated to the closure work
— this is a pre-existing self-compile gap surfaced by the harshest input.

## Diagnosis directions (next session)

0. Pin whether it's unbounded vs deep-but-finite. ATTEMPTED: `lldb bt 200` shows only
   frame #0 — lldb cannot unwind past the overflowing prologue (the frame isn't
   established), so depth is hidden. Next: set a breakpoint on `..._get_specialized`
   with a counter, or instrument the Yo `get_specialized` source with a depth guard
   that panics at N to confirm recursion. Inspect the `Type.get_specialized` source
   (types/...:id_121, a generic method specialized over the self-referential
   `TypeValue` enum): look for (a) a missing cycle/base case when recursing the
   self-referential type, and (b) the giant `TypeValue`/`ArrayList(enum…)` passed/
   returned BY VALUE (multi-KB frames) — box it / pass by ref to shrink frames.
   8 GB overflowing at --release points to deep-or-unbounded recursion over the
   self-referential type, OR giant frames × moderate depth.

1. The empty output is the main obstacle. Force-flush / run under a debugger:
   - `lldb -- /tmp/yo-self-rel compile yo-self/main.yo` → backtrace at the SIGBUS;
     `MallocStackLogging=1` / `MallocScribble=1` if it's a heap/UAF.
   - Check Console.app / `~/Library/Logs/DiagnosticReports` for the crash report
     (signal, faulting address, frame).
2. Bisect by input size: `check` progressively larger SUBSETS of the import graph
   (e.g. a driver that imports only lexer+token+parser, then + evaluator, then +
   codegen) to find the module/threshold that triggers it. Distinguishes
   memory-pressure-scales-with-size from a specific-module bug.
3. Rule out OOM/mmap: watch RSS during the run; if it balloons then SIGBUS, it is
   memory pressure (SIGBUS from a failed lazy page-in), not a logic bug.
4. If a specific construct: minimize to a standalone repro (the usual issues/
   workflow) and fix the evaluator/loader.

## UPDATE — 32 GB stack → OOM-kill (rc=137): NOT fixable by more stack

`YO_MAIN_STACK_MB=32768 /tmp/yo-self-rel compile yo-self/main.yo`: rc=137 (SIGKILL =
OS OOM-kill). So at 8 GB it stack-overflows (rc=138) and at 32 GB it exhausts RAM
before finishing → the recursion is pathologically deep (or unbounded). More stack is
NOT the fix.

The crash frame (`get_specialized` = the SPECIALIZED `ArrayList.get`; C comment:
`(ArrayList(u8)) fn(self, index) -> Option(u8)`) is `ArrayList(TypeValue).get →
Option(TypeValue)` — `Option(TypeValue)` is returned BY VALUE, and `TypeValue` is the
huge self-referential enum, so each such frame is large. `get` itself isn't recursive;
it's just where the already-near-exhausted stack tips over during a deep evaluator
recursion (lldb couldn't unwind the caller chain past the overflow).

Important contrast: `check ./yo-self` (Phase-3, 227/227) checks each file in ISOLATION
and is fine; `check`/`compile yo-self/main.yo` loads main + ALL transitive imports in
ONE evaluation, and THAT unified eval recurses deeply enough to exhaust 32 GB. This
smells like either (a) a missing memoization/cycle-guard so a shared self-referential
type (TypeValue) is re-descended combinatorially in the unified load, or (b) a genuine
unbounded recursion triggered only by the full graph, or (c) just-too-deep × the giant
`TypeValue`-by-value frame cost.

### Refined fix directions
1. Determine bounded-vs-unbounded: instrument the hot evaluator recursion (or
   `ArrayList(TypeValue).get`'s caller) with a depth counter that panics at e.g. 5000
   — a panic with a clean Yo stack trace shows the recursive cycle; no panic before
   OOM = genuinely deep, not a single tight loop.
2. Shrink the per-frame cost: `TypeValue` is large + returned/passed by value in
   hot recursive paths (e.g. `Option(TypeValue)` returns, `clone`, `match` temps).
   Boxing more of TypeValue (or returning `*(TypeValue)` in the hottest helpers)
   cuts frame size ~Nx and may bring depth back under a sane stack.
3. Add memoization/cycle-guards to whatever traverses the self-referential TypeValue
   in the unified load (mirrors the substitute() / type_contains cycle guards already
   added elsewhere this port).

### UPDATE — scales with unified-load size (not main.yo-specific)

`YO_MAIN_STACK_MB=4096 /tmp/yo-self-rel check yo-self/codegen/codegen_c.yo` (a large
SUBGRAPH — the whole codegen + evaluator, less main's full graph) ALSO crashes rc=138,
0 "evaluator OK". So the deep recursion is NOT a single main.yo-only construct — it
triggers on any sufficiently large unified load and scales with graph/type count. Small
isolated files (`check ./yo-self` per-file, 227/227) are fine. → strongly favors a
combinatorial re-descent of shared self-referential types (missing memoization in a
type-traversal run per-module during the unified load) and/or genuinely-deep def-time
body-eval recursion across the full call graph, amplified by the giant
`TypeValue`-by-value frame cost. The fix is frame-size reduction (box TypeValue in hot
paths) + memoization/visited-guards on the type traversal, not more stack.

### UPDATE — rebuild-free diagnostics exhausted (both lldb directions blocked)

- `lldb bt` cannot unwind past frame #0 (the overflow faults at the prologue before
  the frame/FP chain is established).
- `lldb memory read -f A -c 8000 $sp` returns only ~21 entries — reading UP the stack
  from `$sp` immediately hits the guard page / unmapped region (the deep frames are in
  the exhausted area), so the repeating-return-address scan can't see the recursion.

So pinning the EXACT recursive function needs depth instrumentation, and a naive
global counter is unreliable here: the def-eval-wall unwinds frequently (trial-eval
swallow), and `unwind` skips a decrement-on-exit → the count leaks upward across many
shallow evals and gives false depth. A correct probe must save/restore depth across
BOTH normal return AND the unwind handler (e.g. in `_evaluate_expression_wrapper`
_expr.yo:898, the per-call exn handler restores `g_eval_depth = saved` before
`unwind`). With that, panic-at-N (on the descent) prints the recursive expr/construct.
Alternatively, address the SYMPTOM: shrink the per-frame cost by boxing/`*(TypeValue)`
in the hottest type helpers (e.g. `Option(TypeValue)` returns) so the same depth fits
— but TypeValue is pervasive, so that is a large, carefully-validated change.

### UPDATE — ruled out the obvious type-traversal recursers

The deep recurser is NOT a naive cyclic type traversal — the usual suspects are
already bounded/guarded: `type_to_string`/`_tts` (types/string.yo) caps at depth 40
(`_d > 40 → "…"`) and doesn't recurse Struct/Enum field types (prints the name);
`are_types_compatible` (compatibility.yo) has a `visited` cycle guard on
Struct/Union/Enum; `substitute` has the `visited_trait_ids` cycle guard. So the deep
recursion is in the EVAL / comptime-execution path (e.g. `_evaluate_expression`
mutual recursion or a comptime fn executing over the unified graph), not a tight
type-structure loop — consistent with the crash being where a deep eval chain happens
to call `ArrayList(TypeValue).get`. Next-session probe should target the eval
recursion (unwind-aware depth guard in `_evaluate_expression_wrapper`) rather than the
type helpers.

## BREAKTHROUGH (2026-06-19) — sampling profiler pins the REAL recursion

The lldb dead-ends were sidestepped with macOS `sample`, which snapshots the live
call tree *while the recursion is still descending* (run with a big stack so it
doesn't crash mid-sample):

```
YO_MAIN_STACK_MB=16384 /tmp/yo-self-bin check yo-self/main.yo & PID=$!
sleep 3; sample $PID 4 -file /tmp/s.txt; kill $PID
```

**The `get_specialized` frame in the old lldb backtrace was a RED HERRING.** The
profiled hot recursion is the EVALUATOR's def-time body-eval path, not a type
traversal. Two facts from the sample:

1. The recursive cycle is:
   `_evaluate_expression → evaluate_function_call → try_to_call_function_with_arguments
   → … → _build_def_time_body_env → _trial_eval_fn_body (body eval) → _evaluate_expression`,
   with `synthesize_types`/`_synthesize_types_impl`, `try_to_implement_function_by_function_type`,
   `find_methods_from_generic_impls`, `get_variables_from_env`, `merge_and_check_envs`
   interleaved. So **def-time body eval is being RE-ENTERED** — evaluating one
   function's body triggers def-time body eval of further functions, descending the
   (cyclic) compiler call graph that only the UNIFIED load makes fully resolvable.
2. **~half the samples are `clone` / `clone_specialized_T_TypeValue_Self_ArrayList` /
   `…_Box`** — every `_build_def_time_body_env` copies the ENTIRE caller env's
   variables (function_type.yo:247-274 loops all frames × all variables, cloning each
   `cv.ty`), and in the unified load that env holds all modules' symbols. So each
   re-entry is a giant frame (huge env clone + TypeValue-by-value) AND the depth is
   the call-graph depth → GBs.

Why per-file `check ./yo-self` (227/227) is fine but `check main.yo` overflows: in
per-file isolation a cross-module callee is a shell/signature, so a call to it
type-checks via its return type; in the unified load the callee's full body is
present, so def-time body eval descends into it (and into ITS callees…).

## Fix lead — TS's `skipSpecialization` + `skipCtfeExecution` + checking-phase flag

TS breaks exactly this recursion (see `docs/SPECIALIZATION_CACHE_PITFALL.md`,
function.ts:885/945): when CHECKING a call it passes
`tryToCallFunctionWithArguments({ …, skipSpecialization: true, skipCtfeExecution: true,
context: { …, isInFunctionCallCheckingPhase: true } })` so the call's result type is
computed WITHOUT executing/specializing the callee body, and the
`isInFunctionCallCheckingPhase` flag PROPAGATES so nested calls also skip CTFE.

yo-self ports the pieces but does NOT honor one:
- `is_in_function_call_checking_phase` exists (context.yo:235), is set during trials
  (function.yo:534) and read in comptime_fn.yo:429. ✓
- `skip_specialization` is honored (helper.yo:2523 `if(!(skip_specialization) && …`). ✓
- **`skip_ctfe_execution` is DISCARDED — helper.yo:1816 `_ := skip_ctfe_execution;`.**
  The parameter is accepted and thrown away, so CTFE/body execution is NOT skipped
  during the checking phase. ✗  ← prime suspect.

NEXT: trace where `try_to_call_function_with_arguments` actually executes the callee
body (post-`synthesize_types`) and gate it on `skip_ctfe_execution ||
ctx.is_in_function_call_checking_phase` (mirroring TS). Also confirm every def-time
body-eval call site enters the checking phase with both flags true. Validate the
corpus stays 76/76 (the flag must not suppress execution that real CTFE needs) AND
that `check main.yo` no longer overflows. CAUTION: this gates comptime execution —
an over-broad gate will regress CTFE-dependent fixtures, so scope to the
checking-phase path only.

Secondary lever if depth persists: `_build_def_time_body_env` copies the whole env by
value every re-entry — share/alias it instead of deep-cloning (cuts frame size + the
clone half of the samples).

## UPDATE (2026-06-19, cont.) — two experiments, root narrowed to specialization-during-validation

Profiled `create_specialized_function_inline` IS in the hot recursion (21 frames in a
3 s sample), so the deep chain is GENERIC SPECIALIZATION. Two fixes attempted, BOTH
reverted (kept 76/76 clean):

1. **Skip def-time body validation during the checking phase** (gate
   `try_to_implement_function_by_function_type`'s body eval on
   `!ctx.is_in_function_call_checking_phase`). REVERTED: no effect — the flag is not
   set on the hot recursion path (the recursion is not reached via the
   checking-phase trial calls).

2. **Port the missing mutual-recursion stack guard.** yo-self's `is_recursive_spec`
   guard (helper.yo:2524) only checked the SINGLE slot `currently_specializing_function`,
   so MUTUAL recursion (f specializes g specializes f — the slot is overwritten by g)
   was not caught — only direct self-recursion. TS tracks the full
   `currentlySpecializingFunctionStack` and checks it with `.some(...)`
   (helper.ts:1852-1857, push/restore 2419-2469). I ported it (helper
   `_func_id_being_specialized` scanning the stack + push/pop the stack at the
   set/restore sites; stack entries need only `original_func_id` since yo-self has no
   stack-based forward-ref — `EvalValue` has no `.clone()`, so the entry's
   `original_func_value` was a `UnitVal` placeholder). RESULT: partial — the eval
   recursion shrank (`_evaluate_expression` 1659→966 samples) but the crash REMAINED,
   AND it regressed `runtime_numeric_cast.yo` to SELF-FAIL (75/76). So the
   mutual-recursion stack is NECESSARY (it is a real TS mechanism yo-self lacks) but
   INSUFFICIENT alone, and its naive form perturbs an existing specialization the
   numeric-cast fixture depends on.

**Refined root cause:** generic specialization (`create_specialized_function_inline`,
which deep-clones the callee env + TypeValues — the clone half of the samples) RUNS
during def-time body validation and recurses a deep chain of DISTINCT specializations
down the compiler's generic call graph. TS avoids this: while CHECKING a call it
passes `skipSpecialization: true` (+`skipCtfeExecution: true`, +
`isInFunctionCallCheckingPhase: true`) so the call's result type is resolved WITHOUT
specializing/executing the callee body. **yo-self DISCARDS `skip_ctfe_execution`
(helper.yo:1816 `_ := skip_ctfe_execution;`) and does not propagate
`skip_specialization` into the calls inside a body being validated**, so each call
fully specializes, cascading.

**Fix plan (do together, validate as one):**
(a) Honor the checking-phase intent: during def-time body validation, calls resolve
    their return type via `synthesize_types` WITHOUT `create_specialized_function_inline`
    — i.e. propagate `skip_specialization`/`skip_ctfe_execution` (or gate
    specialization on `!ctx.is_in_function_call_checking_phase` AND not-validating)
    exactly where TS sets them. Compare TS function.ts:885/945 + the
    `isInFunctionCallCheckingPhase` propagation precisely.
(b) Add the mutual-recursion stack guard (experiment 2) for the genuine recursive
    specializations that remain — but reconcile it with `runtime_numeric_cast.yo`
    (understand why that fixture needs the specialization the stack guard suppressed;
    likely the guard must still allow the FIRST specialization and only short-circuit
    a re-entrant one with identical args).
(c) Secondary: shrink `_build_def_time_body_env`'s whole-env deep clone.
Validate: corpus 76/76 AND `check main.yo` no longer overflows (2 GB stack).

## UPDATE (2026-06-19, round 3) — two constraints that rule out the easy fixes

Investigated fix (a) and the env-share lever; both hit a wall that must be respected:

- **Cannot skip specialization during the def-time body trial.** The trial context
  (`create_function_body_evaluation_context`) SHARES `ctx.expr_info_table`
  (function_type.yo: `expr_info_table : ctx.expr_info_table`). So the def-time body
  eval is NOT throwaway — it is the single pass that populates the ExprInfo (incl.
  specialized callee FuncVals) that CODEGEN consumes. yo-self does validate +
  codegen-metadata population in ONE recursive pass over the call graph. Gating
  `create_specialized_function_inline` on `!is_validating_function_definition` (or the
  checking-phase flag) therefore breaks codegen for every generic call inside a body.
  This is the core reason the recursion can't simply be cut: the specialization chain
  IS the work codegen needs.

- **The env flat-copy is NOT a behavior-preserving target for `snapshot_env`.**
  `_build_def_time_body_env`'s copy (function_type.yo:247-274) does two things: the
  expensive O(unified-env) copy AND a re-bind that forces `is_compile_time_only =
  (variable has a value)` (so valued module globals become comptime in the body env).
  `snapshot_env` (shallow frame share) would keep each variable's ORIGINAL
  `is_compile_time_only`, changing comptime/runtime classification in the body —
  load-bearing (see the std/log.yo `is_reassignable` note in-code). So the env-share
  win requires replicating the is_compile_time_only re-bind on the shared frames (or
  proving TS's variables already carry the right flag at definition and the re-bind is
  itself the divergence to remove).

**Net:** the genuine fix is a COORDINATED change — most likely (1) box/`*(TypeValue)`
the hottest by-value TypeValue paths to shrink the C stack frame so the deep-but-
necessary specialization chain fits (attacks rc=138 directly, the only lever that does
not fight codegen's need for the chain), plus (2) the env-share + is_compile_time_only
re-bind to cut the heap/OOM half, plus (3) the mutual-recursion stack + forward-ref
port for the cyclic specializations. Each needs its own validated rebuild cycle
(~13 min) and must keep the corpus at 76/76; this is a dedicated multi-iteration effort,
not a single rapid edit. Three fixes were attempted this session and ALL reverted to
preserve 76/76 — the working compiler must not be regressed for a partial fix.

## UPDATE (2026-06-19, round 4) — mutual-recursion fix landed; depth is huge/unbounded → suspect the spec cache

- **Mutual-recursion specialization guard + forward-reference PORTED & committed**
  (b2f62e781): yo-self lacked TS's `currentlySpecializingFunctionStack` + forward-ref
  (helper.ts:1985-2010) — it handled only DIRECT recursion (single slot + `recur`).
  Now the stack is pushed/popped around specialization and mutual recursion forward-
  refs the in-progress specialized funcId. Corpus 76/76 (runtime_numeric_cast.yo
  exercises it). **But this does NOT fix the stage-2 crash** — profiling the fixed
  binary shows `_build_forward_ref_funcval` is hit ZERO times on the crash path, so
  cyclic specialization is NOT the crash driver.

- **`--release` ALSO crashes (rc=138, 4 GB) — confirmed with a fresh -O2 build.** This
  rules out the "-O0 giant-frame" explanation: at ~100× smaller -O2 frames, a bounded
  ~514-deep chain (what a 3 s `sample` showed) would fit in well under 1 GB. Crashing
  at 4 GB (and 32 GB OOM, per above) means the recursion is genuinely **thousands deep
  or unbounded**, not deep-but-finite × big frames. The `sample` max-depth (~514) was
  an undercount (tree-merge / mid-descent snapshot).

- **Prime remaining suspect: specialization-cache MISS → re-descent.** Only GENERIC
  calls recurse during validation (non-generic calls resolve their return type from the
  signature without evaluating the callee body; `is_func_generic` gates
  create_specialized_function_inline). So the deep chain is generic specialization
  descending the call graph. With a working cache, each `(func, concrete-args)`
  specializes ONCE and repeats hit the cache — bounding the chain. If
  `_find_specialization_cache` / `compute_compile_time_signature` produces an UNSTABLE
  key for functions over the self-referential `TypeValue` (e.g. freshened type ids per
  specialization, or a key that varies for the same logical type), every repeat call
  re-specializes → unbounded re-descent. This is the OPPOSITE failure of the cache
  COLLISION fixed earlier (see memory yo-self-phase3-hashmap-new-blocker, where a
  name-only struct compare gave false HITS) — here we'd have false MISSES.

  NEXT: instrument `create_specialized_function_inline` to log `(func_id, signature)`
  on cache miss; if the SAME logical specialization recurs with differing signatures
  (or the same signature misses), the cache key is unstable — fix
  `compute_compile_time_signature` to render the self-referential `TypeValue`
  canonically/structurally (id-independent), mirroring how TS keys it. Verify: the
  miss log stops repeating + `check main.yo` completes. Secondary: confirm via a
  depth-counter panic in create_specialized whether depth is bounded (frame-size) or
  unbounded (cache) — a panic at N=2000 with a clean trace settles it.

  REFINEMENT (inspected the key): `compute_compile_time_signature` keys forall type
  args via `value_to_signature_string` → `type_to_string(t)`, which is DETERMINISTIC
  (name-based, depth-capped at 40). So it is NOT a simple key-instability miss; if
  anything the depth-40 cap + name-only struct/enum rendering risks false HITS
  (collisions), which would REDUCE recursion, not cause it. Sample composition:
  `_evaluate_expression` ~971 vs `create_specialized` ~28 ⇒ depth ≈ (specialization
  nesting ~28) × (per-body expression-eval nesting ~18) ≈ the observed ~514. So the
  next step is NOT a cache-key tweak by inspection — it is an INSTRUMENTED run (depth
  counter in create_specialized + cache hit/miss log) to settle bounded-but-huge
  (→ frame-size / box TypeValue) vs unbounded (→ a specific re-descent bug). That is a
  dedicated rebuild-driven investigation; do not blind-edit the cache key (the
  name-only loosening already regressed std 151→17 once — see
  memory yo-self-phase3-hashmap-new-blocker).

## UPDATE (2026-06-19, round 5) — INSTRUMENTED: specialization is bounded; the driver is unbounded EVAL recursion

Added a diagnostic probe in `create_specialized_function_inline` (reverted after): two
STATIC panics — one if the callee's `func_id` already appears on the specializing
stack (a cycle that slipped the mutual-recursion guard), one if specialization nesting
exceeds 300. Ran `check yo-self/main.yo` (4 GB): **NEITHER fired**, yet it still
crashed rc=138. So:

- **Specialization nesting is BOUNDED (< 300)** and **no cycle slips the guard** — the
  mutual-recursion forward-ref (committed b2f62e781) is working; specialization is NOT
  the depth driver. (Consistent with the sample: ~28 `create_specialized` frames vs
  ~971 `_evaluate_expression`.)
- **The driver is the EVAL recursion** (`_evaluate_expression → evaluate_function_call
  → … → _evaluate_expression`), and it is **unbounded/enormous**: a fresh `--release`
  (-O2, ~100× smaller frames) build crashes rc=138 at **16 GB** — at ~90 KB/frame that
  is >100k levels, so the ~514 a `sample` showed was a gross undercount; the recursion
  does not converge.

So the bug is an unbounded EVAL descent that does NOT go through deep specialization.
The most likely mechanism: the function-call **checking phase** (function.yo:525-547
sets `is_in_function_call_checking_phase`; calls `try_to_call_function_with_arguments`
with `skip_specialization: true`) descends into the callee to resolve its return type,
and for the compiler's MUTUALLY-RECURSIVE call graph (evaluate_expression ↔
evaluate_function_call ↔ …) this re-enters without a guard. TS passes
`skipCtfeExecution: true` in the checking phase precisely to stop that descent;
**yo-self DISCARDS it (helper.yo:1816 `_ := skip_ctfe_execution;`)**. So the eval, not
specialization, recurses the cyclic graph forever.

Precise locus (read function.yo:520-547): the recursion is the OVERLOAD-RESOLUTION
trial machinery. `evaluate_other_function_call` sets
`ctx.is_in_function_call_checking_phase = true` and, for EACH candidate, runs
`_trial_call_overload_candidate(cv, ct, call_expr, func_expr, args, env, ctx, …)`. That
trial re-evaluates the call (cloned arg exprs etc.). The in-code comment already notes
this was once "exponential in nested operator-call chains (std/glob.yo never
finished)", fixed by setting the checking-phase flag so nested comptime/macro calls
short-circuit to UnknownVal. The stage-2 self-source evidently hits a case the flag
does NOT cover: the trial re-evaluates argument calls, which re-enter
`evaluate_function_call` → trials → … unboundedly for the mutually-recursive call
graph (and `skip_ctfe_execution` is discarded at helper.yo:1816, so nothing stops the
callee descent).

NEXT (clear, scoped): (1) confirm with an UNWIND-AWARE depth probe in
`evaluate_function_call`/`_evaluate_expression` (save/restore the counter across normal
return AND the trial-eval unwind handler, _expr.yo:898) that panics at N with the
callee chain. (2) Fix in the overload-trial path: a "currently-checking (funcId,arg-
shape)" memo so a candidate trial is not re-run inside its own nested trials, AND/OR
honor `skip_ctfe_execution` to stop the callee body descent — mirror TS
function.ts:822-831 (`isInFunctionCallCheckingPhase` + `skipCtfeExecution` on each
dry-run). Validate: corpus 76/76 (must not break overload resolution — the glob.yo
case) AND `check main.yo` completes.

## UPDATE (2026-06-19, round 6) — DEFINITIVE: bounded-but-deep CTFE × giant frames (NOT unbounded)

Traced the body-eval to the CTFE gate (function.yo:2324): type-hierarchy-return /
comptime-only-return / all-args-are-types / macro functions EXECUTE their body at call
time; runtime-return functions correctly yield `UnknownVal` without it (the 2466
comment, faithful to helper.ts:1731). So the deep recursion is CTFE of the self-
source's mutually-recursive TYPE-returning functions over the self-referential
`TypeValue`.

**KEY PROOF it is BOUNDED, not unbounded:** the TS compiler SUCCESSFULLY compiles
`yo-self/main.yo` — that is exactly how `/tmp/yo-self-bin` is built (eval + CTFE +
codegen, ~5 min, exit 0). So the very CTFE recursion that overflows yo-self-bin
TERMINATES under TS. The recursion is bounded; the earlier "unbounded" reading
(round 5) was wrong.

**Therefore the crash is FRAME SIZE, not recursion count.** TS runs on a huge JS call
stack with tiny frames; yo-self-bin's enormous `evaluate_*` functions
(`evaluate_match` ~9 MB, `evaluate_function_call` ~8 MB at -O0; still multi-MB at -O2
because they are giant inlined matches holding `TypeValue`/`EvalValue` BY VALUE) blow
the C stack at a depth TS's stack absorbs. That is why `--release` (smaller, but still
multi-MB frames) also overflows 16 GB: a few-thousand-deep CTFE × multi-MB/frame > 16 GB.

**THE FIX (frame-size reduction, faithful):** box the large by-value locals in the
hottest recursive evaluator functions so each C frame shrinks ~Nx:
`_evaluate_expression`, `evaluate_function_call`, `evaluate_match`,
`evaluate_begin_expression`, `evaluate_cond` — pass/return `TypeValue`/`EvalValue` via
`Box`/`*(…)` in the hot paths and split the giant match arms into helpers (each helper
frame is independent, so LLVM stack-colors them separately). This is pervasive but
targeted at ~5 functions; it does not change semantics (so corpus stays 76/76) and
mirrors why TS never hits this (JS boxes everything). Secondary: the
def-time-body-env share (round 3) trims the heap half. Validate: corpus 76/76 + check
main.yo completes at a sane stack (e.g. 2-4 GB). NOTE the evaluator deadline (TS
_expr.ts:236) is a TIME limit, not a depth limit — it does not prevent the overflow
because the stack blows before the deadline fires.

## UPDATE (2026-06-19, round 7) — CTFE-execution gate ELIMINATED; recursion is in arg/expr eval

Added a CTFE-execution depth cap (reverted): a `g_ctfe_exec_depth` save/restore around
the comptime/type-return execution gate (function.yo:2336), yielding `UnknownVal` past
a cap of 150. `check main.yo` (4 GB) STILL crashed rc=138, 0 output — UNCHANGED. So the
deep recursion does NOT flow through the call-time CTFE-execution gate.

Also established by reading the control flow: the non-comptime body-eval at
function.yo:~2716 is effectively UNREACHABLE — the comptime gate (2336:
`type||comptime||all_args_types||macro`) always `return(expr)`s, and the runtime path
(2507: `!type && !comptime`) always `return(expr)`s at 2714; their negations can't both
hold. So neither body-eval path (comptime nor the 2716 inline) is the recursion.

**Eliminated so far:** specialization nesting (round 5 probe, bounded <300), the
comptime/type CTFE-execution gate (round 7 cap, no effect), and both call-time
body-eval blocks (unreachable/guarded). **Remaining locus:** the recursion
(`_evaluate_expression → evaluate_function_call → _evaluate_expression`, with
evaluate_match / evaluate_cond / evaluate_begin in the sample) must be ARGUMENT
evaluation (`evaluate_expression_raw` on arg exprs, function.yo:~811/1900/2406), the
CALLEE-expression eval (~1049), or a `_evaluate_expression` construct that recurses —
descending the call graph some other way. Note the round-6 frame-size conclusion still
holds (TS compiles main.yo, so the recursion is bounded; yo-self overflows on giant
frames) — these rounds just keep narrowing WHICH eval recursion is the deep one.

NEXT (now unavoidable): a FLUSHED, UNWIND-AWARE depth probe. (1) Make output flush
(the crash yields 0 buffered output, hiding the phase — wrap with explicit flush or
write progress to a file line-by-line). (2) Increment a global at `evaluate_function_call`
entry, save/restore across the per-call exn handler (_expr.yo:898 restores before
`unwind`), panic at N printing the callee chain. That pins the exact recursive
construct, after which the fix is either a re-entrancy guard there OR the round-6
frame-size reduction (box TypeValue) on the specific hot functions involved.

## UPDATE (2026-06-19, round 8) — CONFIRMED recursive cycle from the sample tree

Traced the deepest chain in the existing `sample` output frame-by-frame. The recursive
cycle is:

```
evaluate_function_call
  → (CTFE body execution) evaluate_begin_expression
     → evaluate_cond / evaluate_match / evaluate_initialization_assignment
        → evaluate_expression_raw → _evaluate_expression_raw_wrapper → _evaluate_expression
           → evaluate_function_call   (repeat)
```

i.e. CTFE-executing a callee body (`evaluate_begin_expression`) whose statements
(cond/match/init-assignment) contain more calls, each descending the self-source's
mutually-recursive type/comptime call graph. The ONLY `evaluate_begin_expression` call
in `evaluate_function_call` reachable here is via the comptime/type CTFE-execution
path, so the recursion does flow through it.

Re-evaluating round 7: the CTFE-cap experiment was INCONCLUSIVE, not a disproof — each
CTFE level is ~15-20 stack frames (begin+cond+match+init+identifier+call), so only
~40 CTFE levels fit a 4 GB stack, and the cap was set at 150 (never reached before
overflow). A cap low enough to fire (≈25-30) would, however, also be below plausible
legit CTFE depth, so it is a stack-vs-correctness band-aid, not the fix.

**This fully confirms the round-6 root cause:** bounded CTFE recursion (TS compiles
main.yo, so it terminates) overflowing yo-self-bin's stack because the per-level frames
are enormous (`evaluate_function_call` ~8 MB, `evaluate_match` ~9 MB at -O0; multi-MB at
-O2). **The faithful fix is frame-size reduction** in exactly these hot functions —
`evaluate_function_call`, `_evaluate_expression`, `evaluate_match`,
`evaluate_begin_expression`, `evaluate_cond`, `evaluate_initialization_assignment`:
box the large by-value `TypeValue`/`EvalValue` locals and extract the big NON-recursive
match arms into helpers so -O0 stops allocating their slots in the recursive frame.
Equivalent alternative: a yo-self CODEGEN change to reuse/colour stack slots across
match arms (so even -O0 frames shrink), which would fix this class globally. Both are
large, semantics-preserving changes touching the hottest evaluator code; corpus must
stay 76/76 at each step. No further diagnosis is needed — this is the implementation.

## UPDATE (2026-06-19, round 9) — gate-narrowing ruled out; frame-size is the ONLY fix

Considered narrowing yo-self's CTFE-execution gate (function.yo:2324,
`is_type_hierarchy_type || callee_result_is_comptime || all_args_are_types || macro`)
to match TS, which executes the body only for `isCompileTimeOnly` (helper.ts:1751) +
macro. Ruled out:
- `callee_result_is_comptime` IS `result_is_comptime_only` = TS's `isCompileTimeOnly`
  (faithful, 1:1).
- `all_args_are_types` (type-constructor instantiation, `HashMap(String,X)`) is already
  recursion-guarded (finite SomeT-leaf placeholder, per the in-code comment), so it is
  not the unbounded path.
- The self-source's deeply-recursing functions are LEGITIMATE type-computing functions
  (return Type / comptime) — TS CTFE-executes the same ones and terminates. So they
  fire via `callee_result_is_comptime` regardless; removing `is_type_hierarchy_type`
  either does nothing (flag still fires) or, if the flag has a gap, routes them to the
  UnknownVal path and BREAKS type resolution. Not a divergence, not a fix.

**Every surgical alternative is now eliminated** (specialization depth, spec cache,
CTFE-execution gate value, missing memo [TS has none], gate-narrowing). The CTFE of the
self-source's type functions is correct and matches TS; it simply recurses deep enough
that yo-self-bin's multi-MB per-level frames overflow the stack where TS's tiny JS
frames don't. **The only remaining fix is frame-size reduction** — and it must be done,
not designed-around:
  (1) split `evaluate_function_call`'s giant FuncVal arm sub-blocks (the comptime-exec
      2324 block, the runtime/spec 2480 block, the inline body-eval) into separate
      functions so -O0 stops co-allocating every arm's temporaries in the recursive
      frame; likewise `evaluate_match` / `_evaluate_expression` arms; OR
  (2) a yo-self CODEGEN change so emitted C reuses stack slots across mutually-exclusive
      match arms (fixes the whole class at once).
Both are large, semantics-preserving, and must hold corpus 76/76 at every increment —
a dedicated effort with its own build/validate budget. No diagnosis remains.

## UPDATE (2026-06-19, round 10) — MEASURED frame sizes + the two concrete fix options

Compiled the generated C (`/tmp/yo-self-bin4.c`) with `clang -O0 -c
-Wframe-larger-than=500000` to get REAL frame sizes. The recursive-path offenders:

| function | -O0 frame |
|---|---|
| `evaluate_function_call` | **13.1 MB** |
| `evaluate_match` | **10.4 MB** |
| `evaluate_property_access` | 8.1 MB |
| `evaluate_cond` | 2.9 MB |
| `evaluate_initialization_assignment` | 2.3 MB |
| `evaluate_begin_expression` | 1.8 MB |

The recursive cycle (`evaluate_function_call → evaluate_match/cond → evaluate_begin →
…`) sums to ~28 MB/level, so ~150 levels overflow 4 GB — matching the observed crash.

Confirmed temps ARE already block-scoped: begin blocks emit `{ … }` (begin.yo:136/200),
cond emits branch braces (cond.yo:368+), and match arms wrap each case body in `{ … }`
(match.yo:352-358). So the giant frames are NOT from missing scoping — they are
`sizeof(EvalValue)`/`sizeof(TypeValue)` (large by-value tagged unions) × the many
distinct temp slots these huge match functions hold. `-O2` coloring cannot shrink
`sizeof`, which is why `--release` still overflows (a TS-bounded depth × multi-MB
frames).

**Two concrete fix options (pick one; both are large + semantics-preserving, corpus
must stay 76/76 at every step):**
1. **Split the giant match functions.** Extract `evaluate_function_call`'s arms/sub-
   blocks (FuncVal comptime-exec / runtime / body-eval, plus TypeVal etc.) and
   `evaluate_match`'s/`evaluate_property_access`'s arms into separate helper functions,
   so each function holds far fewer temp slots and the recursive path's per-level frame
   drops from ~13+10 MB to the small active-helper frames. Highest-impact targets first:
   `evaluate_function_call` (13 MB) and `evaluate_match` (10 MB).
2. **Shrink `sizeof(TypeValue)`/`sizeof(EvalValue)`.** If the tagged unions inline large
   variants, route more variants through `Box`/pointer so every by-value slot shrinks
   ~Nx at once — fixes the whole class globally but touches the core data model.

Diagnosis is now fully quantified; this is purely an implementation task. Diagnostic
recipe for the next session: `clang -O0 -c -Wframe-larger-than=500000 <emitted>.c -o
/dev/null 2>&1 | grep 'stack frame size'` to re-measure after each extraction.

## UPDATE (2026-06-20) — memory investigation: why yo-self needs ≫ TS, and what's fixable

User question: TS compiles `main.yo` fine (~1 GB), so yo-self shouldn't need >24 GB.
Correct — it's a memory-efficiency gap, not an inherent need. Hard data gathered:

- **This machine has 16 GB RAM.** The unified `main.yo` self-compile overflows at a
  24 GB stack request (rc=138; 31.8 GB peak footprint) — so it needs >24 GB, which
  16 GB cannot provide.
- **TS's max `evaluateExpression` recursion depth compiling `main.yo` is only ~100-200**
  (instrumented `src/evaluator/exprs/expr.ts`, reverted). yo-self overflows even 24 GB
  → at ~25-40 MB per recursion level it implies a depth of **several hundred**, i.e.
  yo-self recurses **meaningfully deeper than TS for the same compilation** (a divergence).
- **Per-frame cost is huge and `-O2` does NOT shrink it.** Measured `-O0` frames:
  `evaluate_function_call` 13.1 MB, `evaluate_match` 10.4 MB, `evaluate_property_access`
  8.1 MB. A fresh `--release` (-O2) build still overflows at 12 GB — coloring can't
  reuse these slots (function-spanning lifetimes). TS's JS frames are ~1 KB; yo-self's
  are MB-scale (monolithic match functions, `TypeValue`/`EvalValue` by value). That is
  ~10⁴× per frame.
- **Per-module self-compile WORKS** (`token.yo` → valid C after the `true`/`false` fix);
  only the full unified `main.yo` (every transitive module in one eval) is memory-blocked.

So the gap is TWO compounding divergences vs TS: (a) ~10⁴×-larger per-frame stack cost
(monolithic functions + by-value structs), and (b) deeper recursion (yo-self CTFE-eval
is several-hundred deep vs TS's ~150 for the SAME type computations).

**What was tried (this round):**
- Frame extraction (runtime branch + forall loop → helpers): `evaluate_function_call`
  13.1 → 10.8 MB. Correct + committed, but ~1 MB/extraction — too slow to close a
  multi-MB × hundreds-of-levels gap by extraction alone.
- `--release` (-O2 coloring): ~2× at best; still overflows 12 GB.
- Deferring CTFE execution during def-time body VALIDATION (gate on
  `!is_validating_function_definition`, macros exempt): **no effect** — proving the
  deep recursion is the REAL CTFE execution (`is_validating=false`), the same path TS
  takes, just ~4× deeper. Reverted.

**The actionable lever (next):** the depth divergence. yo-self's CTFE eval recurses
~hundreds deep where TS does ~150 for identical type computations. Candidate causes to
investigate: (1) yo-self lacks an eval-result/CTFE memo TS has, so shared type
sub-computations re-descend; (2) the eval-dispatch indirection (`evaluate_expression_raw
→ _evaluate_expression_raw_wrapper → _evaluate_expression`) adds frames per logical
step; (3) a type-representation difference yielding more nested calls. Pinning it needs
an unwind-aware depth probe in `evaluate_function_call` whose output survives the
overflow (cap-to-survive, since stack-overflow discards buffered output). Reducing
yo-self's CTFE depth toward TS's ~150 would shrink the stack enough to fit — the
highest-leverage fix, and it directly answers the user's "should be ≈ TS".

## UPDATE (2026-06-20, per-module path) — enum-monomorphization collision (option b blocker)

Self-compiling a single module (`token.yo`) succeeds memory-wise (rc=0) but emits
INVALID C (~6 distinct codegen bugs). The root/highest-value one: **generic enum
instantiations collapse onto one C type.** yo-self emits **6 enum structs where TS emits
16** for token.yo. Concretely: `ArrayList(Token).get` and `ArrayList(u8).get` (distinct
specializations `yo_id_3835_…struct_6668…` / `…struct_3812…`) BOTH return the same
Option C enum `__yo_enum_yo_id_3832`, whose `Some.value` field is typed `uint8_t` — so
`Option(Token)` is assigned a `Token` into a `uint8_t` slot → C type error.

Root: `type_key` (codegen/utils/index.yo:640) keys an `EnumT` by its definition `id`
(`__yo_enum_yo_id_3832`), which is SHARED across all `Option(T)` instantiations. So
`type_key(Option(Token)) == type_key(Option(u8))` → same C name + same collected type
(`.value` from whichever T was collected first, here u8). TS keeps them distinct
(structural key incl. variant field types → 16 enums). The `true`/`false` fix
(commit 1d2d5aa9) removed one of token.yo's bugs; this enum collision is the next.

FIX (focused, must keep corpus 76/76): distinguish generic enum (and likewise struct)
INSTANTIATIONS — either make `type_key` for EnumT include the variant field types
(e.g. `id + structural-suffix`, so `Option(Token)` ≠ `Option(u8)` while a non-generic
enum's suffix is constant and still shares), OR ensure instantiated enums receive a
per-instantiation id at evaluation (the corpus's generic enums evidently DO get distinct
ids — only some self-source instantiations reuse the definition id, so identify why
Option(T) here reuses 3832). RISK: `type_key` drives BOTH C-name lookup AND type
collection, so the change must be consistent across both, validated incrementally
against the corpus. This is the path to module-by-module self-host (option b), which
sidesteps the unified-load memory wall entirely.

## UPDATE (2026-06-20, per-module path PROGRESS) — enum-monomorphization FIXED

Pursuing option (b) (module-by-module self-host, memory-feasible). Progress on
token.yo's codegen bugs:

- ✅ **`true`/`false` literal mangling** — FIXED (commit 1d2d5aa9).
- ✅ **Enum-monomorphization collision** — FIXED (commit af865895f). `type_key` now
  appends EnumT variant field types, so `Option(Token)` ≠ `Option(u8)` (was: both →
  one C enum with `Some.value : uint8_t`). Corpus 76/76, the `ArrayList(Token).get`
  type error is gone. yo-self enum C names now carry instantiation suffixes
  (`__yo_enum_yo_id_3891_usize`).

Remaining token.yo codegen bugs (next, each surfaces in the emitted C):
1. **enum-value `==` variant → "Failed to transpile"** (the structural-error cascade
   root). `start_kind == TokenKind.LCurlyBracket` is not primitive-infix
   (`_is_primitive_infix_operator` false for enums) and
   `generate_other_function_call` returns None → emits an inline `// Failed to
   transpile` comment that breaks the surrounding C expression (→ "expected ')'",
   "while loop outside of a function", "extraneous '}'" cascade). Needs enum equality
   codegen (tag compare for fieldless enums; the corpus's working enum `==` paths
   suggest a specific gap when the RHS is a bare variant literal). generation.yo:474.
2. **`stat` / `start` collisions** — a variable named `start` and a libc symbol
   collision (`int (*)(const char *, struct stat *)`), and `redefinition of 'i'` —
   identifier-collision / shadowing codegen issues.
3. Undeclared temps (`_file____User_temp_700x`) — cascade artifacts of (1).

Fixing (1) should clear most of the structural cascade. These are the standard
"Phase-6 wave" codegen gaps, now being cleared one validated fix at a time.

## Why this matters

This is the gate for the whole Phase-6 fixpoint (stage-2 → stage-3 ≡ stage-2) and
Phase 7 (revive yo-self/tests under the stage-2 binary). Per the plan, the stage-2
compile is EXPECTED to surface a wave of executing-mode gaps; this startup crash is
the first one and must be cleared before the wave is even visible.
