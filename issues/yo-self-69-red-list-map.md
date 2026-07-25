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

READ THE SHAPE CAREFULLY — it is NOT exponential fan-out. Every level reports
the SAME sample count (4115) and the indentation steps by 2 per frame, which is
a single LINEAR chain, not branching. (An earlier reading of this same sample
called it "combinatorial fan-out"; its own numbers contradict that.)

The depth is also the puzzle: the `_tts` frames span indentation 9 → 137, i.e.
60+ nested levels, yet `_tts` has a hard depth cap (`_d > 40 => "…"`,
string.yo:20) and ALL 23 of its recursive calls do pass `_d + usize(1)`
(verified). A chain deeper than the cap therefore means the cap is being RESET
by re-entry: `_tts` → `concat`/`to_string` → a FRESH `type_to_string` call
starting again at `_d = 0`. Confirm that before fixing.

Candidate fix, but note the caveat: TS's `typeToString`
(src/types/utils.ts:1210-1233) carries a path-scoped `visited: Set<string>` —
it returns `type.typeName || <circular:tag>` on a repeated type id, adding on
entry and DELETING on exit — while yo-self has only the depth cap. Porting that
guard is faithful. BUT it keys on type ids, and in `_tts` a NAMED Struct/EnumT
already returns its name without recursing, so the cycle cannot be running
through those; it must go through `SomeT` trait lists or an unnamed `TraitT`,
and `TraitT` carries no id to key on. So the guard as TS writes it may not
catch this particular cycle. Establish which variant actually recurses before
porting.

Blast-radius note for whoever does it: `type_to_string` feeds `type_key.yo`
(:213, :251, :327) and signature strings, so changing its output changes spec
identity. The guard is a NO-OP for acyclic types, which is what keeps that
risk contained — verify that property holds for any variant you implement.

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

Confidence: high for the sinks and the return/parameter mechanisms (each
emitter line was read and matches the observed C); medium for the field
position. NOT yet verified end-to-end — confirm by diffing the TS emit of
`impl_fn_field_rejection` for the same struct before changing anything.

### 4. await result type → void/unit — 2 files, byte-for-byte identical

`thread` and `worker`. Both, immediately after an await poll loop:

```c
void _file____User_temp_7090 = ;
void _file____User_temp_7091 = (() == ());
```

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
