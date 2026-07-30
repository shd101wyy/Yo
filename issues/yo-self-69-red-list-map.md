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
