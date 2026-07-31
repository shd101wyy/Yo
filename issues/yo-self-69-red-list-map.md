# #69 red list — measured root-cause map (2026-07-25)

All 19 reds re-triaged against a HEAD-behaviour s1 by actually running each
file, reading the FIRST error in source order, and counting hollow markers in
the emitted batch C. This supersedes the handoff's three-family table, which
groups files that fail for unrelated reasons and omits the stall class
entirely.

Marker legend: `U` = `Unknown type: Type`, `N` = `no C type name`,
`F` = `Failed to transpile`, all counted in the file's
`.yo_selftest_batch_1.bin.c`.

## Clusters, largest leverage first

### 1. stall-eval — 6 files, the single biggest cluster

`tests/imm_sorted_map`, `imm_sorted_set`, `imm_threading`, `imm_vec`,
`collections/btree_map`, `collections/priority_queue`

Every one: killed at timeout, **0-byte log** (not even the
`check: parsing ./std/prelude.yo` progress lines flushed), and **no
`.bin.c` ever written** — only the generated `.yo_selftest_batch_1.yo`. So the
hang is in the EVALUATOR, before C emission. These are not C-error reds at all
and share nothing with the other 13 beyond being red.

Note they are all ORDERED/sorted or persistent-vector collections. A single
non-terminating comptime evaluation (or a pathological blowup) in the shared
ordered-collection core would explain all six. Worth attacking first purely on
count: 6 of 19.

STACK CAPTURED (priority_queue, `sample` after 60 s). 4115/4115 samples sit in
one stack whose repeated frame is `_tts` (`yo-self/types/string.yo:18`, the
worker behind `type_to_string`), reached via `create_specialized_function…` and
`_impl_type_captures_sig`. Supporting frames: `concat` 305,
`extend_from_ptr_specialized` 272, `to_string` 64 — i.e. string building inside
the recursion.

**The next three paragraphs are SUPERSEDED — see "RE-MEASURED 2026-07-26"
below. They are kept because the depth-cap measurement in them is still valid
and because the wrong turn is worth recording: a single 60 s sample was read as
many small renders when it is one runaway render.**

READ THE SHAPE CAREFULLY — it is NOT exponential fan-out. Every level reports
the SAME sample count (4115) and the indentation steps by 2 per frame, which is
a single LINEAR chain, not branching. (An earlier reading of this same sample
called it "combinatorial fan-out"; its own numbers contradict that.)

DEPTH MEASURED — and it exonerates the depth cap. An earlier note here claimed
the cap must be "reset by re-entry" because the frames looked 60+ deep. That
was an artifact of eyeballing indentation. Counting CONTIGUOUS `_tts` frames in
the sample gives a longest run of **exactly 41** — i.e. depths 0..40, precisely
the cap (`_d > 40 => "…"`, string.yo:20). The cap works. Corroborating: `_tts`
never calls `type_to_string` (the depth-0 entry) internally — only `recur`, and
all 23 of those pass `_d + usize(1)` (verified by grep). There is no reset.

So this is NOT a runaway recursion and NOT a missing cycle guard. The 341 total
`_tts` frames in the sample are roughly EIGHT SEPARATE invocations each running
to the 41-frame cap, and the frames cycle through just three call sites
(+7488 / +13612 / +16588 = three of the recursive arms). The cost is CALL
VOLUME × per-call expense: each of those 41-deep renders builds strings
(`concat` 305 frames, `extend_from_ptr_specialized` 272 in the same sample).

That points the fix at the CALLER, not at `_tts`. The sample reaches `_tts` via
`create_specialized_function…` → `_impl_type_captures_sig`
(evaluator/calls/helper.yo:1048), which renders EVERY `TypeVal` capture with
full `type_to_string` to build a signature string — once per specialization.
With many captures over large types that is quadratic-ish and is exactly the
hazard string.yo already documents at :302-304, where a "cheap, shallow key"
variant was added for the synthesizer "so it can't blow up the way full
`type_to_string` (depth 40) does when called O(n) times".

#### RE-MEASURED 2026-07-26 — "call volume" was the WRONG reading

Two fresh `sample` runs on `priority_queue` (45 s and 7 min into the run, s2
binary) both show **100 % of samples — 15624/15624 and 7592/7592 — inside a
SINGLE call**:

```
… evaluate_function_call → create_specialized_function (yo_id_262993)
                         → _impl_type_captures_sig     (yo_id_262913)
                         → value_to_signature_string   (yo_id_262634)
                         → _tts ×17  (offsets +7032 / +14060 / +15924, cycling)
                         → String concat → _platform_memmove
```

18 % of the second sample sits at `value_to_signature_string + 92` itself
(concat → memmove), i.e. copying an already-enormous string. **RSS was 6.8 GB
after 7 minutes and still climbing** (a full self-compile, for comparison, peaks
around 1.3 GB). One render, not many: the earlier "≈8 invocations × 41 frames"
reading came from one 60 s sample and does not survive re-measurement.

So the shape IS fanout^depth — the depth cap cannot bound it, because the cost
is the product of the branching factors, not the depth. The exactly-periodic
three-offset cycle is the give-away: the traversal keeps re-entering the same
three recursive arms.

#### What TS does — measured, not assumed

A temporary probe on TS's `typeToString` (added, measured, reverted) running
`check` over the SAME file reports:

| metric                                           | value        |
| ------------------------------------------------ | ------------ |
| largest string `typeToString` ever returns       | **44 chars** |
| calls                                            | 4455+        |
| times the `visited` cycle guard fired            | **0**        |
| times it was called on a source-namespace struct | **0**        |

TS is not fast here because its guard is better — the guard never fires. TS is
fast because **it never renders these types at all**: `_impl_type_captures_sig`
has no TS counterpart (TS gives every generic-impl method instantiation a unique
funcId embedding its substitutions, impl.ts:1551, so identity is a string
compare). yo-self shares one func_id and reconstructs the identity by RENDERING
the captured `TypeVal`s on every specialization.

Note this also retires the earlier "do NOT port TS's visited guard" advice in
its original form: the guard is not what makes TS fast, but yo-self still needs
a bound, and the guard is the only bounding mechanism TS has.

#### Fix applied

`_tts` now threads a `visited` set of already-expanded named-type ids
(`yo-self/types/string.yo`), guarding the three id-bearing arms that recurse:
source-namespace `Struct` (a module's field dump is its exported functions,
whose parameter types are more modules), anonymous `TraitT` (its field dump is
method signatures), and `SomeT` with constraints (the arm that closes the loop:
`T : (Ord)` → `Ord.cmp : fn(self : T, …)` → `T` → …). Named structs, enums and
unions already render name-only, so they cannot be the cycle.

The set is MONOTONIC (never popped) rather than path-scoped like TS's, which
bounds a shared-but-acyclic graph too. That is the same deliberate divergence,
for the same measured reason, as yo-self's two sibling key functions —
`type_intern_key` (intern.yo: "Never-pop keeps rendering deterministic (=>
injective)") and `_type_key_at`, whose `g_tk_visited` header records this exact
pathology: "40-way variant fanout × depth 4 built multi-MB key strings per
lookup … a ~300 MB/s runaway (footprint 7→62 GB)", fixed the same way, with the
note that the guard "bounds each key to O(distinct types on path) and is MORE
precise than depth truncation".

Blast radius: `type_to_string` feeds `type_key.yo` (:213, :251, :327) and
signature strings, so its output is part of spec identity. Output changes ONLY
for a render that re-encounters one id, and the placeholders carry the id
(`<module:…>`, `<trait:…>`), so distinct types still render distinctly. Judge it
by GATE 2 (corpus diff-test) and whether the six files complete — a PERF fix is
measured, not inferred from test flips.

#### RESULT — all six stalls are gone; zero of them is green yet

Single-variable, both binaries s1 (TS-compiled), same machine:

| file             | HEAD s1        | with the guard         |
| ---------------- | -------------- | ---------------------- |
| `imm_vec`        | killed at 240s | **3 s**, rc=0 (HOLLOW) |
| `imm_sorted_map` | timeout        | 3 s, rc=1, 9 markers   |
| `imm_sorted_set` | timeout        | 4 s, rc=1, 9 markers   |
| `imm_threading`  | timeout        | 5 s, rc=1, 13 markers  |
| `btree_map`      | timeout        | 3 s, rc=1, 0 markers   |
| `priority_queue` | timeout        | 3 s, rc=1, 0 markers   |

1800 s of non-termination → 3-5 s in every case. The cluster is no longer a
stall cluster; it is now five ordinary C-error reds plus one hollow pass.

**`imm_vec`'s rc=0 is VACUOUS — do not count it as a flip.** Its emitted batch
carries exactly ONE marker, and that marker is the whole main body:
`// Failed to transpile match(((__yo_batch_env.env).get)("YO_TEST_INDEX"), …)`
— i.e. every one of the 47 "passing" tests. Textbook hollow-green (the empty
test body counts as a pass). Whether that throw predates the guard cannot be
established from this file, because it never completed before; the guard's own
regression evidence is GATE 2 (corpus **PASS 140 / DIFF 0**, so no emitted C
changed anywhere) and GATE 1 (19/19 at expected counts).

The two `btree_map` / `priority_queue` errors are now the SAME shape as cluster
7 (`call to undeclared function 'yo_id_…'`), which merges those four files into
one investigation.

### 2. comptime param model (`__unknown__Type__`) — 4 files

| file                      | markers      |
| ------------------------- | ------------ |
| `imm_map`                 | U8 / N8 / F2 |
| `imm_set`                 | U4 / N4 / F1 |
| `closure_capture_rc_leak` | F3           |
| `sync/mutex`              | F4           |

Shape, verbatim from `imm_map`'s batch C line 3496:

```c
yo_id_5427((// Unknown type: Type)(/* Error: no C type name for i32 */),
           (// Unknown type: Type)(...), (__yo_t91)(root), ...)
```

The comptime Type arguments are emitted as RUNTIME C arguments and render as
`//` line comments, which swallow the rest of the line. Everything downstream
(`expected expression`, the ten `use of undeclared identifier 'result'`) is
cascade. `closure_capture_rc_leak` and `sync/mutex` show the same root through
its other face: call names mangled with `__unknown__Type__`
(`yo_id_2889__unknown__Type__fn_item___A_____unit_...`) that are called but
never defined.

This is handoff task #15's known root, WIP patch at
`scratchpad/round2_param_model_wip.patch`. HOLLOW-GREEN HAZARD: these four
already emit markers, so any "flip" here must be marker-checked against the TS
emit before it counts.

### GATE RESULT (2026-07-26): the closure registry stamp causes a HOLLOW regression — do not re-apply blind

Measured, single-variable, on stage2 hollow-marker counts
(`grep -c "Failed to transpile\|Unknown type:"`), baseline **6**:

| configuration                         | hollow       |
| ------------------------------------- | ------------ |
| baseline                              | 6            |
| Self binding + closure registry stamp | 19           |
| **closure registry stamp ALONE**      | **19**       |
| Self binding ALONE                    | not measured |

So the CLOSURE REGISTRY STAMP is the culprit, not the `Self` binding. I had
assumed the opposite and reverted the `Self` work first; that was wrong and
cost a build cycle.

The stamp is: in `evaluator/values/anonymous_function.yo`, the `=>` lambda path
calling `register_some_resolved_concrete(<expected Impl(Fn) wrapper id>,
capture_type)`. It flips `tests/impl_fn_field_rejection` to 5/5 and keeps the
corpus at PASS 140 / DIFF 0 — but adds 13 hollow markers to the self-emit, all
in ONE function: build_runner's C-compiler invocation (`cmd.arg`,
`io.await(cmd.status(io))`, `externs`, `libraries`). The whole body goes
hollow, i.e. its evaluation throws and the swallow layer at
`evaluator/exprs/_expr.yo:1018` eats the error.

WHY THAT MATTERS MORE THAN THE MARKER COUNT: the affected function is how the
self-hosted compiler invokes clang. A build that "passes" while dropping it is
not a working compiler. Note the state ALSO passed the 19-file battery, corpus
140/0, `check ./std` 153/153, clang, AND `STRICT_FIXPOINT HOLDS` — the fixpoint
is stable _around_ the defect because stage2 and stage3 drop the same
statements. Marker count was the only gate that caught it.

Likely mechanism to investigate first: the stamp is UNCONDITIONAL, whereas TS
tests `wrapperType.requiredTraits.some(t => t.traitType.id === expectedFnTraitType.id)`
and, when false, builds a synthetic `__impl_fn` wrapper instead of resolving the
outer one (`src/evaluator/values/anonymous-function.ts:1200-1226`). Registering
the OUTER wrapper in a case where TS would not is a plausible cause of a
downstream type mismatch inside an `io.async`/`io.await` chain.

NEXT: measure the `Self` binding ALONE (impl.yo `subst_set_self` +
types/substitution.yo, per the faithful spec) — it flips `cli/arg_parser` 15/15
and its hollow count is still unknown. Do that before touching the closure
side again.

### 3. closure value's C type collapses to `void*` — 3 files

- `impl_fn_field_rejection`: ONE error, no cascade. `struct __yo_t22_struct
{ int32_t value; void* cb; }` declares the `Impl(Fn)` field as `void*`, but
  the initializer is the closure capture struct `__yo_t26`.
- `ref_closure_capture`: ONE error, no cascade. `static inline void*
yo_id_4939(int32_t* x, int32_t y)` returns the capture struct `__yo_t23`
  by value.
- `sync/once`: all 19 errors one shape — capture struct passed to a parameter
  declared `void (*)()`; the closure-specialized function's prototype AND
  definition both declare it that way.

Clean markers, minimal cascade, and two of the three fail on a SINGLE error —
the cheapest cluster to iterate on after the stalls.

INVESTIGATED: the root looks to be in the EVALUATOR, not codegen. TS
(`src/evaluator/values/anonymous-function.ts:1138-1230`) keeps the expected
`Impl(Fn(...))` wrapper SomeType, mutates it in place with
`wrapperType.resolvedConcreteType = captureType` (:1211/:1221) and sets the
expression's type to that RESOLVED wrapper (:1237-1240). yo-self's
`evaluate_anonymous_function_implementation` (the `=>` lambda path — the one
taken when a closure is a call argument, a struct-field initializer, or a
function-body tail) instead only uses the expected type to derive a plain
`Func` and never stamps the resolved wrapper, so the capture struct's concrete
C type is unavailable downstream and every sink falls back to `void*`.
Candidate sites: `yo-self/evaluator/values/anonymous_function.yo:1416, :588,
:1383`; sinks at `codegen/utils/index.yo:945, :880` and
`codegen/functions/declarations.yo:178`.

STATUS: the FIELD position is FIXED and verified (`impl_fn_field_rejection`
5/5). The fix was small because yo-self already had the mechanism —
`closure_type.yo:296-299` registers the `Impl(Fn)` wrapper's resolved concrete
on one closure path, and the `=>` lambda path simply never did it. TS gets this
by mutating the wrapper in place; yo-self's TypeValues are immutable copies, so
the id-keyed registry IS its equivalent.

The other TWO positions were attempted and REVERTED. Record of what was tried,
so it is not repeated blind:

- RETURN (`ref_closure_capture`). Symptom is precise: the DEFINITION emits
  `static inline __yo_t23 yo_id_4939(...)` (correct, capture struct) while the
  PROTOTYPE still emits `void*`, so clang reports
  `conflicting types for 'yo_id_4939'`. Attempted fix: in the declared-return
  stamping (`function_type.yo:730`, the `!is_some_type(dts_bty)` branch), stamp
  the closure's CAPTURE STRUCT instead of the bare `Func` — a `Func` is what
  `get_type_string` lowers to `void*` (codegen/utils/index.yo:880). Result: NO
  EFFECT, error unchanged. So the prototype does NOT take its return type from
  that stamping — find the prototype's actual type source before retrying.

- PARAMETER (`sync/once`). yo-self builds specialized parameter types from the
  ARG type (helper.yo:1888-1909), so a closure arg puts a bare `Func` in the
  slot and `generate_function_prototype` emits `void (*f)()`. Attempted fix:
  extend the existing "prefer the declared param type" fallback (which was
  scoped to the poisoned unit-arg case) to closure args whose declared param is
  a SomeT WITH a registered resolved concrete. Result: PARTIAL — the error
  moved from `void (*)()` to `void *`, i.e. the parameter is no longer a
  function pointer, but the SomeT still lowers to `void*` at codegen even
  though the registry lookup succeeded during evaluation. That gap (registry
  hit at eval time, miss at codegen time) points at the SomeT id being
  RE-MINTED between the two — investigate that before retrying, since it likely
  also limits the field fix in other shapes.

Both reverted rather than committed: neither flipped its test, and #4 does
change the emitted C, so keeping it would be an unvalidated behaviour change.

### 4. await result type → void/unit — 2 files, byte-for-byte identical

`thread` and `worker`. Both, immediately after an await poll loop:

```c
void _file____User_temp_7090 = ;
void _file____User_temp_7091 = (() == ());
```

INVESTIGATED, and one appealing discriminator is REFUTED. Only ONE test in each
file is actually broken — index 4, the `io.async` block whose body returns a
value computed from CAPTURED outer variables
(`x := 10; y := 20; … return(x + y)`), whereas the neighbouring "async loop"
test returns a LOCAL (`counter`) and passes. That makes "capture of outer
variables" the obvious trigger.

It is NOT sufficient on its own. A standalone file containing exactly that
contrast — one `Thread.spawn` whose `io.async` body returns `i32(30)` from
locals, and a second whose body returns `x + y` from captured outer variables,
both awaited and asserted — COMPILES AND RUNS CLEAN on yo-self (rc=0),
matching TS. So the trigger needs something further from the test file
(the `test(...)` harness context, or accumulation across the earlier async
blocks in the same batch). Reproduce it before fixing; do not assume capture
alone.

The mechanism sketch below is therefore unconfirmed at the point of failure,
though the pieces were read directly: yo-self keeps a GLOBAL side-table
`g_some_resolved_concrete` (expr_info.yo:562-570) which at each `io.async` is
written with `get_func_type(<action fid>).result` guarded only by
`if(!(is_some_type(rr)))` — so a `unit` result is happily stored — and at each
`io.await` the call's return type is overwritten from that table
(function.yo:4478-4518). TS instead binds the await's forall `T` by synthesis
against the future ARG and carries `resolvedConcreteType` on a PER-CALL cloned
SomeType (function.ts:2080-2115). Also noted: yo-self's await emitter checks
`expr_type` BEFORE the output SomeT's own resolution cell, inverted relative to
TS (codegen/exprs/await.ts:79-102), and the malformed `void x = ;` itself comes
from `_materialize_arg` (codegen/exprs/other_fn_call.yo:452-462), which has no
TS analogue printing a declaration for a unit-typed argument.

The awaited Future's result type resolved to void/unit, so the result binding
and both comparison operands emit empty. Both then call `yo_id_4927(...)`
without its specialization suffix, though the correctly-suffixed
`yo_id_4927_str_id_str_rtparam0_bool_...` IS declared and used correctly at
other lines in the same file. Two files, one fix.

### 5. `Option(Self)` used as a receiver — 1 file

`cli/arg_parser` — the only TRUE type-identity red. Fully characterized with a
26-line reproducer: `issues/repros/option-self-return-chained-call.yo`. See
`issues/yo-self-struct-instance-family-triage.md` for the measurement detail
and the comparison-method warning.

### 6. `Box(Self)` + derive — 1 file

`derive_clone_complex`. Prototype `yo_id_2747_V_id_1598_ret_...(void value)` —
a unit-typed value emitted as a real C `void` parameter; body emits
`void _file____User_temp_7450 = ;` and calls `fn_yo_id_5853();` missing `self`.
Ten hypotheses already disproven:
`issues/repros/box-self-struct-field-derive-clone.yo`.

### 7. undeclared-spec — 2 files

`collections/ordered_map` and `sync/channel`. Clean markers; a call to an
undeclared `yo_id_..._rtparam0_...` specialization. Plausibly the same
spec-naming divergence as cluster 2's `__unknown__Type__` face, but NOT yet
confirmed — treat as its own bucket until measured.

## Suggested order

1. **stalls (6)** — biggest count, and a stall is a different (possibly
   simpler) kind of bug than a miscompile: a loop that does not terminate.
2. **closure → `void*` (3)** — clean single-error files, fast iteration.
3. **param model (4)** — known root, WIP patch exists, but hollow-green risk.
4. **thread/worker (2)** — one fix, identical evidence.
5. The three singletons.

## Method

Every line above came from running the file and reading the first error in
source order, not from the headline error count. Two headline errors in this
list are pure cascade (`use of undeclared identifier 'result'` x10 in imm_map;
the `__yo_t6` vs `int` pile in closure_capture_rc_leak) and would have sent a
fixer to the wrong place.

## UPDATE 2026-07-28 — the round2 param-model WIP patch is STALE

Attempted re-application of `scratchpad/round2_param_model_wip.patch` against
post-cluster-B/ptr/closure/algebraic-effects HEAD: `evaluator/calls/helper.yo`
rejects **15/15 hunks** (the file absorbed four fix batches since the patch
was cut) and `function.yo` rejects 3/12. A half-applied state is
untrustworthy — REVERTED. The comptime-param-model fix for the
imm_map/imm_set/sync-mutex `__unknown__Type__` family needs a FRESH
implementation against current HEAD, using the patch only as a design
reference (its applied-clean `collection.yo` piece —
`_is_generic_unspecialized_func` treating comptime-param fns as
unspecialized, TS guards.ts:466 hasCompileTimeParams — is the right
signature-side start; the call-site half is excluding comptime args from the
emitted runtime C arg list). Keep the HOLLOW-GREEN HAZARD discipline: these
files already emit markers, so flips must be marker-checked against TS.

## FRESH MEASUREMENT 2026-07-28 (post four landed batches)

imm_map is down to **markers=1** (was 13) — most of the old call-site face is
gone. Remaining chain, measured in /tmp/yb:

1. `yo_id_5125(// Unknown type: Type K, ...)` prototype+definition — FIXED by
   a `TypeUni` param case in `is_function_type_hard_generic` (types/guards.yo;
   the TS guards.ts:466 hasCompileTimeParams classification; also mirrored in
   collection.yo's `_is_generic_unspecialized_func` + a comptime-flag check —
   all in /tmp/yb, UNLANDED).
2. With (1), the next face surfaces: an EMITTED spec body calls
   `_node_insert(K, V, root, ...)` — the ORIGINAL comptime-param fn — with
   comptime Type args in the C arg list; the skipped-callee degrade FTTs the
   call but SPLICES into a temp initializer
   (`__yo_t69 tmp = // Failed to transpile ...` — another decl-splice site,
   same class as the fixed assignment.yo one).
3. The batch `main` is ALSO one whole-match FTT (eval-side abandonment) — the
   `Cannot unify "usize" and "Type"` hollow-cause family from the handoff
   table, which is what prevents `_node_insert` from specializing in the
   first place.

ORDER OF WORK: (3) first — the eval-side unify root unblocks the
specializations, which likely dissolves (2); then land (1)+(2 splice guard)
together. The TypeUni guard alone only trades one clang error for another —
DO NOT land it in isolation.

## ROUTING HYPOTHESIS (2026-07-28, minimal repro /tmp/imm_repro.yo — 2-min cycle)

Even the MINIMAL `Map(i32,i32).new().insert(...)` fails self-compiled: the
emitted insert spec's body calls `_node_insert(K, V, root, ...)` — the
ORIGINAL — FTT'd by the skipped-callee degrade and SPLICED into a temp
initializer. `_node_insert` declares EXPLICIT `comptime(K) : Type,
comptime(V) : Type` value-position params followed by runtime params
(std/imm/map.yo:369). No discriminating eval error is swallowed (the two
list.yo `Incompatible types (reversed._head)` messages are a separate known
cause): the specialization is skipped SILENTLY — hypothesis: a call with
explicit comptime params + RUNTIME remaining args routes to the CTFE path
(evaluate_comptime_fn_call), which bails on the runtime args ("Failed to
call the function for compile-time…", present in the GLOBAL noise set), and
no runtime specialization is ever minted; TS classifies this shape as
isFunctionSpecializable and mints a runtime spec keyed on the comptime args
(the mint plumbing exists in yo-self — create_specialized takes
compile_time_args — only the ROUTING is missing). NEXT: find the call-site
classification (comptime_fn.yo vs function.yo's FuncVal arm) for a callee
with param_comptime flags + runtime args, and mirror TS's
isFunctionSpecializable routing; then the emission must DROP comptime args
from the C arg list (they are not runtime params of the spec).
Also fix alongside: the temp-initializer FTT SPLICE (`__yo_tN tmp = //
comment`) — the same degrade-splice class as assignment.yo's.

## COMPTIME-PARAM SPEC CHAIN — measured & partially built (2026-07-28, /tmp/yb UNLANDED)

The routing hypothesis was CONFIRMED and refined. Five coordinated pieces
are implemented in /tmp/yb (all validated on /tmp/imm_repro.yo, ~10-min
diag cycles); the eval layer is now THROUGH and the front moved to C-type
identity:

1. **Trigger** (function.yo `_evaluate_funcval_runtime_call` ~1626): the
   spec trigger was `forall_names.len()>0 || closure-param soft-generic` —
   explicit `comptime(K) : Type` fns have NEITHER, so no spec was ever
   minted (TS: isFunctionTypeGeneric counts p.isCompileTimeOnly,
   guards.ts:466). Added `ou_spec_comptime_params`: any
   get_func_param_comptime flag AND every flagged arg's value compile-time
   KNOWN (TypeVal with no SomeTs; UnknownVal rejects) AND not control fn.
2. **Call-site C args** (function.yo arg loop ~3390): runtime_arg_exprs
   push now gated on !param_comptime[ai] (TS helper.ts:343/397) — the
   TypeVal arg was previously spliced into the C call as an FTT comment.
3. **Mint split** (helper.yo create_specialized): comptime-param arg VALUES
   join compile_time_args (cache key splits per instantiation — TS
   helper.ts:2233); runtime_param_tys keeps ALL args (index alignment is
   load-bearing across the mint's per-param loops); the REGISTERED spec
   type + param_labels/is_ref/is_owning filter comptime indices OUT (C
   signature carries runtime params only); comptime params bind
   COMPILE-TIME into the mint env EARLY — before return resolution — via a
   dedicated loop (binding them only in the rbp loop ran AFTER spec_ret_ty
   and left `Pair(K,V)` unresolvable).
4. **Return-type re-eval** (NEW side-table + helper): yo-self resolved the
   spec return by SUBSTITUTION over the def-era TypeValue
   (evaluate*function_return_type_again = \_resolve_some_types_deep), which
   keeps the def-era instantiation instance — the body's own `Pair(K,V)`
   CTFE calls mint/fetch the MEMOIZED canonical instance → TWO lineages of
   the same instantiation → "Incompatible type with expected type"
   (match.yo) at map.yo:242. TS RE-EVALUATES functionType.return.typeExpr
   in the specialized env (evaluateFunctionReturnTypeAgain,
   function.ts:2822) so both routes hit the same ctor memo. Port:
   `g_func_return_type_expr` side-table (register in
   evaluator/types/function.yo fn-type eval; copy* in
   calls/function_type.yo like the defaults) + `_trial_eval_ret_type_expr`
   swallowing re-eval in the mint; adopt only a CONCRETE (SomeT-free,
   non-unit) result.
5. **Self-scope for the re-eval**: a `Self`-returning method (ptr
   `add -> Self`) re-evaluated `Self` under the CALLER's stale
   ctx.self_type (insert's Map(i32,i32)) and adopted it as the spec return
   → "\*(Pair(i32,i32))" vs "Map(i32,i32)" unify failure INSIDE the .add
   spec body (probes: self binding + ctx.self_type were CORRECT at body
   eval; only the early rte ran under the stale self). Fix: around the
   rte eval, set ctx.self_type from arg0's arg_type when params[0]=="self"
   (TS passes functionType.SelfType). Restored after.

STATE after all five: repro FTT 4 → 2; compile now fails LOUDLY at clang
with C-IDENTITY mismatches — `__yo_t36 child = <__yo_t2 expr>` etc.: TWO C
typedefs for the SAME MapNode(i32,i32)/Pair(i32,i32)/Option era, and the
recur-route recursive spec's C name still embeds PLACEHOLDER return args
(`..._ret_gs_yo_id_5468_2185_2186`). This is exactly the P3 remainder
(memory: yo-self-p3-recursive-instantiation-identity): codegen
type-collection + C-identity for recursive-generic specs.

NEXT: (a) find why type collection assigns two typedefs to the two
same-instantiation TypeValue instances that still coexist (the recursive
spec's param/return era vs the memoized era — likely the recur forward-ref
spec type built from def-era types); (b) the enum-identity dedup
(g_enum_sig_keys) keys include payload type ids, so the cascade doesn't
merge — consider keying through resolved instantiation identity; (c) strip
ALL diag probes (YSWALLOW/YIMM/YUNIFY/YCTFE/YSELF eprintlns in \_expr.yo,
function_type.yo, anonymous_function.yo, function.yo, helper.yo, match.yo,
synthesizer.yo, comptime_fn.yo) before landing; (d) TIER 1 with the
/tmp/yb TypeUni guards included (land together).

Diag technique that cracked it: batch probes per build (YIMM-CT trigger
fire, YIMM-ENTER/SIG/BODYEVAL/BODYOK mint lifecycle, YSWALLOW at all three
swallow sites, YUNIFY with type_key + struct field counts at the
synthesizer tag-mismatch throw, YSELF env-binding dump at a specific fid) —
each build isolates exactly one link of the chain.

## LANDED (2026-07-28) — chain complete, imm_map/imm_set GREEN self-compiled

Two more pieces closed it after the snapshot above:

6. **Call-site return adoption** (function.yo, comptime-trigger arm): the
   arm's `resolved_ret` for a comptime-param callee is the DECLARED def-era
   instance (no foralls to substitute) — locals bound from the call
   (`child := _branch_child_at(...)`) stamped the def-era enum and clang got
   TWO typedefs for one MapNode(i32,i32) (`__yo_t36 child = <__yo_t2 expr>`).
   After the mint, adopt the mint's REGISTERED return into
   resolved_ret/out_rt when concrete.
7. **Fallback gate on the return re-eval**: adopting the re-evaluated
   return UNCONDITIONALLY re-registered a different instantiation era for
   already-concrete forall/method-route returns (HashMap `-> Option(V)`)
   and desynced from the dot-route call-site stamp —
   hashmap_overwrite_no_leak SELF-FAILED at TIER 1. The re-eval now runs
   ONLY when the substitution-based `spec_ret_ty` still carries SomeTs.

VALIDATED: corpus 147/147 (new file comptime_param_value_spec.yo; 0 DIFF,
0 SELF-FAIL), std 153/153, battery green, imm_map.test.yo 21/21,
imm_set.test.yo 19/19 — both formerly RED. sync/mutex not yet re-checked.

## GenericImplMatch refactor attempt — CRASHED, reverted (2026-07-28 late)

Per the faithful-port directive, the landed value-binding side-channel
(e1096c1b4, `g_last_match_binding_vals`) was refactored to TS's exact shape
— `try_match_generic_impl` returning a `GenericImplMatch` struct
(`bindings` + `value_vals`, mirroring GenericImplMatchResult's
substitutions/valueSubstitutions, impl.ts:2199) with declared-type retyping
(impl.ts:2464) and cap_tys threading into \_funcval_bind_foralls. The
refactored build SEGV'd `check ./std` (NULL+8 in
`process_unquotes_in_expr` under `_trial_eval_fn_body` —
`gm2_s1-2026-07-28-211003.ips`) — unrelated quote machinery, i.e. a
MISEMISSION triggered by the new shapes (suspects: Option(2-field-RC-
struct) unwound through the try_match exn handler — the branch-in-handler
corruption class; or the double-match on `mb_opt` (fixed, still crashed)).
REVERTED to the landed TIER-1-green side-channel version; the semantics
already match TS (values flow, declared-type at injection). Follow-up:
reproduce the misemission minimally (a fn returning
Option(struct(ArrayList, ArrayList)) via handler unwind), fix the codegen
root, THEN re-apply the faithful shape.

## Sweep nondeterminism discovered (2026-07-28 late)

array.test.yo batch markers FLIP RUN-TO-RUN with the SAME binary and
command (0 vs 1 markers; 4-run matrix all-1 after an earlier clean run) —
the latent corruption class affects DEF-EVAL OUTCOMES, not just crashes.
walker/bufio RED↔GREEN oscillation across sweeps is the same class
(exit-path `__yo_decr_rc` cleanup crashes, zero-byte logs). Sweep scores
now carry ±2-3 files of corruption noise; the class is the top blocker for
honest scoring. ASan build exists (/tmp/asan_s1) but `check ./std` under
ASan exhausts even an 8 GiB main stack (zero-byte log, rc=139 — the -O0
frame class); next: ASan on a SMALL crashing input, or
MallocStackLogging/lldb per the ExprInfo-UAF workflow
(memory: yo-self-macro-dispatch-corruption-fixed).

Also: sweep gate fixed (stale-batch pollution — hardcoded batch_1.bin.c;
now rm + glob, scratchpad/hollow_sweep69.sh). Fixed-gate score at
e1096c1b4: 139/28/16.

## UPDATE 2026-07-30 — algebraic_effects GREEN; derive_clone_complex scoped

- `algebraic_effects` FLIPPED GREEN (zero-arg `unwind()` port, begin.yo — see
  the handoff §2.4 note). REDs now 7.

- `derive_clone_complex` standalone repro (25 lines, scratchpad `dcc1.yo`,
  inline here): recursive enum + `derive(TreeNode, Clone)`:

  ```rust
  TreeNode :: enum(Leaf(value : i32), Branch(left : Box(Self), right : Box(Self)));
  derive(TreeNode, Clone);
  // build a Branch, clone it, match on the clone
  ```

  TS: compiles and runs. s1: clang `argument may not have 'void' type`.
  The emitted C shows the EXACT break: TreeNode's derived clone
  (`fn_yo_id_4707(__yo_t0* self)`) is emitted CORRECTLY, but inside the
  Box(TreeNode) clone specialization (prelude `box(self.*.clone())`), the
  recursive call site emits `fn_yo_id_4707();` — NO args — with its result
  read from a `void _temp = ;` and passed as `(void)(_temp)` into a `box`
  specialization whose `V` resolved to unit (`(void value)` param). So while
  Box(TreeNode).clone's body was evaluated, `self.*.clone()` — a call to the
  IN-PROGRESS TreeNode Clone impl — typed as UNIT with no arg plumbing, and
  `box(...)`'s V synthesized from that unit. TS types the same call from the
  trait signature (`clone : fn(self : Self) -> Self` ⇒ TreeNode).

  Next probe: where `self.*.clone()` resolves during the in-progress
  registration (the `is_concrete_impl_being_registered` window) — the method
  lookup that returns a unit-typed result instead of the declared
  trait-method type with Self := TreeNode. The fix is at that lookup: return
  the trait-signature type for in-progress concrete impls (TS parity), not
  unit.

## UPDATE 2026-07-30 (later) — derive_clone_complex FIXED (GREEN). REDs now 6.

Root cause (probes \_\_DBG_M7/M8/M9 — three diagnostic builds): the recursive
`self.*.clone()` call inside the Box(TreeNode) clone specialization runs
WHILE the derive-generated `impl(TreeNode, Clone(clone : ...))` is still
evaluating its member bodies — the derived clone is NOT in the trait-method
registry yet. The receiver-method lookup returned 0 hits, the call dispatch
fell to the valueless-callee arm, and `try_to_call_function_with_arguments`'s
non-Func soft fallback (helper.yo) typed the call as UNIT with an EMPTY
runtime-arg list — exactly the emitted `fn_yo_id_4707();` + `void _temp = ;`

- Box V=unit chain.

TS's mechanism (the missing port piece): `tryToImplementTraitWithArgumentsBy
TraitType` (trait-type.ts:176-203) splices the registering trait's method
fields — with `SelfType := receiverType` substituted — into
`receiverType.trait.fields` BEFORE evaluating member expressions, and
restores them after (trait-type.ts:512). Object identity makes the in-flight
signatures visible to every lookup during the window; the call is typed from
the trait signature (`clone : fn(self : Self) -> Self` ⇒ TreeNode) even
though the FuncVal is still being built. trait_type.yo's header even listed
"`receiverType.trait` mutation skipped (Phase 3)".

yo-self port (landed): a PROVISIONAL trait-method registry
(`register/get/clear_provisional_trait_methods`, type_trait_methods.yo)
keyed by receiver type id, entries `value : None` + Self-substituted `ty`.
Populated in BOTH trait-ctor evaluation paths — impl.yo's member loop (the
path derive-generated impls take; it collects colon pairs itself and never
calls try_to_implement) and trait_type.yo's try_to_implement (direct trait
ctor calls) — and cleared after each member loop plus a sweep at the impl's
unmark site.

CRITICAL ordering lesson (caught by TIER 1): consult provisional entries
AFTER the real registry (fallback-when-empty), NOT TS's splice-ahead order.
During member evaluation, earlier members of the same impl are already
registered with concrete FuncVals — derive(Eq)'s `!=` body calls `==`,
registered one iteration earlier. Splice-ahead shadowed that real method
with the valueless in-flight entry and miscompiled the inner dispatch:
corpus `enum_ne_dispatch.yo` DIFF (classify() returned 89 for every input)
and tests/imm_string.test.yo rc=1 (batch C "expected expression"). With
fallback ordering both are clean.

Corpus guard added: `tests/codegen-bootstrap/derive_clone_recursive_enum.yo`
(the dcc1 repro, putchar-scored). Gates: TIER 1 clean (corpus 149 incl. the
new fixture, DIFF 0; std 153/153; battery baseline), sweep 159/20/6,
derive_clone_complex 15/15 passed hollow=0 markers=0 (TS parity 15).

## SCOPING 2026-07-30 — the two next REDs, measured

### imm_threading (RED, markers=0) = the comptime-param-model family

The batch C fails on `passing '__yo_t43' to parameter of incompatible type
'__yo_t42'` inside imm*sorted_map's node-ctor specialization
`yo_id_7217_rtparam0_Type_rtparam1_Type*...`— K and V survive as RUNTIME`Type`C params, and the same logical`Option(Node)` minted TWO enum ids
(`enum_yo_id_7187`vs`enum_yo_id_10301`) → two incompatible C structs. This
is the SAME root as imm_sorted_map/imm_sorted_set (markers=1) and the
handoff's priority-2 comptime-param model (`round2_param_model_wip.patch`
design reference, needs fresh implementation). Fixing that family should
flip imm_threading, imm_sorted_map, imm_sorted_set together (and likely
sync/mutex's markers).

### impl_fn_field_rejection (RED, markers=0) = generic-F struct field with Impl(Fn)

14-line repro (scratchpad iffrB.yo): `GenericCb :: (fn(comptime(F) : Type) ->
comptime(Type))(struct(value : i32, cb : F))` instantiated with
`Impl(Fn(x : i32) -> i32)` and constructed with a bare lambda. The Dyn(Fn)
field shape (workaround A) already WORKS standalone.

Emitted C: field `void* cb;` but initializer `(__yo_t8){}` (the empty
capture struct) → clang "initializing 'void \*' with \_\_yo_t21"; call site is
a bare fn-ptr cast with NO capture arg. TS emits the field AS the capture
struct type and calls `closure_id(&(obj.cb), 4)`.

Probe findings (register_some_resolved_concrete + void*-fallback probes):
ZERO global some-resolved registrations fire in the whole compile; the
field's SomeT (`sid=1323 name=Impl`) falls back to void*. The lambda DOES
take on the wrapper SomeT — but only via the PER-OBJECT resolved cell
(anonymous_function.yo:1521-1590, `t_resolved_cell(cap_t)`, deliberately NOT
the global registry: a global stamp measured hollow regressions in
fs/file + fs/temp). The struct TYPE's field SomeT is a DIFFERENT instance of
the same id with NO cell — TS bridges by object identity (the arg's expected
type IS the field type object; stamping resolvedConcreteType mutates the one
shared object read by both the struct typedef and the member call).

Fix direction (next round): in the struct-construction member loop
(calls/type.yo, after the arg eval at ~line 247), when `member_element.ty`
is/contains a SomeT wrapping a CONCRETE-result Fn trait and the evaluated
arg carries a capture type (info.capture_type / the taken-on wrapper cell),
propagate the resolution to the FIELD instance — either stamp a resolved
cell onto the struct type's stored field ty (needs the registered struct
type value, not a copy) or register the GLOBAL id→capture mapping gated to
this struct-member shape (narrower than the lambda-eval stamp that
regressed fs/\*). Then verify the member-call site dispatches through
impl_closure_call_map (`closure_fn(&obj.cb, args)`), mirroring the
closure-param path. Same family as closure_capture_rc_leak (markers=3).

## UPDATE 2026-07-30 (later still) — impl_fn_field_rejection FIXED (GREEN). REDs now 5.

The scoping section above's fix direction landed: in calls/type.yo's
struct-construction member loop (right after the arg eval), when the field
type is a SomeT wrapping a CONCRETE-result FnTraitT and the evaluated arg
carries a capture type (info.capture_type), register the capture struct as
the FIELD SomeT id's resolved concrete (register_some_resolved_concrete).
One narrow registration — the member call site then dispatches through the
closure protocol without further changes (codegen resolves the field's
SomeT to the capture struct via the global registry).

The fs/file+fs/temp hazard from the lambda-eval global stamp does NOT recur:
the gate here is the struct-member shape (concrete-result Fn wrapper +
capture-carrying arg), not every wrapper take-on. Gates: TIER 1 clean
(battery incl. fs/file 13 + fs/temp 7, corpus 149/0, std 153/153), TIER 2
clean (stage2 hollow=0, stage3, FIXPOINT_HOLDS), sweep 160/20/5 with exactly
one flip. impl_fn_field_rejection 5/5 = TS parity.

closure_capture_rc_leak (same family, different face) stays RED: its errors
are `passing 'int32_t' to parameter of type 'void *'` at closure CALL sites
— the closure PARAM model, not the field model. 3 markers.

## SCOPING 2026-07-30 (cont.) — imm_sorted_map family: 65-line VALID repro

`issues/repros/comptime-ctor-memo-split-map-insert.yo` (TS rc=0 + runs; s23
rc=139 with 3 clang type-mismatch errors + FTT cascade). Shape: comptime
type ctors `Node(K)`/`Map(K)` with where clauses, `mk`/`ins(recur)`/`insert`
helpers with `comptime(K) : Type` params, main driving
`Map(i32)` + 3 inserts.

Measured split: `Map(i32)` instantiated TWICE with different struct ids —
`struct_yo_id_4785` (`__yo_t3`, the insert specialization's return/param
rendering, spec name `..._rtparam1_gs_yo_id_4657_i32_..._ret_gs_yo_id_4657_1363`)
vs `struct_yo_id_4806` (`__yo_t0`, main's `Map(i32)(...)` constructor). The
insert spec RETURNS `__yo_t3` but internally constructs `__yo_t0`; main
assigns the result into an `__yo_t0` local → "initializing '**yo_t3' with
'**yo_t0'". The CTFE instantiation memo for `Map(i32)` missed between the
def/spec path and the main-body path.

Hypothesis (gap-6 attempt-#8 "fix creation side" territory): the memo key
includes the ctor's func_id, and the specialization path evaluates a CLONED
ctor reference with a different fid (same class as the trait-ctor-fid and
impl-bindings-sig fixes earlier in this campaign) — OR the where-clause
trait-check env perturbs the key. Next probe: print the memo key at the
comptime-fn CTFE cache (comptime_fn.yo) for ctor name Map — one build
answers which component diverges.

Same root should cover imm_sorted_map (markers=1), imm_sorted_set
(markers=1), imm_threading (rc=1 clang type mismatches on
left/right params: enum_yo_id_7187 vs enum_yo_id_10301 inside ONE \_new_node
spec signature), and plausibly sync/mutex's 2 markers.

## ROOT CAUSE 2026-07-30 — imm family: substitution keeps def-time ids; TS re-evaluates

Probe (\_\_DBG_CT on g_comptime_fn_caches lookups, nodup3 repro): `Map(i32)`
UNIFIES through the CTFE cache (1 MISS-cache + 2 HITs, fid=yo_id_4657) —
the cache is not the problem. The split comes from the GENERIC evaluations:
`Map(K)` / `Node(K)` with the constraint-carrying SomeT K are `nocache`
mints (arg contains SomeType → should_cache=false), one fresh struct id per
evaluation (Node: 7 nocache mints in the tiny repro). The insert
specialization's param/return types are produced by SUBSTITUTING K:=i32
into one of those def-time mints — substitution.yo's Struct arm rewrites
field types but KEEPS the struct id — while the body's `Map(K)(...)` ctor
call re-evaluates through the cache and gets the canonical id. Two ids for
Map(i32) inside one function → the clang type mismatches.

TS's mechanism: `evaluateFunctionParameterTypeAgain` re-evaluates the
stored type EXPRESSION in the callee env — the `Map(K:=i32)` ctor call
lands in calledComptimeFunctionCaches → canonical object. yo-self's port
(types/function.yo:4183 header says this verbatim) substitutes instead,
because `TypeValue.Func` keeps only pre-evaluated TypeValues.

Fix design (creation-side canonicalization — the gap-6 attempt-#8 lesson):
after `evaluate_function_parameter_type_again` (+ its return-type variant)
substitutes, walk the result for ctor-stamped structs/enums
(lookup_struct_ctor_fid / enum cfid) whose type arguments became CONCRETE,
and canonicalize each against g_comptime_fn_caches:

- cache HIT for (ctor_fid, concrete args) → replace with the cached
  instantiation;
- cache MISS → INSERT the substituted instance as the entry (first-wins),
  so a later direct ctor call unifies with IT (order-independent).
  No ctor re-invocation needed. Struct carries `type_arguments`; EnumT does
  NOT — but the enum splits observed (imm*threading's Option pair) are
  DOWNSTREAM of the struct split (Option's ARGS differed), so struct-level
  canonicalization should collapse the chain. Import cycle note: types/
  function.yo cannot import calls/comptime_fn.yo (comptime_fn imports it);
  use the established fn-pointer injection pattern (set*...\_fn at evaluator
  init) or host the canonicalizer in comptime_fn.yo and inject.

Witnesses: issues/repros/comptime-ctor-memo-split-map-insert.yo,
tests/imm_sorted_map, imm_sorted_set, imm_threading, sync/mutex.

### Implementation plan (param-type-expr re-evaluation, IN PROGRESS)

The RETURN side already exists end-to-end: `register_func_return_type_expr`
(types/function.yo:319-333, registered at ~4060, re-keyed via
`copy_func_return_type_expr`) + the conservative adopt-on-SomeT-leftover
re-evaluation in helper.yo:~1884-1930 (`_trial_eval_ret_type_expr`). The
PARAM side is the missing half:

1. `FuncParam` (types/function.yo:~540-583, 10 construction sites, single
   file): append trailing `ty_expr : Option(AstExpr)` (the raw declared type
   expr; TS `parameter.exprs.typeExpr`). Sites without a type expr pass
   `.None`.
2. Side table `g_func_param_type_exprs : HashMap(String,
ArrayList(Option(AstExpr)))` + register/copy/get, mirroring
   `register_func_param_default_exprs` exactly (including the FuncVal-id
   re-key in calls/function_type.yo — grep copy_func_param_default_exprs
   for the site).
3. Register at evaluate_function_type's param loop (~4025-4063):
   `param_type_exprs.push(pp.ty_expr)`.
4. helper.yo create*specialized_function_inline's param resolution (the
   evaluate_function_parameter_type_again call sites at ~527/740): mirror
   the return-side block — when the substitution-resolved param type still
   carries SomeTs (get_all_some_types > 0) or an array len var, look up the
   stored param type expr by (callee func_id, param index), clone_expr*
   fresh_ids, trial-evaluate in the bound callee env (swallow-guarded, same
   `_trial_eval_ret_type_expr` shape), adopt a concrete TypeVal result.
   Same self_type reconstruction as the return block if params[0]=="self".
5. Witnesses: issues/repros/comptime-ctor-memo-split-map-insert.yo, then
   imm_sorted_map/set, imm_threading, sync/mutex. Full TIER 1 + TIER 2 +
   sweep. HOLLOW-GREEN HAZARD: these files emit markers today — marker-diff
   any flip against TS.

### SLICE 1 LANDED — return-side era fix (repro GREEN; family files unchanged)

Widened the conservative return-type-expr re-eval gate in
create_specialized_function_inline (helper.yo ~1897): explicit-comptime-
Type-param functions ALWAYS take the re-eval — their def-era signature
instantiations are nocache mints, so a fully-substituted "concrete" return
is guaranteed non-canonical. The forall/method route (the
hashmap_overwrite_no_leak hazard) keeps the old SomeT-leftover gate.
Result: issues/repros/comptime-ctor-memo-split-map-insert.yo compiles AND
runs. Gates: TIER 1 clean, TIER 2 clean (FIXPOINT_HOLDS), sweep 160/20/5
(no flips, no regressions).

REMAINING (slice 2, the param side): imm_threading's face is unchanged —
`_new_node`'s spec takes `left : __yo_t43, right : __yo_t42` (two eras for
one declared `Option(RBNode(K, V))`) because spec params come from ARG
types (runtime_param_tys = ae.arg_type), and different call sites carry
different eras. The stored param TYPE exprs (g_func_param_type_exprs,
landed inert) are the fix: re-evaluate each param's declared type expr in
the bound callee env — BEFORE the runtime-placeholder rebind loop, so the
body eval and the registered spec_param_types share the same (cache) era.
Adopt concrete results only, same swallow-guard as the return side, same
rte_has_ct_param gate. Then the CALLERS' arg eras converge too (their
exprs' types come from ctor calls / enclosing spec params, both cache-era
after this).

### SLICES 2+3 ATTEMPTED AND REVERTED (2026-07-30) — corpus DIFF

Slice 2 (spec-mint param re-eval: overwrite runtime_param_tys from the
stored param TYPE exprs, gated on rte_has_ct_param, concrete-only adoption)
DID collapse the callee-signature split — imm_threading's
`__yo_t43 left, __yo_t42 right` became a unified signature — but the CALL
SITES kept their own era: the args are EXPLICIT `Option(RBNode(K, V)).None`
constructions evaluated in the CALLER's body (not expected-type-driven), and
codegen emitted invalid struct-to-struct casts
(`(__yo_t42)((__yo_t43){ .tag = ... })`, "used type where arithmetic or
pointer type is required").

Slice 3 (call-site expected-type re-eval: a trailing `param_type_expr`
param on check_if_function_parameter_matches_argument, passed only for
comptime-Type-param callees) did NOT move that face — confirming the arg
era comes from the caller-body EVALUATION of the qualified enum ctor, not
from the expected type.

TIER 1 on slices 2+3: corpus 148/1 — `closure_where_clause_param.yo`
regressed to DIFF (ts_rc=0 self_rc=0, output mismatch). Family unchanged.
Zero wins + one regression → REVERTED (slice 1 remains landed; the
param-type-expr side table remains landed and inert).

Next-round leads:

1. The remaining split is between the CALLER-body era of
   `Option(RBNode(K,V))` evaluations and the callee-signature era. Probe:
   in the failing caller's spec, print the ctor-cache key/HIT-MISS for the
   arg's `Option(...)` evaluation vs the callee's param re-eval — they
   should both hit the same cache entry; find which one bypasses (suspect:
   the caller's arg expr carries a DEF-TIME ExprInfo stamp that spec
   re-evaluation reuses, or the value-side type comes from clone_value
   preserving the def-era type).
2. The closure_where_clause_param DIFF: slice 2's runtime_param_tys
   overwrite also fires for closure-typed params (their declared exprs
   re-evaluate to Impl(Fn) wrappers) — likely perturbing the capture-era
   used by the closure param rebind. If slice 2 is retried, EXCLUDE params
   whose declared type carries an Fn-trait wrapper.

## SLICE 2 LANDED (2026-07-31) — spec-mint param re-eval with Fn-trait exclusion

The reverted slice-2 retried with the recorded refinement: in
create_specialized_function_inline, comptime-Type-param functions
re-evaluate each runtime param's stored declared TYPE EXPR in the bound
mint env and overwrite runtime_param_tys with concrete results — EXCLUDING
params whose declared type carries an Fn-trait wrapper (re-evaluating those
perturbed the closure-capture era; the closure_where_clause_param corpus
DIFF from the first attempt is GONE with the exclusion — corpus 149/0).
Effect: the callee C signature no longer splits eras between same-typed
params (imm_threading's `left : __yo_t43, right : __yo_t42` is unified).

Slice 3 (call-site expected-type re-eval) was retried TWICE (with and
without the param-level Fn-trait exclusion) and regressed
closure_where_clause_param BOTH times — REVERTED again. The remaining
imm-family face is the CALLER-ARG era: qualified enum ctor args
(`Option(RBNode(K, V)).None`) evaluate in the caller body where the NODE
arg era differs, producing invalid struct-to-struct casts at call sites.
Root fix direction: recursive creation-side canonicalization through ctor
ARGS (the gap-6 attempt-#8 lesson) — era agreement must recurse: two
Option-memo entries split because their Node ARGUMENTS were different era
instances of the same instantiation.

Gates for slice 2: TIER 1 clean (corpus 149/0, std 153/153, battery
baseline), TIER 2 clean (FIXPOINT_HOLDS), sweep 162/18/5 stable.

## CREATION-SIDE CANONICALIZATION LANDED (2026-07-31) — 164/16/5

Two pieces in comptime_fn.yo (the gap-6 attempt-#8 direction):

1. `_ctfe_types_era_equal` (depth-bounded, wired into `_ctfe_args_equal`):
   two type values are the SAME memo identity when their ids match OR they
   are ERA INSTANCES of one instantiation — same ctor fid + pairwise
   era-equal `type_arguments` (structs) / variant field lists (enums).
   `Option(Node-era-A)` and `Option(Node-era-B)` now land in ONE memo entry.
2. DEEP `should_cache` check: a struct ARG whose `type_arguments` carry
   SomeTs is itself a DEF-ERA nocache mint — caching an instantiation keyed
   on it POISONED later concrete lookups (`Option(RBNode(K, V))` cached at
   def time; concrete lookups missed while other def-time evals hit it —
   the t42/t43 split). Never cache on def-era args.

Flips: collections/linked_list (69/69 = TS parity) and imm_set (19/19)
HOLLOW -> GREEN. imm_sorted_set's FTT marker is GONE (markers 1 -> 0);
the family's era count dropped 3 -> 2 — ONE caller-arg era pair remains
(`(__yo_t13)((__yo_t17){...})` — the `.None` ctor args vs the callee
params; needs one probe round to find which path still stamps the
def-era). Gates: TIER 1 clean, TIER 2 FIXPOINT_HOLDS, sweep 164/16/5.

### Signature canonicalization attempt REJECTED (2026-07-31, measured)

Extending canonicalize-via-memo into `value_to_signature_string` + the
spec's `runtime_param_tys` push produced call-site spec names that no
longer match the emitted specs ("call to undeclared function
yo*id_2404_rtparam0*...") — corpus PASS 75 / SELF-FAIL 74. REVERTED.
Lesson: partial canonicalization at the SIGNATURE layer desynchronizes the
stamp/emission halves; era canonicalization is only safe where BOTH the
producer and every consumer of the identity go through the same point (the
memo comparison itself — the landed piece — is such a point; the
signature string is NOT, because call-site stamps and spec registration
compute it at different times with different memo states). A future
attempt must canonicalize at type CREATION (substitute/instantiation
return values), not at identity-string rendering.

Current family state (s41, all landed): imm_sorted_set markers 0 (pure
C-level face: ONE era pair `(__yo_t13)((__yo_t17){...})`), imm_threading
markers 0 (same pair), imm_sorted_map markers 1, sync/mutex markers 2.

## 2026-07-31 — closure_capture_rc_leak scoped: the **unknown**Type\_\_ face lives here

9-line repro `issues/repros/iterator-any-closure-void-param.yo` (TS green,
self clang "passing 'int32*t' to parameter of type 'void *'"):
`src.into_iter().any((x) => (x == needle(usize(0))))`. The emitted `any`
spec is `yo_id_2798__unknown__Type___unknown__Type__rtparam0_...` — the
Iterator GENERIC-IMPL's own generics (T/Item) ride the spec signature
UNRESOLVED (the old imm*map cluster-2 face), so the pred param's
`Impl(Fn(a : T) -> bool)` keeps `a` a SomeT and the closure impl fn's x
param renders `void*` while the body call passes the concrete i32.
Root to chase: the generic-impl method specialization must bind the impl
generics from the RECEIVER instantiation (Iter(i32) → T := i32) into the
spec's compile-time args — TS embeds them in the impl-method funcId
(impl.ts:1551); yo-self's impl-bindings-sig machinery covers the RECURSION
guard but evidently not the spec-arg binding for this route.

### closure_capture_rc_leak fix attempt #1 REJECTED (2026-07-31, measured)

Attempted: in try_to_call's Step-6 forall-placeholder loop, adopt a
CONCRETE TypeVal binding already present in callee_env (the Step-4
capture from \_inject_forall_captures) instead of shadowing it with an
UnknownVal placeholder. Probe findings along the way:

- the adoption LOOKUP finds a binding (n_found=1 for every stamped
  forall), but the LAST binding is the self-binding MARKER
  (`T := SomeT(T)`) recreated by the marker loop — it shadows Step 4;
- scanning ALL same-name bindings (newest-first, skipping SomeTs) STILL
  found no concrete TypeVal → the `any` FuncVal reaching THIS dispatch
  carries NO injected captures at all. The `src.into_iter().any(...)`
  route resolves the method somewhere OTHER than
  find_methods_from_generic_impls (suspect: the type-trait registry entry
  from a CONCRETE registration path, or a cached spec) — the injection
  never happened for it.
  Next probe for the follow-up round: at the `any` dispatch
  (\_try_find_receiver_method / \_select_matching_overload), print WHICH
  lookup source produced the method entry and whether its FuncVal has
  cap_names — that tells where to inject (or where to bind the impl
  generics from the receiver instantiation, mirroring TS impl.ts:1551).

### closure_capture_rc_leak — dispatch source IDENTIFIED (probe, 2026-07-31)

The `any` hit is a TRAIT DEFAULT method: hits=1, source_trait_id EMPTY,
and the FuncVal carries 658 captures (the Iterator trait-definition module
env snapshot) — NOT the generic-impl injected-captures path at all. `any`
is an Iterator `?=` default; the defaults-fill registration
(impl.yo `get_trait_default` -> register_type_trait_method with
`_substitute_self_in_method_ty(d_ty, receiver_ty)`) ran for the GENERIC
impl receiver `Iter(T)`, so the registered method type's
`pred : Impl(Fn(a : ...) -> bool)` still carries the unresolved
T/Self.Item, and the closure param renders `void*`. Fix direction: at a
CONCRETE receiver dispatch of a trait-default entry whose ty still carries
the generic-impl's SomeTs, substitute them from the receiver instantiation
(Iter(i32) -> T := i32) before the call — either at the registry lookup
(env.yo receiver-methods, using MethodEntry.self_type) or by registering
per-concrete-receiver default entries at generic-impl MATCH time (the
find_matching_generic_impl route already derives the bindings).

### closure_capture_rc_leak FIXED (2026-07-31) — 7/7 TRUE GREEN, markers=0

The "trait default" scoping above was wrong in mechanism (right in effect):
`any`/`all`/`fold`/`for_each` are methods of the prelude's BLANKET impl
`impl(generic(I), where(I <: Iterator), I, ...)`, each with its OWN
`generic(A, F)` binder and `where(Self <: Iterator(Item := A), F <: (Fn(item
: A) -> bool))`. The receiver-side substitution (I/Self) was already correct;
`A` is METHOD-level and only derivable from the where clause. TS binds it via
the EARLY where-clause application (helper.ts:1368, before the argument
loop), which yo-self had never ported — so the closure argument was typed
with `A` unresolved and its C param rendered `void*`.

Landed as four pieces (all in one commit):

1. **`ctx.pending_method_self_type`** (context.yo) — ONE-SHOT carrier for the
   method call's concrete receiver type; set at the method-call dispatch
   (function.yo) just before `try_to_call_function_with_arguments`, consumed
   (read+cleared) at its entry. This is the port channel for TS
   `functionType.SelfType` (impl.ts:1497 stamps `substitutions.get("Self")`).
   MEASURED REJECTION of the obvious alternative: threading through
   `ctx.self_type` changes body-specialization behavior broadly — fs/temp
   (7 runtime throws) + sys/bufio regressed; the one-shot channel fixed both.
2. **Step 5b** (helper.yo try_to_call) — bind `Self` into callee_env from the
   pending carrier (port of helper.ts:1015-1035).
3. **Step 6c** (helper.yo) — EARLY where-clause application (port of
   helper.ts:1368-1408) with three yo-self adaptations, each measured:
   - PER-EXPR application gated on the LHS's current binding being a
     TypeVal. TS's all-or-nothing "LHS exists in calleeEnv" guard is safe
     because TS binds Type-typed foralls as `TypeVal(SomeType)`
     (value.ts:547-560 createUnknownValue); yo-self Step 6 binds UnknownVal
     placeholders, and applying `_Self <: LogicalNot` in that state throws —
     hollowed EVERY `!`/`not` body (enum_ne_dispatch FTT, iso/rc rc=139,
     bufio/imm_list/imm_string hollow).
   - PREBIND: forall labels the applied exprs reference that are still
     UnknownVal-bound get a new LAST binding `TypeVal(sig marker SomeT)` —
     the state TS is always in — so `Iterator(Item := A)` evaluates instead
     of throwing 'Expected type for associated type constraint "Item"'.
   - SWALLOW guard (`_try_apply_early_where_clauses`, capture-free `->`
     unwind): the early apply is strictly additive; Step 8b still validates.
4. **trait_checking.yo `_check_associated_type_constraints`** — the compat
   call had its argument ROLES swapped vs TS: yo-self's signature is
   `(actual, expected)`, TS's is `(expected, given)`, and the port passed
   `(constraint_ty, resolved)` — putting the unbound SomeT `A` on the ACTUAL
   side, missing the concrete-vs-SomeT wildcard rule, and reporting
   "<struct> does not implement required trait Iterator". Fixed to
   `are_types_compatible(resolved, constraint_ty)`; the following
   `synthesize_types(constraint, resolved)` then binds `A := i32`.

Repro: `issues/repros/iterator-any-closure-void-param.yo`. Bisect fact worth
keeping: EVERY single arm of the batch was hollow while the same statements
passed as standalone `main`s/module exprs gave DIFFERENT errors — the plain
`main` recovered because a failed first validation attempt is retried at
specialization time, while the batch `__yo_user_main` validation pass has no
retry; that asymmetry is why the un-swallowed 6c throw hollowed batches only.

Gates: TIER 1 identical to baseline (battery, corpus 149/0, std 153/153),
TIER 2 full (stage2 hollow=0 + clang + stage3 + FIXPOINT_HOLDS), honest sweep
**165 GREEN / 16 HOLLOW / 4 RED** (was 164/16/5; no composition regressions).

### sync/mutex FIXED (2026-07-31) — 3/3 TRUE GREEN, markers=0

Root: yo-self's `FnTraitT` flattens the call signature into the variant and
had DROPPED the per-param `inout` flags TS keeps on `FnTraitType.callType`
(its `FunctionType.parameters[].isRef`). A closure typed against
`Impl(Fn(inout(v) : T) -> R)` (Mutex.with_lock's `body`) therefore bound `v`
BY VALUE: `v = i32(99)` threw "Cannot reassign" (swallowed; surfaced
downstream as `assert` "Expected bool / Given unit" because with_lock's
result soft-fell), the closure body FTT'd, and its return R lowered `void*`.

Landed as one port unit:

1. `FnTraitT.call_param_is_ref : ArrayList(bool)` — new LAST variant field
   (definitions.yo), threaded through t*fn_trait (creators.yo, new 8th arg),
   fn_trait.yo (collects `p.is_ref` from evaluate_function_parameters — the
   data was parsed all along and dropped), substitution.yo (carried), and
   intern.yo (appended to the key string). 28 positional pattern sites gained
   a trailing `*`.
2. Every FnTraitT→Func conversion now carries the flags into
   `FuncMeta.param_is_ref`: helper.yo norm_func_type,
   anonymous_function.yo `_func_from_fn_trait`, closure_type.yo's synthetic
   call type, codegen other_fn_call.yo.
3. Closure param BINDING stamps both `is_ref` AND `is_reassignable` from the
   flags — TS binds `isReassignable: parameter.isRef`
   (anonymous-function.ts:560, helper.ts:585); yo-self stamped only is_ref
   in the anon-fn path and nothing in closure_type.yo's loop.
4. The L4 closure type RE-registration (anonymous_function.yo, the
   concrete-body-type re-register) rebuilt with `t_func_simple`, whose
   default meta ERASED the flags for every later (specialization-time) body
   eval — now rebuilds from `corrected_func_type`'s meta.
5. function.yo inline-arm `fv_param_is_ref` read only a `.Func` callee type;
   a closure callee's type is the Fn TRAIT (or SomeT wrapping it) — added
   the extract_fn_trait_from_type fallback.

Diagnosis fact worth keeping: the visible unify error ("Expected bool /
Given unit" at the cond arm) was the ASSERT downstream of the real failure —
un-silencing `_trial_eval_fn_body`'s swallow (function_type.yo `inner_exn`,
the \_\_DBG_F recipe in the handoff §3) is what surfaced the actual "Cannot
reassign \"v\"" chain.

Gates: TIER 1 baseline-identical (corpus 149/0, std 153/153), TIER 2 full
(stage2 hollow=0 + clang + stage3 + FIXPOINT_HOLDS), honest sweep
**166 GREEN / 16 HOLLOW / 3 RED** (was 165/16/4; hollow set unchanged).

## SLICE 3c LANDED (2026-07-31) — dot-arg era adoption; imm_threading 17 -> 13 clang errors

The recorded caller-arg era pair attacked at the INLINE-arm arg loop
(function.yo): for a comptime-Type-param callee, an argument whose expr is
a leading-dot form — `.None` / `.Some(x)` variant shorthand AND `v.field`
reads (MEASURED: shorthand-only left 17 errors, including field reads
dropped to 13) — takes the RE-EVALUATED declared param TYPE EXPR
(g_func_param_type_exprs, evaluated in the caller env where the enclosing
spec binds K/V concrete) as its expected type. Params whose declared type
carries an Fn-trait wrapper are EXCLUDED (the slice-2 refinement); the
historical slice-3 regression witness closure_where_clause_param PASSES
with this mechanism (diff-test 1/1) — the difference vs the twice-rejected
slice 3 is (a) the inline-arm expected-type override instead of threading
through check_if_function_parameter_matches_argument, and (b) the dot-form
arg gate.

Effect: the `.None` arg casts converged to SAME-type struct casts
(`(__yo_t39)((__yo_t39){...})` — valid C, clang accepts same-type aggregate
casts; verified TS emits the identical text and compiles because its pairs
are same-type through newtype aliases). imm_threading clang errors 17 -> 13;
family files still RED.

REMAINING FACE (next round): `.Some(new_h)` constructions still emit the
DEF-ERA enum (t40/enum_yo_id_7695) even when the expected type is the
canonical era — the variant-construction eval re-mints from the ARG's type
instead of adopting the expected enum instance (suspect: new_h carries the
\_new_node spec's return era; note the spec NAME still shows MIXED eras
per-param — rtparam5_enum_yo_id_7695 vs rtparam6_enum_yo_id_10755 — and an
unresolved `ret_R_gs_yo_id_7598` return marker). Probe next: the
`.Variant(args)` eval's enum-resolution order (expected-enum adoption vs
arg-driven ctor synthesis) for era instances of one instantiation.

Gates: TIER 1 clean (corpus 149/0, std 153/153), TIER 2 FIXPOINT_HOLDS,
sweep 166/16/3 unchanged.

### try_to_call-side 3c mirror REJECTED (2026-07-31, measured — zero wins)

Mirroring the landed inline-arm dot-arg expected override into
check_if_function_parameter_matches_argument (a trailing expected_override
param, computed at try_to_call's supplied-arg site with the same dot-form +
Fn-exclusion + ct-Type-param gates) changed NOTHING: imm_threading stayed
13 errors, sweep 166/16/3 identical, TIER 1 clean. REVERTED per zero-wins.
Conclusion: the remaining `.Some(new_h)` face does NOT flow through either
arg path's expected type — consistent with the construction-eval re-mint
suspicion (the `.Variant(args)` arm stamps `func_type` = the CALLEE's
evaluated EnumT; for `.Some(new_h)` that callee resolves era-7695 even when
the surrounding expected is era-10755). NEXT PROBE (unchanged): the 1-arg
shorthand-callee eval in property_access for `.Some` under a canonical
expected — print the adopted vs emitted enum id; suspect the callee's
ExprInfo is stamped ONCE at def-time and reused at spec time (the same
no-retry-vs-retry asymmetry), or the expected reaching the CALLEE eval is
the DEF-ERA declared param type from a path that bypasses both landed
overrides.

### imm-family probe round (2026-07-31, cont.) — the era pair pinned to TWO LIVE Option memo entries at SPEC time

Probe data (imm_threading, **DBG_PA on the `.Some` shorthand-callee adoption
with mode flags + **DBG_EC on the construction stamp + \_\_DBG_CT on memo
hits):

- The def-era side (enum_yo_id_7695) NEVER appears as a ctor-memo RESULT
  (2980 memo events, zero 7695) — it is not a memo-bypass; it comes from a
  memo entry only visible to SOME lookups.
- BOTH eras reach `.Some(x)` args DURING SPECIALIZATION: 4 sites get
  expected era-7695 and 1 site era-10755, all with valid=y exec=n spec=y.
  Different CALLER SPECS resolve `Option(RBNode(K, V))` to DIFFERENT eras.
- Conclusion: two LIVE Option-memo entries whose RBNode ARGUMENTS fail
  `_ctfe_types_era_equal` — era-equality keys on constructor_func_id +
  recursively era-equal type_arguments; the prime suspect is a
  SUBSTITUTED/cloned RBNode instance with an EMPTY `constructor_func_id`
  (cfid-less instances cannot era-match anything). NEXT PROBE: at the
  `_ctfe_types_era_equal` struct arm, log the REJECTED pairs' cfids for
  struct names matching RBNode — an empty cfid on one side confirms it;
  the fix would be carrying `constructor_func_id` through
  substitution.yo's Struct arm (it currently reconstructs field types but
  may drop/keep the def instance's cfid — verify which).

Landed this round (commit 1bfb8f10c): inline-arm dot-form arg expected
override (imm_threading 17 -> 13 clang errors). Rejected this round
(measured, reverted): the try_to_call-side mirror (zero wins).

### cfid probe round 2 (2026-07-31) — the rejected pairs identified; inline-cfid preference measured-inert

\_\_DBG_EE on `_ctfe_types_era_equal`'s struct arm (log cfid-mismatch
rejections), imm_threading: among 7548 rejections (mostly legitimate —
different ctors), the RBNode-relevant ones are

    a=struct_yo_id_8531/yo_id_7598  b=struct_yo_id_10753/(EMPTY)
    a=struct_yo_id_8496/yo_id_7598  b=struct_yo_id_10753/(EMPTY)

— the CANONICAL RBNode(i32,i32) instance (10753) reached the comparison
with NO ctor fid: `lookup_struct_ctor_fid` missed AND (measured by the
inert fix below) the instance's own `constructor_func_id` field is empty
in that copy. The b-side copy is a memo-arg-stored instance that predates
the return-path cfid stamp (`register_struct_ctor_fid` fires only for
cfid-LESS results at comptime_fn.yo:~1073; the stamped instance is a NEW
TypeValue — earlier copies keep the empty field, exactly the "copies that
predate this one" caveat in that code's own comment).

ATTEMPTED + REVERTED (zero wins): era-equal preferring the instance's
inline `constructor_func_id` over the registry — no change (13/11/7 clang
errors across the family), confirming the offending copies carry NO cfid
either way.

NEXT ROUND direction: make the return-path stamp update the REGISTRY for
ALL results (drop the `scfid.len() == 0` gate on register_struct_ctor_fid
— registering sid→fid is idempotent and the registry is the lookup source
era-equal uses), so pre-stamp copies stored in memo args become
resolvable by id. One-line change; gate with the family + corpus.

### registry-stamp-always ALSO inert (2026-07-31, measured + reverted)

Dropping the `scfid == ""` gate on `register_struct_ctor_fid` at the ctor
return path changed nothing (13/11/7 clang errors unchanged) — so the
empty-cfid 10753 copies in the four splitting comparisons exist BEFORE the
RBNode ctor's return path runs at all: the comparisons fire DURING the
ctor's own evaluation (the in-progress temp-cache window), where neither
the inline stamp nor any registry write has happened yet. NEXT ROUND: log
a stack/mode marker at the four rejections to see WHOSE memo lookup runs
inside the RBNode ctor eval (suspect: the Option ctor call INSIDE
RBNode's field types — `left : Option(RBNode(K, V))` — evaluating the
self-referential field mints/compares Option entries while RBNode(i32,i32)
is still in progress; if so, the fix is resolving the recursion
placeholder in memo-arg comparisons via g_recursive_type_refs before
era-equality, or deferring the entry finalization).

### probe round 3 (2026-07-31) — reject noise separated; the intern-duplication lens

- The mass of \_\_DBG_LK rejects (4851 at depth=0 for fid=Option-ctor with
  given=canonical RBNode) is BENIGN bucket-scan noise: every lookup scans
  all cached entries and the probe fired per non-matching entry. The true
  signal remains the 4 cross-era comparisons where the STORED entry arg is
  an RBNode-canonical-id copy with EMPTY constructor_func_id (inline field
  AND registry both empty — two inert fixes proved it).
- intern.yo's Struct KEY INCLUDES cfid (line ~254): a pre-stamp copy
  (cfid="") and the return-path-stamped instance (cfid=fid) intern to TWO
  canonical instances with the SAME struct id. Same-sid pairs short-circuit
  TRUE in era-equal, so this only bites CROSS-id (def-era vs canonical)
  pairs where the stored copy is the cfid-less twin.
- registry-stamp-always was inert => the cfid-less 10753 copy is captured
  by a route that never passes the ctor RETURN path at all (suspect: the
  struct-decl eval INSIDE the ctor body mints the instance and something
  stores that pre-return instance into another memo entry's arg_values
  directly — e.g. the self-referential field `left : Option(RBNode(K, V))`
  evaluating Option(in-progress-RBNode) during the RBNode body eval, whose
  entry then holds the pre-stamp copy forever).

NEXT ROUND START: log at Option-ctor memo INSERT time (the temp-cache push
in evaluate_comptime_fn_call) the arg struct ids + their cfid state — find
the insert that stores the cfid-less canonical-id copy, and either stamp
cfid at struct-decl mint time (decl knows its enclosing ctor fid via
ctx.currently_specializing/ctfe stack) or normalize memo-arg storage
through the registry after the ctor returns.

### probe round 4 (2026-07-31) — memo-INSERT census

\_\_DBG_INS at the temp-cache push (Option ctor, imm_threading): 107 inserts;
65 store their RBNode arg with EMPTY cfid (INCLUDING the canonical
RBNode(i32,i32) id) and 42 with cfid. The def-era ids (8531 etc.) ALSO
insert cfid-less — but by REJECTION time the registry resolves THEM
(8531 -> yo_id_7598) while the canonical id stays unresolved. So the
return-path registration fires for the def-era mints but NOT for the
canonical instance's mint — the canonical RBNode(i32,i32) instance is
created by a route that never passes the ctor return-path stamp (and
therefore never registers): prime suspects, in order —

1. the memoized CACHE VALUE holds the pre-stamp body result (the stamp
   builds a NEW TypeValue for the CALLER but the cache entry's `value`
   keeps the unstamped one — check whether the return-path stamp also
   updates `temp_cache.value`);
2. a resolve_recursive_type_ref resolution returning the raw cached body
   result;
3. an ExprInfo-recorded instance from the body eval reused directly.
   (1) is a one-line check: in evaluate_comptime_fn_call, after building
   `final_return_value`, verify the completed cache entry is updated with the
   STAMPED value, not the raw body result. If it stores the raw result, every
   later cache HIT hands out the cfid-less twin — exactly the census.
