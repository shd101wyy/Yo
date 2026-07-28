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
